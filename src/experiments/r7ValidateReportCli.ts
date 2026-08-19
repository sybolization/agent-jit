#!/usr/bin/env node

/** R7 report 完整性校验 CLI：`npx tsx src/experiments/r7ValidateReportCli.ts <report.json> ...` */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateR7Report, type R7ReportLike } from "./r7ValidateReport.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("用法：npx tsx src/experiments/r7ValidateReportCli.ts <report.json> ...");
    process.exitCode = 1;
    return;
  }
  let allValid = true;
  for (const raw of paths) {
    const reportPath = path.resolve(REPO_ROOT, raw);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as R7ReportLike;
    const result = validateR7Report(report);
    console.log(`${result.valid ? "✓" : "✗"} ${reportPath}`);
    for (const issue of result.issues) console.log(`  [${issue.severity}] ${issue.message}`);
    if (!result.valid) allValid = false;
  }
  if (!allValid) process.exitCode = 1;
}

main();
