#!/usr/bin/env node

/**
 * R6.1 — Contract Acquisition 三臂实验：测量"拿到编程契约"这一动作的必要性。
 *
 * 实验问题：现状 baseline 要求模型先 jit_describe_tools 拿契约再 execute（eager）。
 * 如果直接让模型写程序、用编译的结构化诊断兜底，契约获取成本（describe 轮次 + 上下文）能不能省下来？
 * 三臂（都是 treatment 形态，协议完全统一：reasoning OFF + boundaryPolicy ON + stopAfterSubmit ON + Task B，
 * 差异只在 contract acquisition）：
 * - A = eager：先 describe 拿完整契约，再 execute；
 * - B = compile-only：不注册 jit_describe_tools，无 describe，仅 atomic inputs + DSL，
 *   编译失败按结构化诊断修正；
 * - C = manifest：同 B（也不注册 jit_describe_tools），另在常驻提示词里补紧凑 output manifest（只含工具输出形状）。
 * 外加恒跑的 control 臂（无 JIT 的普通 Agent）作为外部基线。
 *
 * 报告指标（沿用 R5 的 R5Aggregate 新字段）：firstPassCompileRateOverall / firstPassCompileRateAmongAttempts /
 * eventualCompileRate / avgRepairRounds / preDescribeUsedRate / describeFallbackRate，加上 adoption / precision /
 * token / rounds / jitGroups 分布（clean / earlyDirty / late / noJit）。
 *
 * 运行：npx tsx src/experiments/r6DescribeBenchmark.ts [--arm=A|B|C|all] [--task=A|B|C|all] [--samples=1] [--rounds=10] [--stop-after-submit]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime } from "../llm/gateway.js";
import { R5_TASKS, type R5Task } from "./r5Tasks.js";
import {
  runR5Run,
  type R5RunMetrics,
  type R6ContractMode,
  aggregateR5,
  buildR5JitGroups,
  type R5Aggregate,
  type R5JitGroupId,
} from "./r5OffloadingBenchmark.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export type R6Arm = "A" | "B" | "C";

export const R6_ARM_LABEL: Record<R6Arm | "control", string> = {
  control: "Control（无 JIT）",
  A: "A: eager（describe 拿完整契约）",
  B: "B: compile-only（无 describe，仅 atomic inputs + DSL）",
  C: "C: manifest（+ compact output shapes）",
};

/** arm → contractMode 映射（A/B/C 都是 treatment 形态，差异只在 contract acquisition）。 */
export const R6_ARM_CONTRACT_MODE: Record<R6Arm, R6ContractMode> = {
  A: "eager",
  B: "compile-only",
  C: "manifest",
};

/** 从 .env 加载环境变量（只补未设置项；r5OffloadingBenchmark 的 loadEnv 是模块私有，这里本地复制）。 */
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

export interface R6CliFlags {
  arm: R6Arm | "all";
  task: "A" | "B" | "C" | "all";
  samples: number;
  rounds: number;
  stopAfterSubmit: boolean;
}

export function parseR6Flags(argv: readonly string[]): R6CliFlags {
  const flags: R6CliFlags = { arm: "all", task: "all", samples: 1, rounds: 10, stopAfterSubmit: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "arm") {
      if (value === "A" || value === "B" || value === "C" || value === "all") flags.arm = value;
      else throw new Error(`--arm 必须是 A|B|C|all（当前：${value}）`);
    }
    if (key === "task") {
      if (value === "A" || value === "B" || value === "C" || value === "all") flags.task = value;
      else throw new Error(`--task 必须是 A|B|C|all（当前：${value}）`);
    }
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
    if (key === "stop-after-submit" && value === undefined) flags.stopAfterSubmit = true;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// 报告：control + 三臂的 cell 构建与落盘
// ---------------------------------------------------------------------------

export type R6CellId = "control" | "A" | "B" | "C";

export interface R6Cell {
  label: string;
  contractMode: R6ContractMode | "none";
  runs: readonly R5RunMetrics[];
  aggregate: R5Aggregate;
  jitGroups: readonly {
    group: R5JitGroupId;
    runs: number;
    avgTokens: number;
    avgUncachedInput: number;
    avgCacheRead: number;
    avgOutput: number;
    avgRounds: number;
  }[];
}

export interface R6ReportConfig {
  arm: R6Arm | "all";
  task: "A" | "B" | "C" | "all";
  samples: number;
  rounds: number;
  stopAfterSubmit: boolean;
  /** 统一协议固定 Boundary Policy ON（可选：仅报告元数据，buildR6Cells/writeR6Report 不消费）。 */
  boundaryPolicy?: boolean;
}

/**
 * 从全部 runs 构建四格 cell。
 *
 * 分臂依据：run.contractMode（runR5Run 已把 contractMode 透传到 R5RunMetrics）——
 * control 格 = arm="control"；A/B/C 格 = arm="treatment" 且 contractMode 分别等于
 * eager-describe / compile-first / compact-manifest。每格用 `aggregateR5` /
 * `buildR5JitGroups` 基于**该格自己的 runs** 独立聚合（多臂一起跑时不再合并）。
 * taskId 取 runs 的首个 run（同一实验内 task 唯一），空 runs 时回退 config.task（"all" → "B"）。
 */
export function buildR6Cells(runs: readonly R5RunMetrics[], config: R6ReportConfig): Record<R6CellId, R6Cell> {
  const cellTaskId = runs[0]?.taskId ?? (config.task === "all" ? "B" : config.task);
  const makeCell = (
    id: R6CellId,
    label: string,
    contractMode: R6ContractMode | "none",
    arm: "control" | "treatment",
    filter: (run: R5RunMetrics) => boolean,
  ): R6Cell => {
    const cellRuns = runs.filter((run) => run.arm === arm && run.taskId === cellTaskId && filter(run));
    return {
      label,
      contractMode,
      runs: cellRuns,
      aggregate: aggregateR5(cellRuns, arm, cellTaskId),
      jitGroups: buildR5JitGroups(cellRuns, arm, cellTaskId),
    };
  };
  return {
    control: makeCell("control", R6_ARM_LABEL.control, "none", "control", () => true),
    A: makeCell("A", R6_ARM_LABEL.A, R6_ARM_CONTRACT_MODE.A, "treatment", (run) => run.contractMode === "eager"),
    B: makeCell("B", R6_ARM_LABEL.B, R6_ARM_CONTRACT_MODE.B, "treatment", (run) => run.contractMode === "compile-only"),
    C: makeCell("C", R6_ARM_LABEL.C, R6_ARM_CONTRACT_MODE.C, "treatment", (run) => run.contractMode === "manifest"),
  };
}

/**
 * 把一次 R6.1 实验的结果完整写入 report.json：
 * 配置 + 任务元数据（prompt / oracle）+ 四格 cell（label / contractMode / aggregate / jitGroups）+ 全部 run。
 * 返回 report.json 的绝对路径。
 */
export function writeR6Report(
  outDir: string,
  config: R6ReportConfig,
  tasks: readonly R5Task[],
  cells: Record<R6CellId, R6Cell>,
  runs: readonly R5RunMetrics[],
): string {
  // R6.1 冻结校验：compile-only / manifest 格契约上不挂 describe 工具，run 的 describeCalls 必须为 0。
  // 违者只告警不中断写盘（不静默放行；R5RunMetrics 顶层无 round 字段，用 run 索引标注）。
  for (const [id, cell] of Object.entries(cells)) {
    if (cell.contractMode !== "compile-only" && cell.contractMode !== "manifest") continue;
    cell.runs.forEach((run, runIndex) => {
      if (run.describeCalls > 0) {
        console.warn(
          `[R6 冻结校验] ${id} 格 run 存在 describeCalls>0：${run.taskId}/run=${runIndex} describeCalls=${run.describeCalls}`,
        );
      }
    });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r6-contract-discovery",
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
          (Object.keys(cells) as R6CellId[]).map((id) => [
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
 * 紧凑打印四格对比表，分两组：
 * - primary metrics：runs / firstPassOverall / firstPassAmongAttempts / eventualSemantic / eventualExec / avgTokens / avgRounds；
 * - 次要指标：eventualCompile / avgRepairRounds / preDescribe / describeFallback / adoption / precision；
 * 末尾 jitGroups 分布不变。
 */
export function printR6Comparison(cells: Record<R6CellId, R6Cell>): void {
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  const cellIds: R6CellId[] = ["control", "A", "B", "C"];
  for (const id of cellIds) {
    const cell = cells[id];
    const agg = cell.aggregate;
    const jitDist = cell.jitGroups.map((group) => `${group.group}=${group.runs}`).join(" ");
    console.log(`  [${id}] ${cell.label}`);
    console.log(
      `runs=${agg.runs} ` +
        `firstPassOverall=${pct(agg.firstPassCompileRateOverall)} firstPassAmongAttempts=${pct(agg.firstPassCompileRateAmongAttempts)} ` +
        `eventualSemantic=${pct(agg.eventualSemanticCorrectRate)} eventualExec=${pct(agg.eventualExecutionRate)} ` +
        `avgTokens=${Math.round(agg.avgTokens)} avgRounds=${agg.avgRounds.toFixed(1)}`,
    );
    console.log(
      `eventualCompile=${pct(agg.eventualCompileRate)} avgRepairRounds=${agg.avgRepairRounds.toFixed(1)} ` +
        `preDescribe=${pct(agg.preDescribeUsedRate)} describeFallback=${pct(agg.describeFallbackRate)} ` +
        `adoption=${pct(agg.adoptionRate)} precision=${pct(agg.offloadPrecision)}`,
    );
    console.log(`    jitGroups: ${jitDist}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** 单次 run 的日志（R5 风格 + R6.1 相关字段）。 */
function logRun(run: R5RunMetrics): void {
  console.log(
    `→ rounds=${run.rounds} maxedOut=${run.maxedOut} tokens=${run.tokens.total} latency=${run.latencyMs}ms ` +
      `answer=${run.answerCorrect ? "✓" : "✗"} completed=${run.taskCompleted ? "✓" : "✗"}`,
  );
  console.log(
    `  jitAttempted=${run.jitAttempted} execSucceeded=${run.jitExecutionSucceeded} ` +
      `semantic=${run.jitSemanticCorrect === undefined ? "n/a" : run.jitSemanticCorrect} ` +
      `describe=${run.describeCalls} execute=${run.executeCalls} business=[${run.businessCalls.join(", ") || "无"}]`,
  );
  console.log(
    `  R6: compile=${run.firstPassCompileSuccess === undefined ? "n/a" : run.firstPassCompileSuccess} ` +
      `exec=${run.firstPassExecutionSuccess === undefined ? "n/a" : run.firstPassExecutionSuccess} ` +
      `semantic=${run.jitSemanticCorrect === undefined ? "n/a" : run.jitSemanticCorrect} ` +
      `repairRounds=${run.repairRounds === undefined ? "n/a" : run.repairRounds} ` +
      `preDescribe=${run.preDescribeUsed === undefined ? "n/a" : run.preDescribeUsed} describeFallbackUsed=${run.describeFallbackUsed} ` +
      `executeErrors=${(run.executeErrors ?? []).length}`,
  );
  if (run.submittedAnswer !== undefined) console.log(`  submit_answer：${run.submittedAnswer.slice(0, 300)}`);
  if (run.lastProgram) {
    console.log(`  DSL 正确：${run.lastProgram.dslCorrect === undefined ? "n/a" : run.lastProgram.dslCorrect}`);
  }
  for (const errorText of run.executeErrors ?? []) {
    console.log(`  [execute 失败] ${errorText.replace(/\n/g, " ").slice(0, 200)}`);
  }
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { arm, task, samples, rounds, stopAfterSubmit } = parseR6Flags(process.argv.slice(2));
  const tasks = R5_TASKS.filter((item) => task === "all" || item.id === task);
  const r6Arms: R6Arm[] = arm === "all" ? ["A", "B", "C"] : [arm];
  const runtime = createDeepSeekPiRuntime();

  const runs: R5RunMetrics[] = [];
  // control 臂恒跑（与选定臂同 samples 数，保证四格样本量可比；无 JIT，contractMode 无关）
  for (const currentTask of tasks) {
    for (let i = 1; i <= samples; i += 1) {
      console.log(`\n===== [control/${currentTask.id}] ${currentTask.name}（sample ${i}/${samples}）=====`);
      const run = await runR5Run(currentTask, "control", runtime, rounds, {
        ...(stopAfterSubmit ? { stopAfterSubmit } : {}),
      });
      runs.push(run);
      logRun(run);
    }
  }
  // 选定的 R6 臂（treatment 形态，差异只在 contractMode）
  for (const currentArm of r6Arms) {
    for (const currentTask of tasks) {
      for (let i = 1; i <= samples; i += 1) {
        console.log(`\n===== [${R6_ARM_LABEL[currentArm]}] ${currentTask.name}（sample ${i}/${samples}）=====`);
        const run = await runR5Run(currentTask, "treatment", runtime, rounds, {
          ...(stopAfterSubmit ? { stopAfterSubmit } : {}),
          boundaryPolicy: true,
          contractMode: R6_ARM_CONTRACT_MODE[currentArm],
        });
        runs.push(run);
        logRun(run);
      }
    }
  }

  console.log("\n\n===== R6.1 三臂对比 =====");
  const cells = buildR6Cells(runs, { arm, task, samples, rounds, stopAfterSubmit, boundaryPolicy: true });
  printR6Comparison(cells);

  const outDir = path.join(
    REPO_ROOT,
    "logs",
    "experiments",
    `r6-contract-discovery-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const reportPath = writeR6Report(
    outDir,
    { arm, task, samples, rounds, stopAfterSubmit, boundaryPolicy: true },
    tasks,
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
