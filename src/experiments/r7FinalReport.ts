#!/usr/bin/env node

/**
 * R7 最终报告生成器（只读）：
 * 输入一个或多个 r7-routing report.json（顺序：development B、development A、
 * 可选 holdout H），自动执行预注册决策 + prompt overfit audit，
 * 生成 Markdown 报告。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { R5RunMetrics } from "./shared/types.js";
import type { R5TaskId } from "./r5Tasks.js";
import { R7_ARMS } from "./r7RoutingBenchmark.js";
import { summarizeR7Runs } from "./r7AnalyzeReport.js";
import { decideR7Development, decideR7Holdout } from "./r7Decision.js";
import { auditPromptOverlap } from "./r7OverfitAudit.js";
import { armPromptTexts, r7AuditTasks } from "./r7OverfitReport.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

function loadRuns(paths: readonly string[]): Array<R5RunMetrics & { r7Arm: string }> {
  const runs: Array<R5RunMetrics & { r7Arm: string }> = [];
  for (const raw of paths) {
    const reportPath = path.resolve(REPO_ROOT, raw);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
      mode?: string;
      runs?: Array<R5RunMetrics & { r7Arm?: string }>;
    };
    if (report.mode !== "r7-routing-discovery") throw new Error(`不是 R7 report：${reportPath}`);
    for (const run of report.runs ?? []) {
      if (run.r7Arm === undefined) continue;
      runs.push({ ...run, r7Arm: run.r7Arm });
    }
  }
  return runs;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("用法：npx tsx src/experiments/r7FinalReport.ts <B报告> <A报告> [H报告]");
    process.exitCode = 1;
    return;
  }
  const runs = loadRuns(paths);
  const cells = summarizeR7Runs(runs);
  const byKey = new Map(cells.map((cell) => [`${cell.armId}/${cell.taskId}`, cell]));

  const row = (arm: string, task: string): string => {
    const cell = byKey.get(`${arm}/${task}`);
    if (!cell || cell.runs === 0) return "| — | — | — | — | — | — | — | — |";
    return (
      `| ${cell.runs} | ${pct(cell.taskCompletionRate)} | ${pct(cell.offloadPrecision)} | ` +
      `${Math.round(cell.avgTokens)} | ${Number.isFinite(cell.efficiencyScore) ? Math.round(cell.efficiencyScore) : "∞"} |`
    );
  };

  const development = decideR7Development(cells);
  let holdoutText = "未提供 H 报告，holdout 未执行。";
  if (cells.some((cell) => cell.taskId === "H" && cell.runs > 0) && development.winnerArmId !== undefined) {
    const holdout = decideR7Holdout(cells, development.winnerArmId);
    holdoutText = [
      `winner=${holdout.winnerArmId}`,
      `gatePass=${holdout.gatePass}`,
      `efficiencyNotWorseThanP0=${holdout.efficiencyNotWorseThanP0}`,
      `conclusion=${holdout.conclusion}`,
      ...holdout.reasons.map((reason) => `- ${reason}`),
    ].join("\n");
  }

  const auditLines: string[] = [];
  const auditTasks = r7AuditTasks();
  for (const arm of R7_ARMS) {
    const promptText = armPromptTexts(arm).join("\n");
    let worst = 0;
    const hits = new Set<string>();
    for (const task of auditTasks) {
      const audit = auditPromptOverlap(promptText, [task.prompt, ...task.oracle.map(String)]);
      worst = Math.max(worst, audit.longestCommonSubstringLength);
      for (const hit of audit.forbiddenTokenHits) hits.add(hit);
    }
    auditLines.push(`| ${arm.id} | ${[...hits].join(", ") || "无"} | ${worst} |`);
  }

  const markdown = [
    "# R7 Routing Development 正式报告（自动生成）",
    "",
    `生成时间：${new Date().toISOString()}`,
    `报告输入：${paths.join(", ")}`,
    "",
    "## 1. Development B",
    "",
    "| arm | runs | completed | precision | avgTokens | efficiencyScore |",
    "|---|---:|---:|---:|---:|---:|",
    ...R7_ARMS.map((arm) => {
      const cell = byKey.get(`${arm.id}/B`);
      return `| ${arm.id} | ${cell?.runs ?? 0} | ${cell ? pct(cell.taskCompletionRate) : "—"} | ${cell ? pct(cell.offloadPrecision) : "—"} | ${cell ? Math.round(cell.avgTokens) : "—"} | ${cell && Number.isFinite(cell.efficiencyScore) ? Math.round(cell.efficiencyScore) : "—"} |`;
    }),
    "",
    "## 2. Development A",
    "",
    "| arm | runs | completed | unnecessary | avgTokens |",
    "|---|---:|---:|---:|---:|",
    ...R7_ARMS.map((arm) => {
      const cell = byKey.get(`${arm.id}/A`);
      return `| ${arm.id} | ${cell?.runs ?? 0} | ${cell ? pct(cell.taskCompletionRate) : "—"} | ${cell ? pct(cell.unnecessaryOffloadRate) : "—"} | ${cell ? Math.round(cell.avgTokens) : "—"} |`;
    }),
    "",
    "## 3. Development 预注册决策",
    "",
    `- eligible=${development.eligibleArmIds.join(",") || "无"}`,
    `- winner=${development.winnerArmId ?? "无"}`,
    `- conclusion=${development.conclusion}`,
    `- P0 efficiency=${Number.isFinite(development.positiveControlEfficiency) ? Math.round(development.positiveControlEfficiency) : "∞"}`,
    "",
    "## 4. Holdout H",
    "",
    holdoutText,
    "",
    "## 5. Prompt overfit audit",
    "",
    "| arm | forbiddenHits | longestCommonSubstring |",
    "|---|---|---:|",
    ...auditLines,
    "",
    "## 6. 备注",
    "",
    "- 本报告由 `src/experiments/r7FinalReport.ts` 自动生成；",
    "- 决策阈值来自 `src/experiments/r7Decision.ts`（预注册）；",
    "- 修改任何阈值/文案必须重跑对应批次。",
    "",
  ].join("\n");

  const outPath = path.join(path.dirname(path.resolve(REPO_ROOT, paths[0]!)), "final-report.md");
  fs.writeFileSync(outPath, markdown);
  console.log(markdown);
  console.log(`\n[report] ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
