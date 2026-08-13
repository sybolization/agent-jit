#!/usr/bin/env node

/**
 * R6.3 — Eager DSL Signatures 对照实验（两臂）。
 *
 * 实验问题：去掉 describe round、用 eager-loaded 函数式 DSL 签名直接 execute，
 * 质量是否保持、成本是否下降。
 *
 * 两臂（都是 treatment、Task B、boundaryPolicy ON、stopAfterSubmit ON、
 * 同 reasoning/model/tools/DSL，唯一变量是 contract acquisition）：
 * - A = compact describe（eager）：Agent → describe → Agent → execute；
 * - B = eager DSL signatures（eager-signatures）：active tools 已带 DSL 签名，
 *   Agent → execute（不挂 describe、不追加 manifest）。
 *
 * 报告指标聚焦：eventualSemanticCorrectRate / firstPassSemanticSuccessRate /
 * cleanOffloadRate / avgRounds / avgTokens / avgLatencyMs，附 jitGroups 分布。
 *
 * 注：A Task 的 token overhead（不 JIT 的 eager signature tax）留作后续对照。
 *
 * 运行：npx tsx src/experiments/r6EagerSignatureBenchmark.ts [--arm=A|B|all] [--samples=1] [--rounds=10]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime } from "../llm/gateway.js";
import { R5_TASKS, type R5Task } from "./r5Tasks.js";
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

export type R6EagerArm = "A" | "B";

export const R6_EAGER_ARM_LABEL: Record<R6EagerArm, string> = {
  A: "A: compact describe（eager：Agent → describe → Agent → execute）",
  B: "B: eager DSL signatures（active tools 带签名：Agent → execute）",
};

/** arm → contractMode 映射（两臂都是 treatment 形态，唯一变量是 contract acquisition）。 */
export const R6_EAGER_CONTRACT_MODE: Record<R6EagerArm, R6ContractMode> = {
  A: "eager",
  B: "eager-signatures",
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
  arm: R6EagerArm | "all";
  samples: number;
  rounds: number;
}

export function parseR6EagerFlags(argv: readonly string[]): R6EagerFlags {
  const flags: R6EagerFlags = { arm: "all", samples: 1, rounds: 10 };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "arm") {
      if (value === "A" || value === "B" || value === "all") flags.arm = value;
      else throw new Error(`--arm 必须是 A|B|all（当前：${value}）`);
    }
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// 报告：两臂 cell 构建与落盘
// ---------------------------------------------------------------------------

export interface R6EagerConfig {
  arm: R6EagerArm | "all";
  samples: number;
  rounds: number;
  /** 统一协议固定 Boundary Policy ON（可选：仅报告元数据）。 */
  boundaryPolicy?: boolean;
  /** 统一协议固定 stop-after-submit ON（可选：仅报告元数据）。 */
  stopAfterSubmit?: boolean;
}

export interface R6EagerCell {
  label: string;
  contractMode: R6ContractMode;
  runs: readonly R5RunMetrics[];
  aggregate: R5Aggregate;
  jitGroups: readonly R5JitGroup[];
}

/**
 * 从全部 runs 构建两格 cell（A = eager、B = eager-signatures）。
 * 分格依据：arm === "treatment" && taskId === "B" && contractMode 匹配；
 * 每格用 `aggregateR5` / `buildR5JitGroups` 基于**该格自己的 runs** 独立聚合。
 */
export function buildR6EagerCells(
  runs: readonly R5RunMetrics[],
  config: R6EagerConfig,
): Record<R6EagerArm, R6EagerCell> {
  const makeCell = (arm: R6EagerArm): R6EagerCell => {
    const contractMode = R6_EAGER_CONTRACT_MODE[arm];
    const cellRuns = runs.filter(
      (run) => run.arm === "treatment" && run.taskId === "B" && run.contractMode === contractMode,
    );
    return {
      label: R6_EAGER_ARM_LABEL[arm],
      contractMode,
      runs: cellRuns,
      aggregate: aggregateR5(cellRuns, "treatment", "B"),
      jitGroups: buildR5JitGroups(cellRuns, "treatment", "B"),
    };
  };
  return { A: makeCell("A"), B: makeCell("B") };
}

/**
 * 把一次 R6.3 实验的结果完整写入 report.json：
 * 配置 + 任务元数据（prompt / oracle）+ 两格 cell（label / contractMode / aggregate / jitGroups）+ 全部 run。
 * 返回 report.json 的绝对路径。
 */
export function writeR6EagerReport(
  outDir: string,
  config: R6EagerConfig,
  tasks: readonly R5Task[],
  cells: Record<R6EagerArm, R6EagerCell>,
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
        // cell 只落 label / contractMode / aggregate / jitGroups（runs 已单独序列化，避免重复）
        cells: Object.fromEntries(
          (Object.keys(cells) as R6EagerArm[]).map((id) => [
            id,
            {
              label: cells[id].label,
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
 * 紧凑打印两臂对比，聚焦语义正确性 / 首轮语义成功 / clean offload / 轮次 / token / 延迟，
 * 末尾附 jitGroups 分布。
 */
export function printR6EagerComparison(cells: Record<R6EagerArm, R6EagerCell>): void {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const arms: R6EagerArm[] = ["A", "B"];
  for (const arm of arms) {
    const cell = cells[arm];
    const agg = cell.aggregate;
    const jitDist = cell.jitGroups.map((group) => `${group.group}=${group.runs}`).join(" ");
    console.log(`  [${arm}] ${cell.label}`);
    console.log(
      `runs=${agg.runs} eventualSemantic=${pct(agg.eventualSemanticCorrectRate)} ` +
        `firstPassSemantic=${pct(agg.firstPassSemanticSuccessRate)} clean=${pct(agg.cleanOffloadRate)} ` +
        `avgRounds=${agg.avgRounds.toFixed(1)} avgTokens=${Math.round(agg.avgTokens)} avgLatencyMs=${Math.round(agg.avgLatencyMs)}`,
    );
    console.log(`    jitGroups: ${jitDist}`);
  }
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

  const { arm, samples, rounds } = parseR6EagerFlags(process.argv.slice(2));
  const task = R5_TASKS.find((item) => item.id === "B")!;
  const arms: R6EagerArm[] = arm === "all" ? ["A", "B"] : [arm];
  const runtime = createDeepSeekPiRuntime();

  const runs: R5RunMetrics[] = [];
  for (const currentArm of arms) {
    for (let i = 1; i <= samples; i += 1) {
      console.log(`\n===== [${R6_EAGER_ARM_LABEL[currentArm]}] sample ${i}/${samples} =====`);
      const run = await runR5Run(task, "treatment", runtime, rounds, {
        boundaryPolicy: true,
        stopAfterSubmit: true,
        contractMode: R6_EAGER_CONTRACT_MODE[currentArm],
      });
      runs.push(run);
      logRun(run);
    }
  }

  console.log("\n\n===== R6.3 Eager DSL Signatures 两臂对比 =====");
  const config: R6EagerConfig = { arm, samples, rounds, boundaryPolicy: true, stopAfterSubmit: true };
  const cells = buildR6EagerCells(runs, config);
  printR6EagerComparison(cells);

  const outDir = path.join(
    REPO_ROOT,
    "logs",
    "experiments",
    `r6-eager-signature-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const reportPath = writeR6EagerReport(outDir, config, [task], cells, runs);
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
