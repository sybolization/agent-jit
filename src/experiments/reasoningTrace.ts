import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";
import type { AgentReasoningTurn } from "./agentRunner.js";

/**
 * reasoning ↔ tool timeline 的时间对齐（R5.1 reasoning observation）。
 *
 * 用途：把每轮 assistant 的 reasoning（CoT）与工具调用时间线对齐，标出该轮
 * 处于 Agent JIT 决策流程的哪个阶段（before-jit / jit-decision / after-describe /
 * jit-execute / after-execute），供离线分析 offload 时机（何时决定程序化、何时真正执行）。
 *
 * 注意：这是纯时间对齐——只按工具名（jit_describe_tools / jit_execute_program）驱动
 * 状态机，不分析模型意图、不调用 LLM、无副作用。
 */

/** 单轮 reasoning 在 JIT 决策流程中所处的阶段。 */
export type ReasoningPhase =
  | "before-jit" // 尚未出现任何 JIT 调用
  | "jit-decision" // 本轮含 describe（决策 offload）
  | "after-describe" // describe 已发生但尚未 execute
  | "jit-execute" // 本轮含 execute
  | "after-execute"; // execute 已发生

/** 对齐后的单轮记录：原 reasoning 信息 + 本轮工具名列表 + 阶段。 */
export interface ReasoningTraceEntry {
  round: number;
  reasoning: string;
  toolCalls: readonly string[];
  phase: ReasoningPhase;
}

/**
 * raw CoT traces 的诊断元数据（写进 traces.jsonl 首行，供审计运行配置）。
 *
 * - reasoningMode：thinking-blocks = provider 返回真正的 thinking block（CoT 原文）；
 *   none = 未开启 reasoning（reasoning 观测为空串，规划信号在 text）。
 * - thinkingLevel：开启 reasoning 时的 Agent thinking level（pi-agent-core 语义）。
 */
export interface ReasoningTraceMeta {
  modelId: string;
  reasoningMode: "thinking-blocks" | "none";
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * 逐轮（round 升序）把 reasoningTurns 与工具调用记录对齐。
 *
 * 工具记录按 round 分组作为本轮工具名的权威来源（保持输入顺序）；
 * 每条 assistant reasoning turn 对应一个 round。phase 判定优先级：
 * 本轮含 execute > 本轮含 describe > 未出现过 JIT（before-jit）>
 * describe 已发生未 execute（after-describe）> execute 已发生（after-execute）。
 * 判定完成后再更新 jitCalled / executed 状态（供下一轮使用）。
 *
 * reasoningTurns 为空时返回空数组。
 */
export function alignReasoningTrace(
  reasoningTurns: readonly AgentReasoningTurn[],
  toolCalls: readonly { name: string; round: number }[],
): ReasoningTraceEntry[] {
  const toolsByRound = new Map<number, string[]>();
  for (const call of toolCalls) {
    const names = toolsByRound.get(call.round);
    if (names === undefined) {
      toolsByRound.set(call.round, [call.name]);
    } else {
      names.push(call.name);
    }
  }

  let jitCalled = false;
  let executed = false;
  const trace: ReasoningTraceEntry[] = [];

  for (const turn of reasoningTurns) {
    const names = toolsByRound.get(turn.round) ?? [];
    const hasExecute = names.includes(EXECUTE_PROGRAM_TOOL.name);
    const hasDescribe = names.includes(DESCRIBE_TOOLS_TOOL.name);

    let phase: ReasoningPhase;
    if (hasExecute) {
      phase = "jit-execute";
    } else if (hasDescribe) {
      phase = "jit-decision";
    } else if (!jitCalled) {
      phase = "before-jit";
    } else if (!executed) {
      phase = "after-describe";
    } else {
      phase = "after-execute";
    }

    if (hasExecute || hasDescribe) jitCalled = true;
    if (hasExecute) executed = true;

    trace.push({ round: turn.round, reasoning: turn.reasoning, toolCalls: names, phase });
  }

  return trace;
}
