#!/usr/bin/env node

/**
 * R5 / R6 report 离线重判分（rescore）：
 * 用"修正后的 evaluator"（执行级语义检查 checkTaskSemantics，拓扑无关）对旧 report 里每个
 * lastProgram.source 重新判分，重新 deriveR5Metrics / 聚合，输出 report.rescored.json。
 * **不改写旧 report**——旧 report 是原始实验事实，新 report 是 same model runs + corrected
 * evaluator（科研/工程记录分离）。
 *
 * 为什么需要：R5-B 的 mergeSpec 结构化检查（sourceCount=3）会把模型用 concat 重组的
 * 语义等价程序误判为 dslCorrect=false；且编译器新增 missing_return 硬错误后，旧 report 里
 * 无 return 的不完整程序会重新编译失败。rescore 用执行级 checker 重判，编译失败一律
 * jitSemanticCorrect=false（compileFailed 记录原因），不需要重新花模型调用即可得到真实结果。
 *
 * 两种 report mode：
 * - r5-autonomous-offloading：走 arm×task 聚合（输出 shape 保持 aggregates + runs + rescore）；
 * - r6-contract-discovery：按 contractMode 重建四格 cell（control/A/B/C），
 *   输出 cells（label / contractMode / aggregate / jitGroups）+ runs + rescore。
 * 其它 mode → 报错退出。
 *
 * 运行：npx tsx src/experiments/rescoreR5Report.ts [report.json 路径]
 * 默认取 logs/experiments/ 下最新的 r5-offloading- 目录里的 report.json；r6 报告请显式传路径。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDsl } from "../compiler/compile.js";
import { checkTaskSemantics } from "./taskSpec.js";
import { ToolRegistry } from "../tools/registry.js";
import type { RegisteredTool } from "../tools/definition.js";
import { R5_TASKS, type R5Task, type R5TaskId } from "./r5Tasks.js";
import {
  buildR5Aggregates,
  deriveR5Metrics,
  type R5Arm,
  type R5RunDerivationInput,
  type R5RunMetrics,
  type R5ToolCallRecord,
  type R6ContractMode,
} from "./r5OffloadingBenchmark.js";
import { buildR6Cells, type R6CellId, type R6ReportConfig } from "./r6DescribeBenchmark.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** 新旧两份 rescore 共用的 note（执行级语义 + missing_return 说明）。 */
const RESCORE_NOTE =
  "same model runs + corrected evaluator（执行级语义检查 checkTaskSemantics；missing_return 不完整程序判 false）";

/** 旧 report 中 run 的存储形态（JSON 反序列化；可选字段可能缺失）。 */
export interface StoredRun {
  arm: R5Arm;
  taskId: R5TaskId;
  rounds: number;
  maxedOut: boolean;
  tokens: R5RunMetrics["tokens"];
  latencyMs: number;
  toolTimeline: Array<{ name: string; isError: boolean; round?: number; arguments?: Record<string, unknown> }>;
  businessCalls?: string[];
  describeCalls: number;
  executeCalls: number;
  jitSemanticCorrect?: boolean | null;
  executeErrors?: string[];
  submittedAnswer?: string;
  finalText: string;
  error?: string;
  taskCompleted?: boolean;
  /** R6.1：contract acquisition 模式（r6 report 的 treatment run 有此字段；buildR6Cells 分臂的事实源） */
  contractMode?: R6ContractMode;
  lastProgram?: R5RunMetrics["lastProgram"] & { dslCorrect?: boolean | null };
}

/** 落盘 report 的顶层形态（mode 可选兼容旧报告；config 只读重判所需字段）。 */
interface StoredReport {
  mode?: string;
  config: {
    arm?: string;
    task?: string;
    samples?: number;
    rounds?: number;
    stopAfterSubmit?: boolean;
    boundaryPolicy?: boolean;
  };
  runs: StoredRun[];
}

function normalizeTimeline(
  records: StoredRun["toolTimeline"],
): R5ToolCallRecord[] {
  return records.map((record) => ({
    name: record.name,
    isError: record.isError,
    round: record.round ?? 1,
    arguments: record.arguments ?? {},
  }));
}

/**
 * 单 run 离线重判：用修正后的 evaluator（执行级语义检查 checkTaskSemantics）对
 * lastProgram.source 重新判分，其余观测字段走 deriveR5Metrics 重建。
 * - 无 spec 或无 source → 保持旧 jitSemanticCorrect（旧判分原样保留）；
 * - 重新编译失败（missing_return 等硬错误）→ jitSemanticCorrect=false、
 *   lastProgram.dslCorrect=false，compileFailed 记录截断原因（不再保留旧判分）；
 * - 编译成功 → checkTaskSemantics 判定：pass → jitSemanticCorrect=true，
 *   compressed 保留且 pass && compressed 时 correctlyCompressedOps=compressed.atomicOps；
 *   fail → jitSemanticCorrect=false、lastProgram.dslCorrect=false。
 * contractMode（R6 四格分臂的事实源）从存储原样透传。
 */
export async function rescoreRun(
  run: StoredRun,
  task: R5Task,
): Promise<{ metrics: R5RunMetrics; compileFailed?: string }> {
  let jitSemanticCorrect: boolean | undefined = run.jitSemanticCorrect ?? undefined;
  let lastProgram = run.lastProgram;
  let compileFailed: string | undefined;
  if (task.spec && lastProgram?.source) {
    try {
      const registry = new ToolRegistry<RegisteredTool>(task.tools);
      const { graph } = compileExecutionDsl(lastProgram.source, { tools: registry });
      const pass = (await checkTaskSemantics(graph, task)).pass;
      jitSemanticCorrect = pass;
      const compressed = lastProgram.compressed;
      lastProgram = {
        source: lastProgram.source,
        dslCorrect: pass,
        compressed,
        ...(pass === true && compressed ? { correctlyCompressedOps: compressed.atomicOps } : {}),
      };
    } catch (error) {
      // 编译器硬错误（missing_return 等）：不完整程序判语义错误，不再保留旧判分
      jitSemanticCorrect = false;
      const compressed = lastProgram.compressed;
      lastProgram = {
        source: lastProgram.source,
        dslCorrect: false,
        ...(compressed ? { compressed } : {}),
      };
      compileFailed = (error as Error).message.slice(0, 200);
    }
  }

  // 重建 derive 输入（存储的观测字段 + 新 jitSemanticCorrect + 当前任务的 spec/oracle/pipeline）
  const input: R5RunDerivationInput = {
    arm: run.arm,
    taskId: run.taskId,
    rounds: run.rounds,
    maxedOut: run.maxedOut,
    tokens: run.tokens,
    latencyMs: run.latencyMs,
    toolTimeline: normalizeTimeline(run.toolTimeline),
    businessCalls: run.businessCalls ?? [],
    describeCalls: run.describeCalls,
    executeCalls: run.executeCalls,
    jitSemanticCorrect,
    executeErrors: run.executeErrors ?? [],
    pipelineToolIds: task.pipelineToolIds,
    submittedAnswer: run.submittedAnswer,
    finalText: run.finalText,
    oracle: task.oracle,
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
  return {
    metrics: {
      ...deriveR5Metrics(input),
      // contractMode 是 R6 四格分臂的事实源（deriveR5Metrics 不产出），从存储原样透传
      ...(run.contractMode !== undefined ? { contractMode: run.contractMode } : {}),
      ...(lastProgram ? { lastProgram } : {}),
    },
    ...(compileFailed !== undefined ? { compileFailed } : {}),
  };
}

function findLatestR5Report(): string | undefined {
  const experimentsDir = path.join(REPO_ROOT, "logs", "experiments");
  if (!fs.existsSync(experimentsDir)) return undefined;
  const candidates = fs
    .readdirSync(experimentsDir)
    .filter((name) => name.startsWith("r5-offloading-"))
    .map((name) => path.join(experimentsDir, name, "report.json"))
    .filter((reportPath) => fs.existsSync(reportPath));
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

async function main(): Promise<number> {
  const reportArg = process.argv[2];
  const reportPath = reportArg ? path.resolve(reportArg) : findLatestR5Report();
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`[FAIL] 找不到 report.json：${reportPath ?? "(未提供且无默认)"}`);
    return 1;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as StoredReport;
  const mode = report.mode ?? "r5-autonomous-offloading";
  if (mode !== "r5-autonomous-offloading" && mode !== "r6-contract-discovery") {
    console.error(`[FAIL] 不支持的 report mode：${mode}（仅支持 r5-autonomous-offloading / r6-contract-discovery）`);
    return 1;
  }

  const taskById = new Map(R5_TASKS.map((task) => [task.id, task]));
  console.log(`rescore：${reportPath}（mode=${mode}）\n`);

  const processed: { oldRun: StoredRun; newRun: R5RunMetrics; compileFailed?: string }[] = [];
  for (const run of report.runs) {
    const task = taskById.get(run.taskId);
    if (!task) {
      console.warn(`  [跳过] 未知 taskId ${run.taskId}（不在当前 R5_TASKS）`);
      continue;
    }
    const { metrics, compileFailed } = await rescoreRun(run, task);
    processed.push({ oldRun: run, newRun: metrics, ...(compileFailed !== undefined ? { compileFailed } : {}) });
  }
  const rescoredRuns = processed.map((item) => item.newRun);
  const compileFailures = processed.flatMap((item) =>
    item.compileFailed !== undefined
      ? [{ arm: item.oldRun.arm, taskId: item.oldRun.taskId, round: item.oldRun.rounds, message: item.compileFailed }]
      : [],
  );

  const outPath = reportPath.replace(/\.json$/, ".rescored.json");
  if (mode === "r6-contract-discovery") {
    // 用 report.config 重建 R6ReportConfig（缺省值对齐 r6DescribeBenchmark 的默认实验协议）
    const r6Config: R6ReportConfig = {
      arm: (report.config.arm ?? "all") as R6ReportConfig["arm"],
      task: (report.config.task ?? "all") as R6ReportConfig["task"],
      samples: report.config.samples ?? 1,
      rounds: report.config.rounds ?? 10,
      stopAfterSubmit: report.config.stopAfterSubmit ?? false,
      ...(report.config.boundaryPolicy !== undefined ? { boundaryPolicy: report.config.boundaryPolicy } : {}),
    };
    const cells = buildR6Cells(rescoredRuns, r6Config);
    const cellsOut = Object.fromEntries(
      (Object.keys(cells) as R6CellId[]).map((id) => [
        id,
        {
          label: cells[id].label,
          contractMode: cells[id].contractMode,
          aggregate: cells[id].aggregate,
          jitGroups: cells[id].jitGroups,
        },
      ]),
    );
    fs.writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          ...report,
          cells: cellsOut,
          runs: rescoredRuns,
          rescore: {
            of: path.basename(reportPath),
            mode: "r6-contract-discovery",
            note: RESCORE_NOTE,
            compileFailures,
          },
        },
        null,
        2,
      )}\n`,
    );

    // 摘要：逐 run 旧 semantic → 新 semantic（含 compileFailed 标注）
    console.log("===== 逐 run：旧 semantic → 新 semantic =====");
    for (const { oldRun, newRun, compileFailed } of processed) {
      const armLabel = newRun.contractMode !== undefined ? `${oldRun.arm}/${newRun.contractMode}` : oldRun.arm;
      console.log(
        `  ${armLabel}/${oldRun.taskId} semantic ${oldRun.jitSemanticCorrect ?? "n/a"} → ${newRun.jitSemanticCorrect ?? "n/a"}` +
          (compileFailed !== undefined ? ` [compileFailed: ${compileFailed}]` : ""),
      );
    }
    // 摘要：按 cell（control/A/B/C）的四格对比
    console.log("\n===== 四格 cell（rescore 后）=====");
    for (const id of ["control", "A", "B", "C"] as R6CellId[]) {
      const agg = cells[id].aggregate;
      console.log(
        `  [${id}] runs=${agg.runs} eventualSemanticCorrect=${(agg.eventualSemanticCorrectRate * 100).toFixed(0)}% ` +
          `firstPassCompileOverall=${(agg.firstPassCompileRateOverall * 100).toFixed(0)}% ` +
          `avgTokens=${Math.round(agg.avgTokens)} avgRounds=${agg.avgRounds.toFixed(1)}`,
      );
    }
  } else {
    const aggregates = buildR5Aggregates(rescoredRuns);
    fs.writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          ...report,
          aggregates,
          runs: rescoredRuns,
          rescore: {
            of: path.basename(reportPath),
            note: RESCORE_NOTE,
            compileFailures,
          },
        },
        null,
        2,
      )}\n`,
    );

    // 摘要：逐 run 旧 dslCorrect → 新 dslCorrect
    console.log("===== 逐 run：旧 dslCorrect → 新 dslCorrect =====");
    for (const { oldRun, newRun, compileFailed } of processed) {
      const oldCorrect = oldRun.lastProgram?.dslCorrect ?? undefined;
      const newCorrect = newRun.lastProgram?.dslCorrect ?? undefined;
      console.log(
        `  run: ${oldRun.arm}/${oldRun.taskId} ` +
          `dslCorrect ${oldCorrect === undefined ? "n/a" : oldCorrect} → ${newCorrect === undefined ? "n/a" : newCorrect} ` +
          `semanticCorrect ${oldRun.jitSemanticCorrect ?? "n/a"} → ${newRun.jitSemanticCorrect ?? "n/a"} ` +
          `taskCompleted ${oldRun.taskCompleted} → ${newRun.taskCompleted}` +
          (compileFailed !== undefined ? ` [compileFailed: ${compileFailed}]` : ""),
      );
    }
    // 摘要：arm × task 分格
    console.log("\n===== arm × task 分格（rescore 后）=====");
    for (const arm of ["control", "treatment"] as const) {
      for (const taskId of ["A", "B", "C"] as const) {
        const agg = aggregates[arm][taskId];
        if (agg.runs === 0) continue;
        console.log(
          `  [${arm}/${taskId}] runs=${agg.runs} adoption=${(agg.adoptionRate * 100).toFixed(0)}% ` +
            `semanticCorrect=${(agg.jitSemanticCorrectRate * 100).toFixed(0)}% ` +
            `offloadPrecision=${(agg.offloadPrecision * 100).toFixed(0)}% ` +
            `taskCompleted=${(agg.taskCompletionRate * 100).toFixed(0)}% ` +
            `tokens=${Math.round(agg.avgTokens)}`,
        );
      }
    }
  }

  console.log(
    `\n[compileFailures] 共 ${compileFailures.length} 个 run 重新编译失败（missing_return 等硬错误 → jitSemanticCorrect=false）`,
  );
  for (const failure of compileFailures) {
    console.log(`  - ${failure.arm}/${failure.taskId}（round=${failure.round}）：${failure.message}`);
  }
  console.log(`\n已写入: ${outPath}`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[FAIL]", (error as Error).message);
      process.exit(1);
    });
}
