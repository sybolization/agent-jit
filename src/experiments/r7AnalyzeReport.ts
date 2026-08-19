#!/usr/bin/env node

/**
 * R7 report 离线分析器：读一个或多个 r7-routing report.json，合并 runs，
 * 按 arm × task 聚合，并用**预注册规则**（r7Decision.ts）做 development 决策。
 *
 * 用法：
 *   npx tsx src/experiments/r7AnalyzeReport.ts <report.json> [more-report.json...]
 *
 * 不调用模型；只读 report.json。结果打印到 stdout，并在第一个报告目录写
 * decision.json（仅当存在 B 任务 cell 时）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { R5RunMetrics } from "./shared/types.js";
import type { R5TaskId } from "./r5Tasks.js";
import type { R7ArmId } from "./r7RoutingBenchmark.js";
import { decideR7Development, decideR7Holdout, type R7CellSummary } from "./r7Decision.js";
import { aggregateR5 } from "./shared/agentJitRun.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

interface R7ReportFile {
  mode?: string;
  armDefs?: readonly { id: string; kind?: string }[];
  runs?: Array<R5RunMetrics & { r7Arm?: string }>;
}

function loadReports(paths: readonly string[]): { reportPaths: string[]; runs: Array<R5RunMetrics & { r7Arm: string }> } {
  const runs: Array<R5RunMetrics & { r7Arm: string }> = [];
  const reportPaths: string[] = [];
  for (const raw of paths) {
    const reportPath = path.resolve(REPO_ROOT, raw);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as R7ReportFile;
    if (report.mode !== "r7-routing-discovery") {
      throw new Error(`不是 R7 report：${reportPath}（mode=${report.mode ?? "unknown"}）`);
    }
    reportPaths.push(reportPath);
    for (const run of report.runs ?? []) {
      if (run.r7Arm === undefined) continue;
      runs.push({ ...run, r7Arm: run.r7Arm });
    }
  }
  return { reportPaths, runs };
}

function toSummary(runs: ReadonlyArray<R5RunMetrics & { r7Arm: string }>, armId: R7ArmId, taskId: R5TaskId, armKind: "control" | "treatment"): R7CellSummary {
  const cellRuns = runs.filter((run) => run.r7Arm === armId && run.taskId === taskId);
  const aggregate = aggregateR5(cellRuns, armKind, taskId);
  return {
    armId,
    taskId: taskId as "A" | "B" | "H",
    runs: aggregate.runs,
    taskCompletionRate: aggregate.taskCompletionRate,
    offloadPrecision: aggregate.offloadPrecision,
    efficiencyScore: aggregate.taskCompletionRate > 0 ? aggregate.avgTokens / aggregate.taskCompletionRate : Number.POSITIVE_INFINITY,
    unnecessaryOffloadRate: aggregate.unnecessaryOffloadRate ?? 0,
    avgTokens: aggregate.avgTokens,
    cleanOffloadRate: aggregate.cleanOffloadRate,
    fallbackRate: aggregate.fallbackRate,
    maxedOutRate: aggregate.maxedOutRate,
    avgRepairRounds: aggregate.avgRepairRounds,
    avgRounds: aggregate.avgRounds,
  };
}

/** 纯函数：把带 r7Arm 标注的 runs 汇总为 arm×task cells（每个 cell 严格只吃自己的 runs）。 */
export function summarizeR7Runs(runs: ReadonlyArray<R5RunMetrics & { r7Arm: string }>): R7CellSummary[] {
  const armIds = [...new Set(runs.map((run) => run.r7Arm as R7ArmId))];
  const taskIds = [...new Set(runs.map((run) => run.taskId))].sort();
  const cells: R7CellSummary[] = [];
  for (const armId of armIds) {
    for (const taskId of taskIds) {
      const kind = armId === "C0" ? "control" : "treatment";
      cells.push(toSummary(runs, armId, taskId as R5TaskId, kind));
    }
  }
  return cells;
}

function main(): void {
  const reportPaths = process.argv.slice(2);
  if (reportPaths.length === 0) {
    console.error("用法：npx tsx src/experiments/r7AnalyzeReport.ts <report.json> [more-report.json...]");
    process.exitCode = 1;
    return;
  }

  const { reportPaths: loadedPaths, runs } = loadReports(reportPaths);
  const cells = summarizeR7Runs(runs);

  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  console.log("===== R7 merged aggregates =====");
  for (const cell of cells.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.armId.localeCompare(b.armId))) {
    console.log(
      `[${cell.armId}/${cell.taskId}] runs=${cell.runs} completed=${pct(cell.taskCompletionRate)} ` +
        `precision=${pct(cell.offloadPrecision)} unnecessary=${pct(cell.unnecessaryOffloadRate)} ` +
        `avgTokens=${Math.round(cell.avgTokens)} efficiency=${Number.isFinite(cell.efficiencyScore) ? Math.round(cell.efficiencyScore) : "∞"}`,
    );
  }

  const decision = decideR7Development(cells);
  console.log("\n===== R7 development decision（预注册规则）=====");
  console.log(`eligible=${decision.eligibleArmIds.join(",") || "无"}`);
  console.log(`winner=${decision.winnerArmId ?? "无"}`);
  console.log(`conclusion=${decision.conclusion}`);
  console.log(`P0 efficiency=${Number.isFinite(decision.positiveControlEfficiency) ? Math.round(decision.positiveControlEfficiency) : "∞"}`);

  let holdoutDecision: ReturnType<typeof decideR7Holdout> | undefined;
  if (decision.winnerArmId !== undefined && cells.some((cell) => cell.taskId === "H" && cell.runs > 0)) {
    holdoutDecision = decideR7Holdout(cells, decision.winnerArmId);
    console.log("\n===== R7 holdout decision（预注册规则）=====");
    console.log(`winner=${holdoutDecision.winnerArmId} conclusion=${holdoutDecision.conclusion}`);
    for (const reason of holdoutDecision.reasons) console.log(`- ${reason}`);
  }

  const outDir = path.dirname(loadedPaths[0]!);
  fs.writeFileSync(
    path.join(outDir, "decision.json"),
    `${JSON.stringify({ decision, holdoutDecision: holdoutDecision ?? null, cells, mergedReports: loadedPaths }, null, 2)}\n`,
  );
  console.log(`\n[decision] ${path.join(outDir, "decision.json")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
