/**
 * R7 report 完整性校验（纯函数，决策前强制门）。
 *
 * 只检查数据结构与实验协议，不检查模型行为：
 * - mode / config 必须是 r7-routing-discovery；
 * - 每个 arm×task cell 恰好有 config.samples 个 run；
 * - sampleIndex 在 1..samples 且 cell 内不重复；
 * - r7Arm 必须出现在 armDefs；
 * - taskId 必须在 config.task 声明的任务集合内。
 */

export interface R7ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export interface R7ReportLike {
  mode?: string;
  config?: {
    task?: string;
    arms?: unknown;
    samples?: number;
    rounds?: number;
  };
  armDefs?: Array<{ id?: string }>;
  runs?: Array<{
    r7Arm?: string;
    taskId?: string;
    sampleIndex?: number;
  }>;
}

export function validateR7Report(report: R7ReportLike): { valid: boolean; issues: R7ValidationIssue[] } {
  const issues: R7ValidationIssue[] = [];
  if (report.mode !== "r7-routing-discovery") {
    issues.push({ severity: "error", message: `mode 应为 r7-routing-discovery（当前 ${report.mode ?? "unknown"}）` });
    return { valid: false, issues };
  }

  const samples = report.config?.samples;
  if (!Number.isInteger(samples) || (samples ?? 0) <= 0) {
    issues.push({ severity: "error", message: "config.samples 必须是正整数" });
    return { valid: false, issues };
  }
  const expectedSamples = samples as number;

  const declaredTask = report.config?.task;
  const armIds = new Set((report.armDefs ?? []).map((arm) => arm.id).filter((id): id is string => typeof id === "string"));
  if (armIds.size === 0) issues.push({ severity: "error", message: "armDefs 为空" });

  const declaredArms = Array.isArray(report.config?.arms) ? new Set(report.config?.arms as string[]) : armIds;
  const taskIds = new Set((report.runs ?? []).map((run) => run.taskId).filter((id): id is string => typeof id === "string"));
  if (declaredTask !== undefined && declaredTask !== "all") {
    for (const taskId of taskIds) {
      if (taskId !== declaredTask) {
        issues.push({ severity: "error", message: `run.taskId=${taskId} 不在 config.task=${declaredTask}` });
      }
    }
  }

  const expectedTaskIds = declaredTask === undefined || declaredTask === "all" ? taskIds : new Set([declaredTask]);
  const expectedArms = declaredArms.size > 0 ? declaredArms : armIds;
  const seen = new Map<string, Set<number>>();
  const counts = new Map<string, number>();
  for (const run of report.runs ?? []) {
    if (run.r7Arm === undefined || !armIds.has(run.r7Arm)) {
      issues.push({ severity: "error", message: `run 缺少合法 r7Arm：${run.r7Arm ?? "undefined"}` });
      continue;
    }
    if (run.taskId === undefined || !expectedTaskIds.has(run.taskId)) {
      issues.push({ severity: "error", message: `run 缺少合法 taskId：${run.taskId ?? "undefined"}` });
      continue;
    }
    if (!Number.isInteger(run.sampleIndex) || (run.sampleIndex ?? 0) < 1 || (run.sampleIndex ?? 0) > expectedSamples) {
      issues.push({ severity: "error", message: `run 的 sampleIndex 非法：${run.sampleIndex}` });
      continue;
    }
      const sampleIndex = run.sampleIndex as number;
      const key = `${run.r7Arm}/${run.taskId}`;
    const sampleSet = seen.get(key) ?? new Set<number>();
    if (sampleSet.has(sampleIndex)) {
      issues.push({ severity: "error", message: `${key} 重复 sampleIndex=${sampleIndex}` });
    }
    sampleSet.add(sampleIndex);
    seen.set(key, sampleSet);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const arm of expectedArms) {
    for (const task of expectedTaskIds) {
      const key = `${arm}/${task}`;
      const count = counts.get(key) ?? 0;
      if (count !== expectedSamples) {
        issues.push({ severity: "error", message: `${key} 应有 ${samples} 个 run，实际 ${count}` });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
