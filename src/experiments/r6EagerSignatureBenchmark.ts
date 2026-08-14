#!/usr/bin/env node

/**
 * R6.3 — Eager DSL Signatures 对照实验（2×2：Task × contract delivery）。
 *
 * 实验问题：去掉 describe round、用 eager-loaded 函数式 DSL 签名直接 execute，
 * 质量是否保持、成本是否下降；以及把 DSL 签名常驻到每个 active tool 上，对
 * 不使用 JIT 的 A 型任务带来多少 token 税。
 *
 * 2×2 格（都是 treatment、boundaryPolicy ON、stopAfterSubmit ON、同 reasoning/model/tools/DSL，
 * 唯一变量是 task 与 contract delivery）：
 * - A-eager：Task A（不 JIT）× 无签名（普通 Agent baseline）；
 * - A-sig：  Task A × eager signature（测常驻 signature tax）；
 * - B-eager：Task B（明显值得 JIT）× describe（当前 JIT baseline）；
 * - B-sig：  Task B × eager signature（测省掉 describe round 的收益）。
 *
 * Primary：
 * - A signature tax = A-sig.avgTokens - A-eager.avgTokens；
 * - B token savings = B-eager.avgTokens - B-sig.avgTokens；
 * - B rounds / correctness / cleanOffload。
 *
 * 运行：npx tsx src/experiments/r6EagerSignatureBenchmark.ts [--cell=A-eager|A-sig|B-eager|B-sig|all] [--samples=1] [--rounds=10]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime } from "../llm/gateway.js";
import { R5_TASKS, type R5Task, type R5TaskId } from "./r5Tasks.js";
import {
  aggregateR5,
  buildR5JitGroups,
  runR5Run,
  type R5Aggregate,
  type R5JitGroup,
  type R5RunMetrics,
  type R6ContractMode,
} from "./r5OffloadingBenchmark.js";
import { HISTORICAL_R5_CONTRACT_MODE } from "./shared/types.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export type R6EagerCellId = "A-eager" | "A-sig" | "B-eager" | "B-sig";

interface CellDef {
  taskId: R5TaskId;
  contractMode: R6ContractMode;
  label: string;
}

export const R6_EAGER_CELLS: Record<R6EagerCellId, CellDef> = {
  "A-eager": { taskId: "A", contractMode: HISTORICAL_R5_CONTRACT_MODE, label: "A no-signature（普通 Agent baseline）" },
  "A-sig": { taskId: "A", contractMode: "eager-signatures", label: "A eager-signature（常驻 signature tax）" },
  "B-eager": { taskId: "B", contractMode: HISTORICAL_R5_CONTRACT_MODE, label: "B describe（当前 JIT baseline）" },
  "B-sig": { taskId: "B", contractMode: "eager-signatures", label: "B eager-signature（省 describe round）" },
};

/** 从 .env 加载环境变量（只补未设置项；与 r6DescribeBenchmark 的 loadEnv 同语义）。 */
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

export interface R6EagerFlags {
  cell: R6EagerCellId | "all";
  samples: number;
  rounds: number;
  /** reasoning：模型思考开关（--reasoning 开启；缺省 false，显式冻结） */
  reasoning: boolean;
}

export function parseR6EagerFlags(argv: readonly string[]): R6EagerFlags {
  const flags: R6EagerFlags = { cell: "all", samples: 1, rounds: 10, reasoning: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "cell") {
      if (value === "A-eager" || value === "A-sig" || value === "B-eager" || value === "B-sig" || value === "all") {
        flags.cell = value;
      } else {
        throw new Error(`--cell 必须是 A-eager|A-sig|B-eager|B-sig|all（当前：${value}）`);
      }
    }
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
    if (key === "reasoning" && value === undefined) flags.reasoning = true;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// 报告：2×2 cell 构建与落盘
// ---------------------------------------------------------------------------

export interface R6EagerConfig {
  cell: R6EagerCellId | "all";
  samples: number;
  rounds: number;
  /** 统一协议固定 Boundary Policy ON（可选：仅报告元数据）。 */
  boundaryPolicy?: boolean;
  /** 统一协议固定 stop-after-submit ON（可选：仅报告元数据）。 */
  stopAfterSubmit?: boolean;
  /** reasoning 开关（显式冻结，--reasoning 开启）。 */
  reasoningEnabled?: boolean;
}

export interface R6EagerCell {
  label: string;
  taskId: R5TaskId;
  contractMode: R6ContractMode;
  runs: readonly R5RunMetrics[];
  aggregate: R5Aggregate;
  jitGroups: readonly R5JitGroup[];
}

/**
 * 从全部 runs 构建 2×2 格。分格依据：arm === "treatment" && taskId 匹配 && contractMode 匹配；
 * 每格用 `aggregateR5` / `buildR5JitGroups` 基于**该格自己的 runs** 独立聚合。
 */
export function buildR6EagerCells(
  runs: readonly R5RunMetrics[],
  config: R6EagerConfig,
): Record<R6EagerCellId, R6EagerCell> {
  const makeCell = (id: R6EagerCellId): R6EagerCell => {
    const def = R6_EAGER_CELLS[id];
    const cellRuns = runs.filter(
      (run) => run.arm === "treatment" && run.taskId === def.taskId && run.contractMode === def.contractMode,
    );
    return {
      label: def.label,
      taskId: def.taskId,
      contractMode: def.contractMode,
      runs: cellRuns,
      aggregate: aggregateR5(cellRuns, "treatment", def.taskId),
      jitGroups: buildR5JitGroups(cellRuns, "treatment", def.taskId),
    };
  };
  return {
    "A-eager": makeCell("A-eager"),
    "A-sig": makeCell("A-sig"),
    "B-eager": makeCell("B-eager"),
    "B-sig": makeCell("B-sig"),
  };
}

/** 计算 R6.3 的关键增量指标：A 的 signature tax、B 的 token/round 节省（正数分别表示税 / 节省）。 */
export interface R6EagerTax {
  aTaxTokens: number;
  bSavingsTokens: number;
  bSavingsRounds: number;
}

export function computeR6EagerTax(cells: Record<R6EagerCellId, R6EagerCell>): R6EagerTax {
  const A = cells["A-eager"].aggregate.avgTokens;
  const Asig = cells["A-sig"].aggregate.avgTokens;
  const B = cells["B-eager"].aggregate.avgTokens;
  const Bsig = cells["B-sig"].aggregate.avgTokens;
  return {
    aTaxTokens: Asig - A,
    bSavingsTokens: B - Bsig,
    bSavingsRounds: cells["B-eager"].aggregate.avgRounds - cells["B-sig"].aggregate.avgRounds,
  };
}

/**
 * 把一次 R6.3 实验的结果完整写入 report.json：
 * 配置 + 任务元数据（prompt / oracle）+ 2×2 cell（label / taskId / contractMode / aggregate / jitGroups）+ 全部 run。
 * 返回 report.json 的绝对路径。
 */
export function writeR6EagerReport(
  outDir: string,
  config: R6EagerConfig,
  tasks: readonly R5Task[],
  cells: Record<R6EagerCellId, R6EagerCell>,
  runs: readonly R5RunMetrics[],
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r6-eager-signature",
        config,
        model: "deepseek-v4-flash",
        timestamp: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          prompt: task.prompt,
          oracle: task.oracle.map(String),
        })),
        // cell 只落 label / taskId / contractMode / aggregate / jitGroups（runs 已单独序列化，避免重复）
        cells: Object.fromEntries(
          (Object.keys(cells) as R6EagerCellId[]).map((id) => [
            id,
            {
              label: cells[id].label,
              taskId: cells[id].taskId,
              contractMode: cells[id].contractMode,
              aggregate: cells[id].aggregate,
              jitGroups: cells[id].jitGroups,
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
// CLI 对比打印
// ---------------------------------------------------------------------------

/**
 * 紧凑打印 2×2 对比，聚焦语义正确性 / 首轮语义成功 / clean offload / 轮次 / token / 延迟，
 * 末尾附 A signature tax 与 B token/round 节省。
 */
export function printR6EagerComparison(cells: Record<R6EagerCellId, R6EagerCell>): void {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const ids: R6EagerCellId[] = ["A-eager", "A-sig", "B-eager", "B-sig"];
  for (const id of ids) {
    const cell = cells[id];
    const agg = cell.aggregate;
    const jitDist = cell.jitGroups.map((group) => `${group.group}=${group.runs}`).join(" ");
    console.log(`  [${id}] ${cell.label}`);
    console.log(
      `runs=${agg.runs} eventualSemantic=${pct(agg.eventualSemanticCorrectRate)} ` +
        `firstPassSemantic=${pct(agg.firstPassSemanticSuccessRate)} clean=${pct(agg.cleanOffloadRate)} ` +
        `avgRounds=${agg.avgRounds.toFixed(1)} avgTokens=${Math.round(agg.avgTokens)} avgLatencyMs=${Math.round(agg.avgLatencyMs)}`,
    );
    console.log(`    jitGroups: ${jitDist}`);
  }
  const tax = computeR6EagerTax(cells);
  console.log(`\nA signature tax = +${Math.round(tax.aTaxTokens)} tokens`);
  console.log(`B token savings = ${Math.round(tax.bSavingsTokens)} tokens；round savings = ${tax.bSavingsRounds.toFixed(1)} rounds`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** 单次 run 的日志（R6.1 风格，聚焦 contract acquisition 差异）。 */
function logRun(run: R5RunMetrics): void {
  console.log(
    `→ rounds=${run.rounds} maxedOut=${run.maxedOut} tokens=${run.tokens.total} latency=${run.latencyMs}ms ` +
      `answer=${run.answerCorrect ? "✓" : "✗"} completed=${run.taskCompleted ? "✓" : "✗"}`,
  );
  console.log(
    `  describe=${run.describeCalls} execute=${run.executeCalls} ` +
      `semantic=${run.jitSemanticCorrect === undefined ? "n/a" : run.jitSemanticCorrect} ` +
      `firstPassSemantic=${run.firstPassSemanticSuccess === undefined ? "n/a" : run.firstPassSemanticSuccess} ` +
      `business=[${run.businessCalls.join(", ") || "无"}]`,
  );
  if (run.submittedAnswer !== undefined) console.log(`  submit_answer：${run.submittedAnswer.slice(0, 300)}`);
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { cell, samples, rounds, reasoning } = parseR6EagerFlags(process.argv.slice(2));
  const cellIds: R6EagerCellId[] = cell === "all" ? ["A-eager", "A-sig", "B-eager", "B-sig"] : [cell];
  // reasoning 显式冻结：只认 CLI 标志，不依赖 gateway 默认值
  const runtime = createDeepSeekPiRuntime({ reasoning });

  const runs: R5RunMetrics[] = [];
  const usedTasks = new Map<R5TaskId, R5Task>();
  for (const id of cellIds) {
    const def = R6_EAGER_CELLS[id];
    const task = R5_TASKS.find((item) => item.id === def.taskId)!;
    usedTasks.set(task.id, task);
    for (let i = 1; i <= samples; i += 1) {
      console.log(`\n===== [${def.label}] sample ${i}/${samples} =====`);
      const run = await runR5Run(task, "treatment", runtime, rounds, {
        boundaryPolicy: true,
        stopAfterSubmit: true,
        contractMode: def.contractMode,
      });
      runs.push(run);
      logRun(run);
    }
  }

  console.log("\n\n===== R6.3 Eager DSL Signatures 2×2 对比 =====");
  const config: R6EagerConfig = { cell, samples, rounds, boundaryPolicy: true, stopAfterSubmit: true, reasoningEnabled: reasoning };
  const cells = buildR6EagerCells(runs, config);
  printR6EagerComparison(cells);

  const outDir = path.join(
    REPO_ROOT,
    "logs",
    "experiments",
    `r6-eager-signature-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const reportPath = writeR6EagerReport(outDir, config, [...usedTasks.values()], cells, runs);
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
