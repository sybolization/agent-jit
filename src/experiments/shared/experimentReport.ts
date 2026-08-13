/**
 * 结果落盘：logs/experiments/r5-offloading-<ts>/report.json（与 r4e 等实验约定一致，
 * logs/ 纳入版本控制——实验可复现性要求保留原始 report.json）。
 */

import fs from "node:fs";
import path from "node:path";

import type { R5Aggregates, R5ReportConfig, R5RunMetrics } from "./types.js";
import type { R5Task } from "../r5Tasks.js";
import { buildAllR5JitGroups } from "./offloadMetrics.js";

/**
 * 把一次 R5 实验的结果完整写入 report.json：
 * 配置 + 任务元数据（prompt / oracle）+ 每个 run 的全部指标 + arm×task 分格汇总。
 * 返回 report.json 的绝对路径。
 */
export function writeR5Report(
  outDir: string,
  config: R5ReportConfig,
  tasks: readonly R5Task[],
  runs: readonly R5RunMetrics[],
  aggregates: R5Aggregates,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r5-autonomous-offloading",
        config,
        model: "deepseek-v4-flash",
        timestamp: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          prompt: task.prompt,
          oracle: task.oracle.map(String),
        })),
        aggregates,
        jitGroups: buildAllR5JitGroups(runs),
        runs,
      },
      null,
      2,
    )}\n`,
  );
  return reportPath;
}
