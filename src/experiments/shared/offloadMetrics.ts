/**
 * Offload 度量：compressed path length（一次 JIT 执行替代了多少原子操作）与
 * clean / late JIT 分组（token 花在干净 offload 还是 late offload / 没 offload）。
 */

import type { CompressedPath, R5Arm, R5JitGroup, R5JitGroupId, R5JitGroups, R5RunMetrics } from "./types.js";
import type { ExecutionGraph } from "../../compiler/ir.js";
import type { TraceEntry } from "../../runtime/trace.js";
import type { R5TaskId } from "../r5Tasks.js";

// ---------------------------------------------------------------------------
// compressed path length：一次 JIT 执行替代了多少原子操作
// ---------------------------------------------------------------------------

export function compressedPath(graph: ExecutionGraph, trace: readonly TraceEntry[]): CompressedPath {
  let toolNodes = 0;
  let mapNodes = 0;
  let computeNodes = 0;
  let mergeNodes = 0;
  let concatNodes = 0;
  let returnNodes = 0;
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "tool":
        toolNodes += 1;
        break;
      case "map":
        mapNodes += 1;
        break;
      case "compute":
        computeNodes += 1;
        break;
      case "join":
        mergeNodes += 1;
        break;
      case "concat":
        concatNodes += 1;
        break;
      case "return":
        returnNodes += 1;
        break;
    }
  }
  const fanoutSum = trace.filter((entry) => entry.kind === "map").reduce((sum, entry) => sum + (entry.fanout ?? 0), 0);
  return {
    toolNodes,
    mapNodes,
    fanoutSum,
    computeNodes,
    mergeNodes,
    concatNodes,
    returnNodes,
    atomicOps: toolNodes + fanoutSum + computeNodes + mergeNodes + concatNodes + returnNodes,
  };
}

// ---------------------------------------------------------------------------
// clean / late JIT 分组：token 花在干净 offload 还是 late offload / 没 offload
// ---------------------------------------------------------------------------

/**
 * 按 offload 质量分组（不重不漏，每个 run 恰属一组）：
 * - noJit：未尝试 JIT；
 * - lateOffload：决策晚（earlyOffloadDecision === false，即决策轮之前已执行掉本可 offload 的流水线工作）；
 * - cleanOffload：严格干净 = jitFinishedWithoutFallback 且 preExecutePipelineCalls === 0
 *   （决策前 + 同轮都没有执行掉本可 offload 的流水线工作；A/C 无 pipeline 定义时保持旧 clean 语义）；
 * - earlyDirtyOffload：决策早但执行边界不干净（同轮 speculative pipeline / 语义错 / fallback）。
 * token 分项统计基于 run 级 tokens（老报告无 tokenRounds 也可用）。
 */
/** 单个 run 的 offload 分组判定（不重不漏；buildR5JitGroups 与 r5TokenProfile 共用）。 */
export function classifyR5JitGroup(run: R5RunMetrics): R5JitGroupId {
  if (!run.jitAttempted) return "noJit";
  if (run.earlyOffloadDecision === false) return "lateOffload";
  if (
    run.jitFinishedWithoutFallback &&
    (run.preExecutePipelineCalls === undefined || run.preExecutePipelineCalls === 0)
  ) {
    return "cleanOffload";
  }
  return "earlyDirtyOffload";
}

export function buildR5JitGroups(
  runs: readonly R5RunMetrics[],
  arm: R5Arm,
  taskId: R5TaskId,
): R5JitGroup[] {
  const cell = runs.filter((run) => run.arm === arm && run.taskId === taskId);
  const buckets: Record<R5JitGroupId, R5RunMetrics[]> = {
    cleanOffload: [],
    earlyDirtyOffload: [],
    lateOffload: [],
    noJit: [],
  };
  for (const run of cell) {
    buckets[classifyR5JitGroup(run)].push(run);
  }
  const avg = (bucket: readonly R5RunMetrics[], pick: (run: R5RunMetrics) => number): number =>
    bucket.length > 0 ? bucket.reduce((sum, run) => sum + pick(run), 0) / bucket.length : 0;
  const ids: R5JitGroupId[] = ["cleanOffload", "earlyDirtyOffload", "lateOffload", "noJit"];
  return ids.map((group) => {
    const bucket = buckets[group];
    return {
      group,
      runs: bucket.length,
      avgTokens: avg(bucket, (run) => run.tokens.total),
      avgUncachedInput: avg(bucket, (run) => run.tokens.input),
      avgCacheRead: avg(bucket, (run) => run.tokens.cacheRead),
      avgOutput: avg(bucket, (run) => run.tokens.output),
      avgRounds: avg(bucket, (run) => run.rounds),
    };
  });
}

export function buildAllR5JitGroups(runs: readonly R5RunMetrics[]): R5JitGroups {
  return {
    control: {
      A: buildR5JitGroups(runs, "control", "A"),
      B: buildR5JitGroups(runs, "control", "B"),
      C: buildR5JitGroups(runs, "control", "C"),
    },
    treatment: {
      A: buildR5JitGroups(runs, "treatment", "A"),
      B: buildR5JitGroups(runs, "treatment", "B"),
      C: buildR5JitGroups(runs, "treatment", "C"),
    },
  };
}
