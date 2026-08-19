#!/usr/bin/env node

/**
 * R7 progress viewer (read-only). Latest report by default, or pass a report path.
 * Does not write decision.json.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeR7Runs } from "./r7AnalyzeReport.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

function findLatestReport(): string | undefined {
  const root = path.join(REPO_ROOT, "logs", "experiments");
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs.readdirSync(root).filter((name) => name.startsWith("r7-routing-")).sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const candidate = path.join(root, dirs[i]!, "report.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function main(): void {
  const arg = process.argv[2];
  const reportPath = arg === undefined ? findLatestReport() : path.resolve(REPO_ROOT, arg);
  if (reportPath === undefined || !fs.existsSync(reportPath)) {
    console.error("未找到 R7 report.json");
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    mode?: string;
    runs?: Array<{ r7Arm?: string }>;
  };
  if (report.mode !== "r7-routing-discovery") {
    console.error(`不是 R7 report：${reportPath}`);
    process.exitCode = 1;
    return;
  }
  const cells = summarizeR7Runs(report.runs as never);
  console.log(`[progress] ${reportPath}`);
  for (const cell of cells.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.armId.localeCompare(b.armId))) {
    console.log(
      `[${cell.armId}/${cell.taskId}] runs=${cell.runs} completed=${(cell.taskCompletionRate * 100).toFixed(0)}% ` +
        `precision=${(cell.offloadPrecision * 100).toFixed(0)}% clean=${((cell.cleanOffloadRate ?? 0) * 100).toFixed(0)}% ` +
        `maxedOut=${((cell.maxedOutRate ?? 0) * 100).toFixed(0)}% repair=${(cell.avgRepairRounds ?? 0).toFixed(1)} ` +
        `rounds=${(cell.avgRounds ?? 0).toFixed(1)} avgTokens=${Math.round(cell.avgTokens)}`,
    );
  }
}

main();
