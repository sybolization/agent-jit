/**
 * R5 run 级指标推导与分格聚合（纯函数，与模型运行解耦，便于单测回归 P0 语义）。
 */

import type {
  R5Aggregate,
  R5Aggregates,
  R5Arm,
  R5JitGroupId,
  R5RunDerivationInput,
  R5RunMetrics,
} from "./types.js";
import type { R5TaskId } from "../r5Tasks.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../../tools/jitTools.js";
import { toolIdAlias } from "../../tools/registry.js";
import { SUBMIT_ANSWER_ID } from "./submitAnswer.js";
import { classifyR5JitGroup } from "./offloadMetrics.js";

function matchesOracle(haystack: string, oracle: readonly (string | RegExp)[]): boolean {
  return oracle.every((needle) =>
    typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack),
  );
}

/** 纯函数：从原始观测推导 R5 run 指标（与模型运行解耦，便于单测回归 P0 语义）。 */
export function deriveR5Metrics(input: R5RunDerivationInput): R5RunMetrics {
  const jitAttempted = input.describeCalls > 0 || input.executeCalls > 0;
  const isJitName = (name: string): boolean =>
    name === DESCRIBE_TOOLS_TOOL.name || name === EXECUTE_PROGRAM_TOOL.name;
  const isSubmit = (name: string): boolean => name === SUBMIT_ANSWER_ID;
  const isBusiness = (name: string): boolean => !isJitName(name) && !isSubmit(name);
  const jitExecutionSucceeded = input.toolTimeline.some(
    (call) => call.name === EXECUTE_PROGRAM_TOOL.name && !call.isError,
  );

  // offload 时机（R5 review 第二轮，round-aware）：按 Agent round 分割业务调用，不再用 timeline
  // 数组位置——同轮并发 describe+业务工具在数组上会落在 JIT 之后而被误判为 fallback。
  // businessCalls 仍按序记录全部业务工具名；三桶分界用 round 与 firstJitRound / lastExecuteRound 比较。
  const firstJitCall = input.toolTimeline.find((call) => isJitName(call.name));
  const firstJitRound = firstJitCall?.round;
  const offloadDecisionRound = firstJitRound;
  const executeCallsInTimeline = input.toolTimeline.filter((call) => call.name === EXECUTE_PROGRAM_TOOL.name);
  const lastExecuteRound =
    executeCallsInTimeline.length > 0 ? executeCallsInTimeline[executeCallsInTimeline.length - 1]!.round : undefined;

  // R6.1 新指标：compile-only / manifest 臂的恢复成本
  // （首次编译是否直接通过、失败→成功的修复轮数、describe 兜底频率、repair 区间的 token 成本）
  //
  // 编译成功 / 执行成功解耦（P0 修复）：jit_execute_program 编译失败与执行失败都会 throw（isError=true），
  // 旧实现 firstPassCompileSuccess = !firstExecuteCall.isError 混淆了两者；有 executeCallPhases（新 run 由
  // runR5Run 按错误文本前缀分类采集）时直接读相位，否则回退旧 isError 口径（legacy 近似，编译/执行不可分）。
  const phases = input.executeCallPhases;
  const firstExecuteCall = executeCallsInTimeline[0];
  const firstPassCompileSuccess =
    phases !== undefined ? phases[0]?.compileSuccess : firstExecuteCall === undefined ? undefined : !firstExecuteCall.isError;
  const firstPassExecutionSuccess = phases !== undefined ? phases[0]?.executionSuccess : firstPassCompileSuccess;
  const compileSucceeded = phases !== undefined ? phases.some((p) => p.compileSuccess) : jitExecutionSucceeded;
  const firstFailedExecuteRound = executeCallsInTimeline.find((call) => call.isError)?.round;
  const firstSuccessExecuteRound = executeCallsInTimeline.find((call) => !call.isError)?.round;
  // R6.1：describe 兜底语义精化——describeFallbackUsed = "首次 execute 失败之后才调 describe"（fallback 指示），
  // 不再是"是否调过 describe"（eager 臂的正常先 describe 流程不再被误判为 fallback）；
  // preDescribeUsed = "describe 发生在首次 execute 之前"（先拿契约再写程序；无 describe 调用 → 省略该字段）。
  const describeAfterFailedExecute = input.toolTimeline.some(
    (call) =>
      call.name === DESCRIBE_TOOLS_TOOL.name && firstFailedExecuteRound !== undefined && call.round > firstFailedExecuteRound,
  );
  const preDescribeUsed = input.toolTimeline.some(
    (call) => call.name === DESCRIBE_TOOLS_TOOL.name && firstExecuteCall !== undefined && call.round < firstExecuteCall.round,
  )
    ? true
    : input.describeCalls > 0
      ? false
      : undefined;
  let repairRounds: number | undefined;
  if (phases !== undefined) {
    // 编译级修复：首次编译失败轮 → 首次编译成功轮（首轮编译通过 → 0；只失败 → 总轮数 − 首次失败轮；无 execute → undefined）
    const firstFailedCompileRound = phases.find((p) => !p.compileSuccess)?.round;
    const firstSuccessCompileRound = phases.find((p) => p.compileSuccess)?.round;
    if (phases.length === 0) repairRounds = undefined;
    else if (firstFailedCompileRound === undefined) repairRounds = 0;
    else if (firstSuccessCompileRound !== undefined) repairRounds = firstSuccessCompileRound - firstFailedCompileRound;
    else repairRounds = input.rounds - firstFailedCompileRound;
  } else if (firstExecuteCall === undefined) repairRounds = undefined;
  else if (firstPassCompileSuccess === true) repairRounds = 0;
  else if (firstSuccessExecuteRound !== undefined && firstFailedExecuteRound !== undefined)
    repairRounds = firstSuccessExecuteRound - firstFailedExecuteRound;
  else if (firstFailedExecuteRound !== undefined) repairRounds = input.rounds - firstFailedExecuteRound;
  let repairTokens: number | undefined;
  if (input.tokenRounds !== undefined) {
    if (phases !== undefined) {
      // repair 区间同样用编译级轮次（首次编译失败轮 .. 首次编译成功轮/末尾）
      const firstFailedCompileRound = phases.find((p) => !p.compileSuccess)?.round;
      if (firstFailedCompileRound !== undefined) {
        const firstSuccessCompileRound = phases.find((p) => p.compileSuccess)?.round;
        const endRound = firstSuccessCompileRound ?? input.rounds;
        repairTokens = input.tokenRounds
          .filter((item) => item.round >= firstFailedCompileRound && item.round <= endRound)
          .reduce((sum, item) => sum + item.total, 0);
      }
    } else if (firstFailedExecuteRound !== undefined) {
      const endRound = firstSuccessExecuteRound ?? input.rounds;
      repairTokens = input.tokenRounds
        .filter((item) => item.round >= firstFailedExecuteRound && item.round <= endRound)
        .reduce((sum, item) => sum + item.total, 0);
    }
  }
  // R6.2 repair cost 三段：首次 compile 前 / repair 区间（= repairTokens）/ 首次成功执行后
  let tokensBeforeFirstCompile: number | undefined;
  let tokensAfterSuccessfulExecution: number | undefined;
  if (input.tokenRounds !== undefined) {
    const firstExecuteRound = executeCallsInTimeline[0]?.round;
    if (firstExecuteRound !== undefined) {
      tokensBeforeFirstCompile = input.tokenRounds
        .filter((item) => item.round < firstExecuteRound)
        .reduce((sum, item) => sum + item.total, 0);
    }
    if (firstSuccessExecuteRound !== undefined) {
      tokensAfterSuccessfulExecution = input.tokenRounds
        .filter((item) => item.round > firstSuccessExecuteRound)
        .reduce((sum, item) => sum + item.total, 0);
    }
  }
  const preOffloadBusinessCalls =
    firstJitRound === undefined
      ? []
      : input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round < firstJitRound)
          .map((call) => call.name);
  const sameRoundBusinessCalls =
    firstJitRound === undefined
      ? []
      : input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round === firstJitRound)
          .map((call) => call.name);
  const postExecuteBusinessCalls =
    lastExecuteRound === undefined
      ? []
      : input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round > lastExecuteRound)
          .map((call) => call.name);
  const fallbackUsed = postExecuteBusinessCalls.length > 0;

  // B 型：round < firstJitRound 已执行掉的、本可 offload 的流水线调用（preOffload 业务调用 ∩ pipeline 工具）。
  // pipelineToolIds 是 canonical id，toolTimeline 记录的是 host alias 名，需转换后比对。
  const pipelineAliases = new Set((input.pipelineToolIds ?? []).map(toolIdAlias));
  const preOffloadPipelineCalls =
    firstJitRound !== undefined && input.pipelineToolIds && input.pipelineToolIds.length > 0
      ? input.toolTimeline.filter(
          (call) => isBusiness(call.name) && call.round < firstJitRound && pipelineAliases.has(call.name),
        ).length
      : undefined;

  // 同轮 speculative：与第一次 JIT 决策同一轮并发发出的、本可 offload 的流水线调用
  // （模型尚未看到任何 JIT 结果；B 型）。
  const sameRoundPipelineCalls =
    firstJitRound !== undefined && input.pipelineToolIds && input.pipelineToolIds.length > 0
      ? input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round === firstJitRound && pipelineAliases.has(call.name))
          .map((call) => call.name)
      : undefined;
  // JIT 真正开始前（决策前 + 同轮）的重复工作量：真 clean 必须 preExecutePipelineCalls === 0
  const preExecutePipelineCalls =
    preOffloadPipelineCalls !== undefined && sameRoundPipelineCalls !== undefined
      ? preOffloadPipelineCalls + sameRoundPipelineCalls.length
      : undefined;
  // 决策时间维度（与语义解耦）：JIT 意图出现得早 = 决策轮之前没有执行掉本可 offload 的流水线工作
  const earlyOffloadDecision =
    input.taskId === "B" && preOffloadPipelineCalls !== undefined
      ? jitAttempted && preOffloadPipelineCalls === 0
      : undefined;
  // 重复工作：JIT source 里重新执行的、host 在第一次 JIT 调用（含同轮）前已完成的 pipeline 工具
  const duplicatedPipelineCalls =
    input.taskId === "B" &&
    firstJitRound !== undefined &&
    input.pipelineToolIds &&
    input.pipelineToolIds.length > 0 &&
    input.lastProgramSource
      ? input.pipelineToolIds.filter(
          (canonical) =>
            input.lastProgramSource!.includes(canonical) &&
            input.toolTimeline.some(
              (call) => isBusiness(call.name) && call.round <= firstJitRound && toolIdAlias(canonical) === call.name,
            ),
        ).length
      : undefined;

  // P0 严格输出协议：答案正确性**只认模型显式提交的 submit_answer**。
  // 未提交 → 不判正确（不再退回 finalText）；程序 result 永不参与答案判定。
  const answerCorrect =
    input.submittedAnswer !== undefined && matchesOracle(input.submittedAnswer, input.oracle);

  // P0 严格语义（review 第二版）：
  // - jitSemanticCorrect === undefined（未执行成功 / A 型无 spec 可判）**不视为完成**，
  //   必须 jitSemanticCorrect === true（程序语义正确）或成功 fallback（改用普通工具补救）才算过；
  // - dslCorrect=false 的 run 必须 fail（错误程序 result 即使包含目标 repo 名也不作数）。
  const taskCompleted =
    answerCorrect && (!jitAttempted || input.jitSemanticCorrect === true || fallbackUsed);

  // JIT 独立完成：尝试 + 语义正确 + 无 fallback（"用对了"的完成级，区别于 adoption 的"想用"）
  const jitFinishedWithoutFallback = jitAttempted && input.jitSemanticCorrect === true && !fallbackUsed;

  // 及时 offload：不做全局固定阈值——B 的整个 pipeline 都可 offload，故要求决定时
  // preOffloadPipelineCalls === 0（还没有执行掉任何本可 offload 的工作）且这次 offload 语义正确；
  // A/C 的语义阶段必须执行，无统一 pipeline 定义 → undefined。
  const timelyOffload =
    input.taskId === "B" && preOffloadPipelineCalls !== undefined
      ? jitAttempted && input.jitSemanticCorrect === true && preOffloadPipelineCalls === 0
      : undefined;

  return {
    arm: input.arm,
    taskId: input.taskId,
    rounds: input.rounds,
    maxedOut: input.maxedOut,
    tokens: input.tokens,
    ...(input.tokenRounds !== undefined ? { tokenRounds: input.tokenRounds } : {}),
    latencyMs: input.latencyMs,
    toolTimeline: input.toolTimeline,
    businessCalls: input.businessCalls,
    describeCalls: input.describeCalls,
    executeCalls: input.executeCalls,
    compileAttempts: input.executeCalls,
    ...(firstPassCompileSuccess !== undefined ? { firstPassCompileSuccess } : {}),
    ...(firstPassExecutionSuccess !== undefined ? { firstPassExecutionSuccess } : {}),
    ...(compileSucceeded !== undefined ? { compileSucceeded } : {}),
    ...(phases !== undefined && phases.length > 0 ? { executeCallPhases: phases } : {}),
    ...(repairRounds !== undefined ? { repairRounds } : {}),
    describeFallbackUsed: describeAfterFailedExecute,
    ...(preDescribeUsed !== undefined ? { preDescribeUsed } : {}),
    ...(repairTokens !== undefined ? { repairTokens } : {}),
    ...(tokensBeforeFirstCompile !== undefined ? { tokensBeforeFirstCompile } : {}),
    ...(repairTokens !== undefined ? { tokensInRepairRounds: repairTokens } : {}),
    ...(tokensAfterSuccessfulExecution !== undefined ? { tokensAfterSuccessfulExecution } : {}),
    jitAttempted,
    jitExecutionSucceeded,
    jitSemanticCorrect: input.jitSemanticCorrect,
    jitFinishedWithoutFallback,
    fallbackUsed,
    ...(offloadDecisionRound !== undefined ? { offloadDecisionRound } : {}),
    preOffloadBusinessCalls,
    preOffloadBusinessCallCount: preOffloadBusinessCalls.length,
    sameRoundBusinessCalls,
    sameRoundBusinessCallCount: sameRoundBusinessCalls.length,
    postExecuteBusinessCalls,
    postExecuteBusinessCallCount: postExecuteBusinessCalls.length,
    ...(preOffloadPipelineCalls !== undefined ? { preOffloadPipelineCalls } : {}),
    ...(sameRoundPipelineCalls !== undefined
      ? { sameRoundPipelineCalls, sameRoundPipelineCallCount: sameRoundPipelineCalls.length }
      : {}),
    ...(preExecutePipelineCalls !== undefined ? { preExecutePipelineCalls } : {}),
    ...(earlyOffloadDecision !== undefined ? { earlyOffloadDecision } : {}),
    ...(duplicatedPipelineCalls !== undefined ? { duplicatedPipelineCalls } : {}),
    timelyOffload,
    ...(input.submittedAnswer !== undefined ? { submittedAnswer: input.submittedAnswer } : {}),
    answerCorrect,
    taskCompleted,
    ...(input.executeErrors.length > 0 ? { executeErrors: input.executeErrors } : {}),
    finalText: input.finalText,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

export function aggregateR5(runs: readonly R5RunMetrics[], arm: R5Arm, taskId: R5TaskId): R5Aggregate {
  const cell = runs.filter((run) => run.arm === arm && run.taskId === taskId);
  const total = cell.length;
  const ratio = (n: number): number => (total > 0 ? n / total : 0);
  const attempted = cell.filter((run) => run.jitAttempted).length;
  const attemptedCorrect = cell.filter((run) => run.jitAttempted && run.jitSemanticCorrect === true).length;
  const compressedOps = cell
    .filter((run) => run.lastProgram?.compressed)
    .map((run) => run.lastProgram!.compressed!.atomicOps);
  const correctlyCompressedOps = cell
    .map((run) => run.lastProgram?.correctlyCompressedOps)
    .filter((value): value is number => value !== undefined);
  const avg = (values: number[]): number => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const decisionRounds = cell
    .map((run) => run.offloadDecisionRound)
    .filter((value): value is number => value !== undefined);
  const preOffloadPipelineValues = cell
    .map((run) => run.preOffloadPipelineCalls)
    .filter((value): value is number => value !== undefined);
  const sameRoundPipelineValues = cell
    .map((run) => run.sameRoundPipelineCallCount)
    .filter((value): value is number => value !== undefined);
  const preExecutePipelineValues = cell
    .map((run) => run.preExecutePipelineCalls)
    .filter((value): value is number => value !== undefined);
  const groupCounts: Record<R5JitGroupId, number> = { cleanOffload: 0, earlyDirtyOffload: 0, lateOffload: 0, noJit: 0 };
  for (const run of cell) groupCounts[classifyR5JitGroup(run)] += 1;
  const duplicatedPipelineValues = cell
    .map((run) => run.duplicatedPipelineCalls)
    .filter((value): value is number => value !== undefined);
  // R6.1：compile-only / manifest 臂的汇总（repair 指标只统计有定义值的 run）
  const repairRoundsValues = cell
    .map((run) => run.repairRounds)
    .filter((value): value is number => value !== undefined);
  const repairTokenValues = cell
    .map((run) => run.repairTokens)
    .filter((value): value is number => value !== undefined);
  // R6.1：尝试过 compile 的 run 数（firstPassCompileRateAmongAttempts 的分母；executeCalls > 0）
  const compileAttemptRuns = cell.filter((run) => run.executeCalls > 0).length;
  // R6.2：新聚合指标（编译尝试 / 延迟 / 首轮语义成功 / 编译错误分类占比）
  const compileAttemptValues = cell
    .map((run) => run.compileAttempts)
    .filter((value): value is number => value !== undefined);
  const latencyValues = cell.map((run) => run.latencyMs);
  let outputContractTotal = 0;
  let syntaxCompletenessTotal = 0;
  let otherTotal = 0;
  for (const run of cell) {
    const breakdown = run.compileErrorBreakdown;
    if (!breakdown) continue;
    outputContractTotal += breakdown.outputContractRelated;
    syntaxCompletenessTotal += breakdown.syntaxOrCompleteness;
    otherTotal += breakdown.other;
  }
  const compileErrorTotal = outputContractTotal + syntaxCompletenessTotal + otherTotal;
  return {
    arm,
    taskId,
    runs: total,
    adoptionRate: ratio(attempted),
    jitExecutionSucceededRate: ratio(cell.filter((run) => run.jitExecutionSucceeded).length),
    jitSemanticCorrectRate: ratio(cell.filter((run) => run.jitSemanticCorrect === true).length),
    jitFinishedWithoutFallbackRate: ratio(cell.filter((run) => run.jitFinishedWithoutFallback).length),
    // P1 review：真 precision = 语义正确 / 尝试过（数学意义与名字一致）
    offloadPrecision: attempted > 0 ? attemptedCorrect / attempted : 0,
    avgOffloadDecisionRound: avg(decisionRounds),
    avgPreOffloadBusinessCallCount: avg(cell.map((run) => run.preOffloadBusinessCallCount)),
    avgSameRoundBusinessCallCount: avg(cell.map((run) => run.sameRoundBusinessCallCount)),
    avgPostExecuteBusinessCallCount: avg(cell.map((run) => run.postExecuteBusinessCallCount)),
    // 无 pipeline 定义（A/C）→ undefined，不入 JSON
    avgPreOffloadPipelineCalls:
      preOffloadPipelineValues.length > 0 ? avg(preOffloadPipelineValues) : undefined,
    avgSameRoundPipelineCalls: sameRoundPipelineValues.length > 0 ? avg(sameRoundPipelineValues) : undefined,
    avgPreExecutePipelineCalls: preExecutePipelineValues.length > 0 ? avg(preExecutePipelineValues) : undefined,
    earlyOffloadDecisionRate: taskId === "B" ? ratio(cell.filter((run) => run.earlyOffloadDecision === true).length) : undefined,
    timelyOffloadRate: taskId === "B" ? ratio(cell.filter((run) => run.timelyOffload === true).length) : undefined,
    unnecessaryOffloadRate: taskId === "A" ? ratio(attempted) : undefined,
    cleanOffloadRate: ratio(groupCounts.cleanOffload),
    earlyDirtyOffloadRate: ratio(groupCounts.earlyDirtyOffload),
    lateOffloadRate: ratio(groupCounts.lateOffload),
    noJitRate: ratio(groupCounts.noJit),
    avgDuplicatedPipelineCalls: duplicatedPipelineValues.length > 0 ? avg(duplicatedPipelineValues) : undefined,
    fallbackRate: ratio(cell.filter((run) => run.fallbackUsed).length),
    maxedOutRate: ratio(cell.filter((run) => run.maxedOut).length),
    taskCompletionRate: ratio(cell.filter((run) => run.taskCompleted).length),
    avgCompressedOps: avg(compressedOps),
    avgCorrectlyCompressedOps: avg(correctlyCompressedOps),
    avgRounds: avg(cell.map((run) => run.rounds)),
    avgTokens: avg(cell.map((run) => run.tokens.total)),
    avgUncachedInputTokens: avg(cell.map((run) => run.tokens.input)),
    avgCacheReadTokens: avg(cell.map((run) => run.tokens.cacheRead)),
    avgOutputTokens: avg(cell.map((run) => run.tokens.output)),
    // R6.1：compile-only / manifest 臂的汇总（编译/执行解耦：eventualCompileRate 不再等于 jitExecutionSucceededRate）
    firstPassCompileRateOverall: ratio(cell.filter((run) => run.firstPassCompileSuccess === true).length),
    firstPassCompileRateAmongAttempts: compileAttemptRuns > 0
      ? cell.filter((run) => run.firstPassCompileSuccess === true).length / compileAttemptRuns
      : 0,
    firstPassExecutionRate: ratio(cell.filter((run) => run.firstPassExecutionSuccess === true).length),
    eventualExecutionRate: ratio(cell.filter((run) => run.jitExecutionSucceeded).length),
    eventualSemanticCorrectRate: ratio(cell.filter((run) => run.jitSemanticCorrect === true).length),
    eventualCompileRate: ratio(cell.filter((run) => run.compileSucceeded === true).length),
    avgRepairRounds: avg(repairRoundsValues),
    describeFallbackRate: ratio(cell.filter((run) => run.describeFallbackUsed).length),
    preDescribeUsedRate: ratio(cell.filter((run) => run.preDescribeUsed === true).length),
    avgRepairTokens: repairTokenValues.length > 0 ? avg(repairTokenValues) : undefined,
    avgCompileAttempts: avg(compileAttemptValues),
    avgLatencyMs: avg(latencyValues),
    firstPassSemanticSuccessRate: ratio(cell.filter((run) => run.firstPassSemanticSuccess === true).length),
    outputContractErrorRate: compileErrorTotal > 0 ? outputContractTotal / compileErrorTotal : 0,
    syntaxCompletenessErrorRate: compileErrorTotal > 0 ? syntaxCompletenessTotal / compileErrorTotal : 0,
  };
}

export function buildR5Aggregates(runs: readonly R5RunMetrics[]): R5Aggregates {
  return {
    control: {
      A: aggregateR5(runs, "control", "A"),
      B: aggregateR5(runs, "control", "B"),
      C: aggregateR5(runs, "control", "C"),
    },
    treatment: {
      A: aggregateR5(runs, "treatment", "A"),
      B: aggregateR5(runs, "treatment", "B"),
      C: aggregateR5(runs, "treatment", "C"),
    },
  };
}
