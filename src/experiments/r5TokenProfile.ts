#!/usr/bin/env node

/**
 * R5 Token Profile — 从既有/新 R5 report 生成 Control vs JIT 的 token 成本分解表。
 *
 * 回答：Control 的 Token 花在哪里？JIT 的 Token 又花在哪里？
 * - arm×task 分项均值（uncached input / cache read / output / total）；
 * - phase 分解（atomic-execution / jit-describe / jit-program / submission / finalization / mixed），
 *   仅对含 tokenRounds 的新 report 可用；老 report 优雅降级；
 * - treatment 的 cleanOffload / lateOffload / noJit 分组统计。
 *
 * 运行：npx tsx src/experiments/r5TokenProfile.ts <report.json 路径>
 * 说明：本工具只读报告、不跑模型。若 report 的 runs 没有 tokenRounds（本轮改造前的报告），
 * phase 分解会标注"无 round-level 数据"，分项/分组统计仍照常输出。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sumAtomicStagesByStage,
  sumTokenRoundsByPhase,
  type AtomicStage,
  type TokenRoundPhase,
  type TokenTotals,
} from "./tokenAccounting.js";
import {
  buildR5JitGroups,
  classifyR5JitGroup,
  type R5Arm,
  type R5JitGroupId,
  type R5RunMetrics,
} from "./r5OffloadingBenchmark.js";
import type { R5TaskId } from "./r5Tasks.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** report.json 里单个 run 的输入形态（只取分析需要的字段）。 */
export interface ProfileStoredRun {
  arm: string;
  taskId: string;
  rounds: number;
  tokens: { input: number; output: number; cacheRead: number; total: number };
  tokenRounds?: readonly {
    round: number;
    input: number;
    cacheRead: number;
    output: number;
    total: number;
    toolCalls: readonly string[];
  }[];
  jitAttempted?: boolean;
  jitFinishedWithoutFallback?: boolean;
  earlyOffloadDecision?: boolean | null;
  preExecutePipelineCalls?: number | null;
  timelyOffload?: boolean | null;
}

export interface R5ReportForProfile {
  config: Record<string, unknown>;
  runs: readonly ProfileStoredRun[];
}

export function loadR5Report(reportPath: string): R5ReportForProfile {
  const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    config?: Record<string, unknown>;
    runs?: readonly ProfileStoredRun[];
  };
  if (!Array.isArray(parsed.runs)) throw new Error("report.json 缺少 runs 数组");
  return { config: parsed.config ?? {}, runs: parsed.runs };
}

const ARMS: R5Arm[] = ["control", "treatment"];
const TASK_IDS: R5TaskId[] = ["A", "B", "C"];
const PHASE_ORDER: TokenRoundPhase[] = [
  "atomic-execution",
  "jit-describe",
  "jit-program",
  "submission",
  "finalization",
  "mixed",
];
const ARM_LABEL: Record<R5Arm, string> = {
  control: "Control（普通 Agent）",
  treatment: "Treatment（+ JIT）",
};
const GROUP_IDS: R5JitGroupId[] = ["cleanOffload", "earlyDirtyOffload", "lateOffload", "noJit"];

const avg = (values: number[]): number =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function runProfile(reportPath: string): number {
  if (!fs.existsSync(reportPath)) {
    console.error(`[FAIL] 找不到报告：${reportPath}`);
    return 1;
  }
  const { config, runs } = loadR5Report(reportPath);
  console.log(`\n===== R5 Token Profile：${reportPath}`);
  console.log(`config：${JSON.stringify(config)}\n`);

  // 1) arm×task 分项对照表
  console.log("===== 1) arm × task 分项 token（每 run 均值）=====");
  console.log("  arm        task  runs  uncachedInput  cacheRead   output     total   avgRounds");
  for (const arm of ARMS) {
    for (const taskId of TASK_IDS) {
      const cell = runs.filter((run) => run.arm === arm && run.taskId === taskId);
      if (cell.length === 0) continue;
      console.log(
        `  ${arm.padEnd(9)} ${taskId}   ${String(cell.length).padStart(4)}  ` +
          `${formatTokens(avg(cell.map((r) => r.tokens.input))).padStart(9)}   ` +
          `${formatTokens(avg(cell.map((r) => r.tokens.cacheRead))).padStart(9)}   ` +
          `${formatTokens(avg(cell.map((r) => r.tokens.output))).padStart(9)}   ` +
          `${formatTokens(avg(cell.map((r) => r.tokens.total))).padStart(9)}   ` +
          avg(cell.map((r) => r.rounds)).toFixed(1),
      );
    }
  }

  // 2) phase 分解（三重口径：presenceRate / avgWhenPresent / avgPerAllRuns）
  console.log("\n===== 2) phase 分解（presenceRate / avgWhenPresent / avgPerAllRuns；需 tokenRounds）=====");
  const runsWithRounds = runs.filter((run) => Array.isArray(run.tokenRounds) && run.tokenRounds!.length > 0);
  if (runsWithRounds.length === 0) {
    console.log("  该报告所有 run 均无 tokenRounds（本轮改造前的报告）→ 无 round-level 数据，phase 分解不可用。");
  } else {
    for (const arm of ARMS) {
      const armRuns = runsWithRounds.filter((run) => run.arm === arm);
      if (armRuns.length === 0) continue;
      console.log(`  [${ARM_LABEL[arm]}] runs=${armRuns.length}`);
      console.log("    phase             present  presenceRate  avgWhenPresent  avgPerAllRuns");
      for (const phase of PHASE_ORDER) {
        const totals = armRuns.map((run) => sumTokenRoundsByPhase(run.tokenRounds!)[phase]);
        const present = totals.filter((t) => t.total > 0);
        console.log(
          `    ${phase.padEnd(16)} ${String(present.length).padStart(5)}  ` +
            `${((present.length / armRuns.length) * 100).toFixed(0).padStart(4)}%  ` +
            `${formatTokens(avg(present.map((t) => t.total))).padStart(9)}   ` +
            `${formatTokens(avg(totals.map((t) => t.total))).padStart(9)}`,
        );
      }
    }
  }

  // 3) treatment 的 4 组分组（clean / earlyDirty / late / noJit）
  console.log("\n===== 3) Treatment：clean / earlyDirty / late / noJit 分组 token =====");
  for (const taskId of TASK_IDS) {
    const groups = buildR5JitGroups(runs as readonly R5RunMetrics[], "treatment", taskId);
    console.log(`  [${taskId}] runs=${groups.reduce((sum, g) => sum + g.runs, 0)}`);
    console.log("    group              runs  uncachedInput  cacheRead   output     total   avgRounds");
    for (const group of groups) {
      console.log(
        `    ${group.group.padEnd(18)} ${String(group.runs).padStart(4)}  ` +
          `${formatTokens(group.avgUncachedInput).padStart(9)}   ` +
          `${formatTokens(group.avgCacheRead).padStart(9)}   ` +
          `${formatTokens(group.avgOutput).padStart(9)}   ` +
          `${formatTokens(group.avgTokens).padStart(9)}   ` +
          group.avgRounds.toFixed(1),
      );
    }
  }

  // 4) treatment group × phase 交叉（avgPerAllRuns，四维度）
  console.log("\n===== 4) Treatment：group × phase（avgPerAllRuns，四维度 token）=====");
  const treatmentRounds = runs.filter(
    (run) => run.arm === "treatment" && Array.isArray(run.tokenRounds) && run.tokenRounds!.length > 0,
  );
  if (treatmentRounds.length === 0) {
    console.log("  无含 tokenRounds 的 treatment run。");
  } else {
    for (const taskId of TASK_IDS) {
      const cell = treatmentRounds.filter((run) => run.taskId === taskId);
      if (cell.length === 0) continue;
      console.log(`  [${taskId}] runs=${cell.length}`);
      console.log("    group              phase              uncachedInput  cacheRead   output     total");
      for (const group of GROUP_IDS) {
        const groupRuns = cell.filter(
          (run) => classifyR5JitGroup(run as unknown as R5RunMetrics) === group,
        );
        if (groupRuns.length === 0) continue;
        for (const phase of PHASE_ORDER) {
          const totals = groupRuns.map((run) => sumTokenRoundsByPhase(run.tokenRounds!)[phase]);
          const dim = (pick: (t: TokenTotals) => number): number => avg(totals.map(pick));
          console.log(
            `    ${group.padEnd(18)} ${phase.padEnd(16)} ` +
              `${formatTokens(dim((t) => t.input)).padStart(9)}   ` +
              `${formatTokens(dim((t) => t.cacheRead)).padStart(9)}   ` +
              `${formatTokens(dim((t) => t.output)).padStart(9)}   ` +
              `${formatTokens(dim((t) => t.total)).padStart(9)}`,
          );
        }
      }
    }
  }

  // 5) control：atomic stage 聚合
  console.log("\n===== 5) Control：atomic stage 聚合（avgPerAllRuns，四维度 token）=====");
  const controlRounds = runs.filter(
    (run) => run.arm === "control" && Array.isArray(run.tokenRounds) && run.tokenRounds!.length > 0,
  );
  if (controlRounds.length === 0) {
    console.log("  无含 tokenRounds 的 control run。");
  } else {
    const stages: AtomicStage[] = ["search", "details", "scoring", "other"];
    console.log("    stage    uncachedInput  cacheRead   output     total");
    for (const stage of stages) {
      const perRun = controlRounds.map((run) => sumAtomicStagesByStage(run.tokenRounds!)[stage]);
      console.log(
        `    ${stage.padEnd(8)} ` +
          `${formatTokens(avg(perRun.map((t) => t.input))).padStart(9)}   ` +
          `${formatTokens(avg(perRun.map((t) => t.cacheRead))).padStart(9)}   ` +
          `${formatTokens(avg(perRun.map((t) => t.output))).padStart(9)}   ` +
          `${formatTokens(avg(perRun.map((t) => t.total))).padStart(9)}`,
      );
    }
  }

  return 0;
}

export function main(): number {
  const reportArg = process.argv[2];
  if (!reportArg) {
    console.error("[FAIL] 用法：npx tsx src/experiments/r5TokenProfile.ts <report.json 路径>");
    return 1;
  }
  return runProfile(path.resolve(reportArg));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
