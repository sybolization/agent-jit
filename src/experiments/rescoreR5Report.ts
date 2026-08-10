#!/usr/bin/env node

/**
 * R5 report 离线重判分（rescore）：
 * 用"修正后的 evaluator"（branchFlowSpec 数据流语义检查，不绑定 merge_by_key 的特定 IR shape）
 * 对旧 report 里每个 lastProgram.source 重新判分，重新 deriveR5Metrics / aggregateR5，
 * 输出 report.rescored.json。**不改写旧 report**——旧 report 是原始实验事实，新 report 是
 * same model runs + corrected evaluator（科研/工程记录分离）。
 *
 * 为什么需要：R5-B 的 mergeSpec 结构化检查（sourceCount=3）会把模型用 concat 重组的
 * 语义等价程序误判为 dslCorrect=false，导致 semanticCorrect=0%。rescore 用修正后的
 * checker 重判，不需要重新花模型调用即可得到真实结果。
 *
 * 运行：npx tsx src/experiments/rescoreR5Report.ts [report.json 路径]
 * 默认取 logs/experiments/ 下最新的 r5-offloading- 目录里的 report.json。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDsl } from "../compiler/compile.js";
import { checkTaskCorrectness } from "./taskSpec.js";
import { ToolRegistry } from "../tools/registry.js";
import type { RegisteredTool } from "../tools/definition.js";
import { R5_TASKS, type R5TaskId } from "./r5Tasks.js";
import {
  buildR5Aggregates,
  deriveR5Metrics,
  type R5Arm,
  type R5RunDerivationInput,
  type R5RunMetrics,
  type R5ToolCallRecord,
} from "./r5OffloadingBenchmark.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** 旧 report 中 run 的存储形态（JSON 反序列化；可选字段可能缺失）。 */
interface StoredRun {
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
  lastProgram?: R5RunMetrics["lastProgram"] & { dslCorrect?: boolean | null };
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

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    config: { arm: string; task: string; samples: number; rounds: number; candidates?: number };
    runs: StoredRun[];
  };
  const taskById = new Map(R5_TASKS.map((task) => [task.id, task]));

  console.log(`rescore：${reportPath}\n`);
  const rescoredRuns: R5RunMetrics[] = [];
  for (const run of report.runs) {
    const task = taskById.get(run.taskId);
    if (!task) {
      console.warn(`  [跳过] 未知 taskId ${run.taskId}（不在当前 R5_TASKS）`);
      continue;
    }

    // 1. 用修正后的 checker 重新判分（只有成功执行且保存了 source 的程序才可能判真）
    let jitSemanticCorrect: boolean | undefined = run.jitSemanticCorrect ?? undefined;
    let lastProgram = run.lastProgram;
    if (task.spec && lastProgram?.source) {
      try {
        const registry = new ToolRegistry<RegisteredTool>(task.tools);
        const { graph } = compileExecutionDsl(lastProgram.source, { tools: registry });
        const newCorrect = checkTaskCorrectness(graph, task.spec).pass;
        jitSemanticCorrect = newCorrect;
        const compressed = lastProgram.compressed;
        lastProgram = {
          source: lastProgram.source,
          dslCorrect: newCorrect,
          compressed,
          ...(newCorrect === true && compressed ? { correctlyCompressedOps: compressed.atomicOps } : {}),
        };
      } catch (error) {
        // source 来自成功执行，理论上不会编译失败；失败则保留旧判分并提示
        console.warn(`  [run ${run.arm}/${run.taskId}] 重新编译失败：${(error as Error).message.slice(0, 200)}`);
      }
    }

    // 2. 重建 derive 输入（存储的观测字段 + 新 jitSemanticCorrect + 当前任务的 spec/oracle/pipeline）
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
    rescoredRuns.push({ ...deriveR5Metrics(input), ...(lastProgram ? { lastProgram } : {}) });
  }

  const aggregates = buildR5Aggregates(rescoredRuns);
  const outPath = reportPath.replace(/\.json$/, ".rescored.json");
  fs.writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        ...report,
        aggregates,
        runs: rescoredRuns,
        rescore: {
          of: path.basename(reportPath),
          note: "same model runs + corrected evaluator（branchFlowSpec 数据流语义检查，不绑定 merge_by_key IR shape）",
        },
      },
      null,
      2,
    )}\n`,
  );

  // 3. 输出对比摘要
  console.log("===== 逐 run：旧 dslCorrect → 新 dslCorrect =====");
  for (let i = 0; i < report.runs.length; i += 1) {
    const oldRun = report.runs[i]!;
    const newRun = rescoredRuns[i]!;
    const oldCorrect = oldRun.lastProgram?.dslCorrect ?? undefined;
    const newCorrect = newRun.lastProgram?.dslCorrect ?? undefined;
    console.log(
      `  run${String(i + 1).padStart(2)}: ${oldRun.arm}/${oldRun.taskId} ` +
        `dslCorrect ${oldCorrect === undefined ? "n/a" : oldCorrect} → ${newCorrect === undefined ? "n/a" : newCorrect} ` +
        `semanticCorrect ${oldRun.jitSemanticCorrect ?? "n/a"} → ${newRun.jitSemanticCorrect ?? "n/a"} ` +
        `taskCompleted ${oldRun.taskCompleted} → ${newRun.taskCompleted}`,
    );
  }
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
