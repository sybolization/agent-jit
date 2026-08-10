import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { PiRuntime } from "../llm/gateway.js";

/**
 * 共享的 Agent 运行辅助：把 pi-agent-core `Agent` 的一次 prompt 跑完，
 * 并统一采集实验需要的测量数据（轮数 / tokens / 工具调用序列 / 最终文本 / 截断标记）。
 *
 * 用途：R5（Autonomous Offloading）与 hybrid benchmark 共用——
 * 工具调用循环由 Agent 负责（普通工具与 jit_* 工具都是 AgentTool），
 * 实验 harness 只做观测，不再对任何工具做特殊 dispatch。
 */

export interface AgentToolCallRecord {
  toolCallId: string;
  name: string;
  isError: boolean;
  /** 该工具调用发生在第几轮（1-based；tool_execution_start 时当前 turn 尚未 +1，故用 turns+1） */
  round: number;
  /** 工具调用的参数（实验观测用，随 toolTimeline 落盘，供 offload 时机分析） */
  arguments: Record<string, unknown>;
}

export interface PiAgentRunOptions {
  systemPrompt: string;
  tools: readonly AgentTool<any>[];
  prompt: string;
  runtime: PiRuntime;
  maxRounds?: number;
  /** 工具调用开始时回调（日志 / 计数）。 */
  onToolCall?: (call: { toolCallId: string; name: string; arguments: Record<string, unknown> }) => void;
  /** 工具执行结束时回调（result 含 details，供 jit_execute_program 的程序/图采集）。 */
  onToolEnd?: (record: { toolCallId: string; name: string; isError: boolean; result: unknown }) => void;
}

export interface PiAgentRunResult {
  /** turn 数（一次 LLM 调用 + 其工具执行为一个 turn） */
  rounds: number;
  tokens: { input: number; output: number; cacheRead: number; total: number };
  latencyMs: number;
  /** 工具调用记录（按首次出现顺序；isError 在执行结束时回填） */
  toolCalls: readonly AgentToolCallRecord[];
  /** 最后一个不带 toolCall 的 assistant 文本（最终答复；截断时可能为空串） */
  finalText: string;
  /** 最后一轮 assistant 仍带 toolCall → 被 maxRounds 截断 */
  maxedOut: boolean;
  /** Agent 运行期的错误（模型调用失败等），无则 undefined */
  error?: string;
}

export async function runPiAgent(options: PiAgentRunOptions): Promise<PiAgentRunResult> {
  const { systemPrompt, tools, prompt, runtime, maxRounds = 10, onToolCall, onToolEnd } = options;

  let turns = 0;
  const toolCallOrder: string[] = [];
  const toolCallById = new Map<string, AgentToolCallRecord>();
  let finalText = "";
  let lastAssistantHasToolCalls = false;
  const tokens = { input: 0, output: 0, cacheRead: 0, total: 0 };
  let error: string | undefined;

  const started = performance.now();

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: runtime.model,
      tools: [...tools],
    },
    streamFn: runtime.streamFn,
    shouldStopAfterTurn: () => turns >= maxRounds,
  });

  agent.subscribe(async (event) => {
    switch (event.type) {
      case "turn_end":
        turns += 1;
        break;
      case "tool_execution_start": {
        if (!toolCallById.has(event.toolCallId)) {
          toolCallById.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: false,
            round: turns + 1,
            arguments: event.args as Record<string, unknown>,
          });
          toolCallOrder.push(event.toolCallId);
        }
        onToolCall?.({ toolCallId: event.toolCallId, name: event.toolName, arguments: event.args as Record<string, unknown> });
        break;
      }
      case "tool_execution_end": {
        const record = toolCallById.get(event.toolCallId);
        if (record) record.isError = event.isError;
        onToolEnd?.({ toolCallId: event.toolCallId, name: event.toolName, isError: event.isError, result: event.result });
        break;
      }
      case "agent_end": {
        for (const message of event.messages) {
          if (message.role !== "assistant") continue;
          tokens.input += message.usage.input ?? 0;
          tokens.output += message.usage.output ?? 0;
          tokens.cacheRead += message.usage.cacheRead ?? 0;
          tokens.total += message.usage.totalTokens ?? 0;
          const hasToolCalls = message.content.some((block) => block.type === "toolCall");
          lastAssistantHasToolCalls = hasToolCalls;
          if (!hasToolCalls) {
            const text = message.content
              .filter((block): block is { type: "text"; text: string } => block.type === "text")
              .map((block) => block.text)
              .join("");
            if (text.trim()) finalText = text;
          }
        }
        break;
      }
    }
  });

  await agent.prompt(prompt);
  if (agent.state.errorMessage) error = agent.state.errorMessage;

  return {
    rounds: turns,
    tokens,
    latencyMs: Math.round(performance.now() - started),
    toolCalls: toolCallOrder.map((id) => toolCallById.get(id)!),
    finalText,
    maxedOut: lastAssistantHasToolCalls,
    ...(error !== undefined ? { error } : {}),
  };
}
