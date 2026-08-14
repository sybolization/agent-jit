#!/usr/bin/env node

/**
 * R6.2 — Output Contract Necessity 四格实验（2×2）。
 *
 * 实验问题：R6.1 证明 compile-only / manifest 三臂 eventual compile 都能到 100%，但
 * transparent 输出字段（full_name / forks / stars / score）本身太容易被模型猜出来。
 * 用 2×2 把「contract 提供」与「字段可猜性」两个解释分开：
 *   contract arm（compile-only / compact-manifest）× tool-schema（transparent / opaque）
 *
 * 四格（都是 treatment，协议完全统一：reasoning OFF + boundaryPolicy ON + stopAfterSubmit ON
 * + primitive DSL + Task B，差异只在 contractMode 与工具 output 命名）：
 * - B-T = compile-only × transparent
 * - C-T = manifest × transparent
 * - B-O = compile-only × opaque
 * - C-O = manifest × opaque
 *
 * 运行：npx tsx src/experiments/r6OutputContractBenchmark.ts [--cell=B-T|C-T|B-O|C-O|all] [--samples=1] [--rounds=10]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime } from "../llm/gateway.js";
import { createR5BOpaqueTask, R5_TASKS, type R5Task } from "./r5Tasks.js";
import {
  aggregateR5,
  buildR5JitGroups,
  runR5Run,
  type R5Aggregate,
  type R5JitGroup,
  type R5RunMetrics,
  type R6ContractMode,
} from "./r5OffloadingBenchmark.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export type R6OutputContractCellId = "B-T" | "C-T" | "B-O" | "C-O";

interface CellDef {
  contractMode: R6ContractMode;
  naming: "transparent" | "opaque";
  label: string;
}

export const R6_OUTPUT_CONTRACT_CELLS: Record<R6OutputContractCellId, CellDef> = {
  "B-T": { contractMode: "compile-only", naming: "transparent", label: "B-T: compile-only × transparent" },
  "C-T": { contractMode: "manifest", naming: "transparent", label: "C-T: manifest × transparent" },
  "B-O": { contractMode: "compile-only", naming: "opaque", label: "B-O: compile-only × opaque" },
  "C-O": { contractMode: "manifest", naming: "opaque", label: "C-O: manifest × opaque" },
};

/** 从 .env 加载环境变量（只补未设置项；与 r5OffloadingBenchmark 的 loadEnv 同语义）。 */
function loadEnv(root: string): void {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

export interface R6OutputContractFlags {
  cell: R6OutputContractCellId | "all";
  samples: number;
  rounds: number;
  /** reasoning：模型思考开关（--reasoning 开启；缺省 false，显式冻结） */
  reasoning: boolean;
}

export function parseR6OutputContractFlags(argv: readonly string[]): R6OutputContractFlags {
  const flags: R6OutputContractFlags = { cell: "all", samples: 1, rounds: 10, reasoning: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "cell") {
      if (value === "B-T" || value === "C-T" || value === "B-O" || value === "C-O" || value === "all") {
        flags.cell = value;
      } else {
        throw new Error(`--cell 必须是 B-T|C-T|B-O|C-O|all（当前：${value}）`);
      }
    }
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
    if (key === "reasoning" && value === undefined) flags.reasoning = true;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// 报告：四格 cell 构建与落盘
// ---------------------------------------------------------------------------

export interface R6OutputContractCell {
  label: string;
  contractMode: R6ContractMode;
  naming: "transparent" | "opaque";
  runs: readonly R5RunMetrics[];
  aggregate: R5Aggregate;
  jitGroups: readonly R5JitGroup[];
  manifestChars?: number;
  manifestEstimatedTokens?: number;
  totalTokensIncludingManifest?: number;
}

export interface R6OutputContractConfig {
  cell: R6OutputContractCellId | "all";
  samples: number;
  rounds: number;
  boundaryPolicy?: boolean;
  stopAfterSubmit?: boolean;
  /** reasoning 开关（显式冻结，--reasoning 开启）。 */
  reasoningEnabled?: boolean;
}

export function buildR6OutputContractCells(
  runs: readonly R5RunMetrics[],
  config: R6OutputContractConfig,
): Record<R6OutputContractCellId, R6OutputContractCell> {
  const makeCell = (id: R6OutputContractCellId, def: CellDef): R6OutputContractCell => {
    const cellRuns = runs.filter(
      (run) => run.arm === "treatment" && run.taskId === "B" && run.contractMode === def.contractMode && run.toolNaming === def.naming,
    );
    const aggregate = aggregateR5(cellRuns, "treatment", "B");
    const manifestChars = cellRuns.find((run) => run.manifestChars !== undefined)?.manifestChars;
    const manifestEstimatedTokens = cellRuns.find((run) => run.manifestEstimatedTokens !== undefined)?.manifestEstimatedTokens;
    return {
      label: def.label,
      contractMode: def.contractMode,
      naming: def.naming,
      runs: cellRuns,
      aggregate,
      jitGroups: buildR5JitGroups(cellRuns, "treatment", "B"),
      ...(manifestChars !== undefined ? { manifestChars } : {}),
      ...(manifestEstimatedTokens !== undefined ? { manifestEstimatedTokens } : {}),
      ...(manifestEstimatedTokens !== undefined
        ? { totalTokensIncludingManifest: aggregate.avgTokens + manifestEstimatedTokens }
        : {}),
    };
  };
  return {
    "B-T": makeCell("B-T", R6_OUTPUT_CONTRACT_CELLS["B-T"]),
    "C-T": makeCell("C-T", R6_OUTPUT_CONTRACT_CELLS["C-T"]),
    "B-O": makeCell("B-O", R6_OUTPUT_CONTRACT_CELLS["B-O"]),
    "C-O": makeCell("C-O", R6_OUTPUT_CONTRACT_CELLS["C-O"]),
  };
}

export function writeR6OutputContractReport(
  outDir: string,
  config: R6OutputContractConfig,
  tasks: readonly R5Task[],
  cells: Record<R6OutputContractCellId, R6OutputContractCell>,
  runs: readonly R5RunMetrics[],
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r6-output-contract",
        config,
        model: "deepseek-v4-flash",
        timestamp: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          prompt: task.prompt,
          oracle: task.oracle.map(String),
        })),
        cells: Object.fromEntries(
          (Object.keys(cells) as R6OutputContractCellId[]).map((id) => [
            id,
            {
              label: cells[id].label,
              contractMode: cells[id].contractMode,
              naming: cells[id].naming,
              aggregate: cells[id].aggregate,
              jitGroups: cells[id].jitGroups,
              ...(cells[id].manifestChars !== undefined ? { manifestChars: cells[id].manifestChars } : {}),
              ...(cells[id].manifestEstimatedTokens !== undefined
                ? { manifestEstimatedTokens: cells[id].manifestEstimatedTokens }
                : {}),
              ...(cells[id].totalTokensIncludingManifest !== undefined
                ? { totalTokensIncludingManifest: cells[id].totalTokensIncludingManifest }
                : {}),
            },
          ]),
        ),
        runs,
      },
      null,
      2,
    )}\n`,
  );
  return reportPath;
}

// ---------------------------------------------------------------------------
// CLI 对比打印 + 判断矩阵
// ---------------------------------------------------------------------------

export function printR6OutputContractComparison(cells: Record<R6OutputContractCellId, R6OutputContractCell>): void {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const ids: R6OutputContractCellId[] = ["B-T", "C-T", "B-O", "C-O"];
  for (const id of ids) {
    const cell = cells[id];
    const agg = cell.aggregate;
    const jitDist = cell.jitGroups.map((group) => `${group.group}=${group.runs}`).join(" ");
    console.log(`  [${id}] ${cell.label}`);
    console.log(
      `runs=${agg.runs} firstPass=${pct(agg.firstPassCompileRateOverall)} eventualCompile=${pct(agg.eventualCompileRate)} ` +
        `eventualSemantic=${pct(agg.eventualSemanticCorrectRate)} taskCompleted=${pct(agg.taskCompletionRate)} ` +
        `firstPassSemantic=${pct(agg.firstPassSemanticSuccessRate)}`,
    );
    console.log(
      `avgRepairRounds=${agg.avgRepairRounds.toFixed(1)} avgCompileAttempts=${agg.avgCompileAttempts.toFixed(1)} ` +
        `outputContractErr=${pct(agg.outputContractErrorRate)} syntaxCompletenessErr=${pct(agg.syntaxCompletenessErrorRate)} ` +
        `clean=${pct(agg.cleanOffloadRate)} preExecutePipeline=${agg.avgPreExecutePipelineCalls?.toFixed(1) ?? "n/a"}`,
    );
    console.log(
      `avgTokens=${Math.round(agg.avgTokens)} avgRounds=${agg.avgRounds.toFixed(1)} avgLatencyMs=${Math.round(agg.avgLatencyMs)}` +
        (cell.manifestEstimatedTokens !== undefined
          ? ` manifestChars=${cell.manifestChars} manifestTokens=${cell.manifestEstimatedTokens} totalInclManifest=${Math.round(cell.totalTokensIncludingManifest ?? 0)}`
          : ""),
    );
    console.log(`    jitGroups: ${jitDist}`);
  }
  console.log(`\n结论：${judgeOutputContractConclusion(cells)}`);
}

/** 按 r6goal 第十四节判断矩阵输出结论（情况 A/B/C/D）。 */
export function judgeOutputContractConclusion(cells: Record<R6OutputContractCellId, R6OutputContractCell>): string {
  const agg = (id: R6OutputContractCellId): R5Aggregate => cells[id].aggregate;
  const BT = agg("B-T");
  const CT = agg("C-T");
  const BO = agg("B-O");
  const CO = agg("C-O");

  const near = (a: number, b: number, eps = 0.15): boolean => Math.abs(a - b) <= eps;
  const drop = (a: number, b: number, eps = 0.15): boolean => a < b - eps;

  const transparentClose = near(BT.firstPassCompileRateOverall, CT.firstPassCompileRateOverall);
  const opaqueClose = near(BO.firstPassCompileRateOverall, CO.firstPassCompileRateOverall);
  const bDrops = drop(BO.firstPassCompileRateOverall, BT.firstPassCompileRateOverall);
  const cStable = !drop(CO.firstPassCompileRateOverall, CT.firstPassCompileRateOverall);
  const bothDrop =
    drop(BO.firstPassCompileRateOverall, BT.firstPassCompileRateOverall) &&
    drop(CO.firstPassCompileRateOverall, CT.firstPassCompileRateOverall);

  if (transparentClose && bDrops && cStable) {
    return "情况 A：transparent B≈C，opaque B 明显下降、C 保持稳定 → compact output contract 有真实必要性。";
  }
  if (transparentClose && opaqueClose) {
    return "情况 B：transparent B≈C，opaque B≈C → compact manifest 也不值得常驻（完全 lazy contract discovery）。";
  }
  const cRepairAdvantage = BO.avgRepairRounds > CO.avgRepairRounds + 0.5 || BO.avgTokens > CO.avgTokens * 1.2;
  if (BO.eventualSemanticCorrectRate >= 0.9 && cRepairAdvantage) {
    return "情况 C：opaque B eventual 仍高、但 repair/token 明显高于 C → manifest 的价值主要在减少 repair rounds 与 token。";
  }
  if (bothDrop) {
    return "情况 D：B-O 与 C-O 都明显下降 → 问题不止 output contract，需重查 DSL expressiveness / tool description / 语义歧义 / 任务规格。";
  }
  return "未命中 A/B/C/D 任一情况，需人工阅读四格指标判断。";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function logRun(run: R5RunMetrics): void {
  console.log(
    `→ rounds=${run.rounds} maxedOut=${run.maxedOut} tokens=${run.tokens.total} latency=${run.latencyMs}ms ` +
      `answer=${run.answerCorrect ? "✓" : "✗"} completed=${run.taskCompleted ? "✓" : "✗"}`,
  );
  console.log(
    `  execute=${run.executeCalls} compile=${run.firstPassCompileSuccess === undefined ? "n/a" : run.firstPassCompileSuccess} ` +
      `firstPassSemantic=${run.firstPassSemanticSuccess === undefined ? "n/a" : run.firstPassSemanticSuccess} ` +
      `semantic=${run.jitSemanticCorrect === undefined ? "n/a" : run.jitSemanticCorrect} repairRounds=${run.repairRounds === undefined ? "n/a" : run.repairRounds}`,
  );
  if (run.submittedAnswer !== undefined) console.log(`  submit_answer：${run.submittedAnswer.slice(0, 300)}`);
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { cell, samples, rounds, reasoning } = parseR6OutputContractFlags(process.argv.slice(2));
  const cellIds: R6OutputContractCellId[] = cell === "all" ? ["B-T", "C-T", "B-O", "C-O"] : [cell];
  const transparentTask = R5_TASKS.find((item) => item.id === "B")!;
  const opaqueTask = createR5BOpaqueTask();
  // reasoning 显式冻结：只认 CLI 标志，不依赖 gateway 默认值
  const runtime = createDeepSeekPiRuntime({ reasoning });

  const runs: R5RunMetrics[] = [];
  const usedTasks = new Map<string, R5Task>();
  for (const id of cellIds) {
    const def = R6_OUTPUT_CONTRACT_CELLS[id];
    const task = def.naming === "opaque" ? opaqueTask : transparentTask;
    usedTasks.set(task.name, task);
    for (let i = 1; i <= samples; i += 1) {
      console.log(`\n===== [${def.label}] sample ${i}/${samples} =====`);
      const run = await runR5Run(task, "treatment", runtime, rounds, {
        boundaryPolicy: true,
        stopAfterSubmit: true,
        contractMode: def.contractMode,
        toolNaming: def.naming,
      });
      runs.push(run);
      logRun(run);
    }
  }

  console.log("\n\n===== R6.2 Output Contract 四格对比 =====");
  const cells = buildR6OutputContractCells(runs, { cell, samples, rounds, boundaryPolicy: true, stopAfterSubmit: true });
  printR6OutputContractComparison(cells);

  const outDir = path.join(
    REPO_ROOT,
    "logs",
    "experiments",
    `r6-output-contract-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const reportPath = writeR6OutputContractReport(
    outDir,
    { cell, samples, rounds, boundaryPolicy: true, stopAfterSubmit: true, reasoningEnabled: reasoning },
    [...usedTasks.values()],
    cells,
    runs,
  );
  console.log(`\n报告已写入: ${reportPath}`);
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
