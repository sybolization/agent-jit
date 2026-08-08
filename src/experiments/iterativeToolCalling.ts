import { Type, type TSchema } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";

import type { ToolDefinition } from "../tools/definition.js";
import type { LlmGateway, LlmMessage, LlmUsage } from "../llm/gateway.js";
import { mapLimit } from "../runtime/executor.js";
import type { RuntimeTool } from "../runtime/runtime.js";

/**
 * Traditional 臂：迭代工具调用 agent loop（R4b benchmark 的对照架构）。
 *
 * `LLM → tool call → 执行 → tool result → LLM` 逐轮，模型决定每一步。
 * 与 DSL 臂（一次 submit_program + deterministic runtime）对比以下指标：
 * - round_trips：complete 调用次数；
 * - model_ingress_bytes：喂给模型的输入字节累计（含历史累积——context 膨胀度量）；
 * - model_egress_bytes：模型输出字节累计；
 * - runtime_internal_bytes：iterative 无 runtime，恒 0（对照 DSL 的中间数据留 runtime）；
 * - exposed_bytes：toolResult JSON 字节累计（R4b 兼容保留）。
 */

/** 单条消息的 UTF-8 字节（assistant 含 toolCall 参数 JSON）。 */
function messageBytes(message: LlmMessage): number {
  switch (message.role) {
    case "system":
    case "user":
      return Buffer.byteLength(message.content, "utf8");
    case "assistant":
      return (
        Buffer.byteLength(message.content, "utf8") +
        (message.toolCalls ?? []).reduce(
          (sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments), "utf8"),
          0,
        )
      );
    case "toolResult":
      return Buffer.byteLength(message.content, "utf8");
  }
}

/** 整个消息列表的 UTF-8 字节（一次 complete 实际送入 context 的数据量）。 */
export function sumMessageBytes(messages: readonly LlmMessage[]): number {
  return messages.reduce((sum, message) => sum + messageBytes(message), 0);
}

export interface IterativeToolResult {
  ok: boolean;
  round_trips: number;
  /** R4b 兼容：toolResult JSON 字节累计 */
  exposed_bytes: number;
  /** 送入模型的输入字节累计（每轮完整 context，含历史——context 膨胀度量） */
  model_ingress_bytes: number;
  /** 模型输出字节累计（content + toolCall 参数） */
  model_egress_bytes: number;
  /** iterative 无 runtime，中间数据全部经模型 → 恒 0 */
  runtime_internal_bytes: number;
  llm_ms: number;
  tool_ms: number;
  e2e_ms: number;
  usage: LlmUsage;
  final_text: string;
  answered: string[];
  task_pass: boolean;
  maxed_out: boolean;
}

/**
 * pi-ai 的 OpenAI 兼容工具名不允许 "."（github.search_repositories 会被静默
 * 丢弃，导致 complete 空返回）。映射为下划线名，prompt/定义/执行三处同步。
 */
export function toPiToolName(specId: string): string {
  return specId.replace(/\./g, "_");
}

/** 把 ToolDefinition 转为 pi-ai 工具定义（typebox 参数 schema，名字经 toPiToolName 映射）。 */
export function toPiTools(specs: readonly ToolDefinition[]): Tool[] {
  return specs.map((spec) => {
    const input = spec.inputSchema as unknown as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    const properties: Record<string, TSchema> = {};
    for (const [key, prop] of Object.entries(input.properties ?? {})) {
      const type = prop.type;
      properties[key] =
        type === "integer"
          ? Type.Integer()
          : type === "number"
            ? Type.Number()
            : type === "boolean"
              ? Type.Boolean()
              : Type.String();
    }
    const required = input.required ?? [];
    return {
      name: toPiToolName(spec.id),
      description: spec.description ?? spec.label,
      parameters: Type.Object(properties, required.length > 0 ? { required } : undefined),
    };
  });
}

/** 从模型文本提取 owner/repo 列表（去重保序）。 */
export function extractFullNames(text: string): string[] {
  // 先剥掉 URL 的协议+域名（https://github.com/owner/repo → /owner/repo），
  // 避免域名段被误提取为 "github.com/owner" 这种伪答案。
  const cleaned = text.replace(/https?:\/\/[\w.-]+/g, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of cleaned.matchAll(/[\w.-]+\/[\w.-]+/g)) {
    const name = match[0] as string;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** 集合匹配：模型答出的 full_name 与 ground truth 交集 ≥ required 即通过（不看顺序）。 */
export function matchAnswer(answered: readonly string[], groundTruth: readonly string[], required: number): boolean {
  const truth = new Set(groundTruth);
  let hit = 0;
  for (const name of answered) {
    if (truth.has(name)) hit += 1;
  }
  return hit >= required;
}

/**
 * 严格答案匹配（R4d）：长度相等 + 逐元素相等 + 顺序一致。
 * 两臂共用同一判定——不再从正文 regex 抽答案。
 */
export function exactAnswerMatch(submitted: readonly string[], groundTruth: readonly string[]): boolean {
  if (submitted.length !== groundTruth.length) return false;
  for (let i = 0; i < submitted.length; i += 1) {
    if (submitted[i] !== groundTruth[i]) return false;
  }
  return true;
}

/** R4d：结构化答案提交工具——模型必须调用它提交最终仓库列表（机器接口，非正文文本）。 */
export const SUBMIT_ANSWER_TOOL: Tool = {
  name: "submit_answer",
  description:
    "提交最终答案。任务完成时调用此工具，把最终前 k 个仓库的完整名称（owner/repo）按排名从高到低放入 repositories 数组；这是唯一被接受的答案提交方式，不要在文本中作答。",
  parameters: Type.Object({
    repositories: Type.Array(Type.String({ description: "按排名从高到低排列的仓库完整名称列表" })),
  }),
};

export interface IterativeOptions {
  gateway: LlmGateway;
  initialMessages: LlmMessage[];
  /** 可执行的运行时工具（真实 adapter 或 mock） */
  tools: readonly RuntimeTool[];
  /** 给模型的工具定义（与 tools 同 id） */
  toolSpecs: readonly ToolDefinition[];
  maxSteps: number;
  groundTruth: readonly string[];
  /** 至少命中 ground truth 中多少个才算通过 */
  required: number;
  /** 连续无工具调用视为结束的轮数（默认 1：给出答案的 no-tool 轮即结束） */
  minConsecutiveNoTool?: number;
  /** R4d：严格答案接口。true 时暴露 submit_answer 工具，模型必须调用它提交 repositories 数组；
   *  未调用 submit_answer（正文作答 / maxed_out）→ answered=[]、task_pass=false。
   *  缺省 false 保持 R4b 的正文 regex 抽取行为。 */
  strictAnswer?: boolean;
}

export async function runIterativeToolCalling(options: IterativeOptions): Promise<IterativeToolResult> {
  const { gateway, initialMessages, tools, toolSpecs, maxSteps, groundTruth, required } = options;
  const minConsecutiveNoTool = options.minConsecutiveNoTool ?? 1;
  const strictAnswer = options.strictAnswer ?? false;

  const piTools = strictAnswer ? [...toPiTools(toolSpecs), SUBMIT_ANSWER_TOOL] : toPiTools(toolSpecs);
  // toolCalls 返回的是映射名（github_search_repositories），按映射名建键反查
  const toolById = new Map(tools.map((tool) => [toPiToolName(tool.id), tool]));

  const messages: LlmMessage[] = [...initialMessages];
  const usage: LlmUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const started = performance.now();
  let llmMs = 0;
  let toolMs = 0;
  let exposedBytes = 0;
  let modelIngressBytes = 0;
  let modelEgressBytes = 0;
  let roundTrips = 0;
  let consecutiveNoTool = 0;
  let finalText = "";
  let answered: string[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    // 每轮把完整 context（含历史 toolResult）送入模型 —— 累计即 context 膨胀度量
    modelIngressBytes += sumMessageBytes(messages);
    const t0 = performance.now();
    const { content, toolCalls, usage: turnUsage } = await gateway.complete(messages, { tools: piTools });
    llmMs += performance.now() - t0;
    roundTrips += 1;
    modelEgressBytes +=
      Buffer.byteLength(content, "utf8") +
      toolCalls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments), "utf8"), 0);
    usage.input += turnUsage.input;
    usage.output += turnUsage.output;
    usage.cacheRead += turnUsage.cacheRead;
    usage.totalTokens += turnUsage.totalTokens;

    finalText = content;
    messages.push({ role: "assistant", content, toolCalls });

    // R4d 严格答案：模型调用 submit_answer 即终止（不执行同轮其他 tool call），按精确匹配判定
    if (strictAnswer) {
      const submit = toolCalls.find((call) => call.name === "submit_answer");
      if (submit) {
        const args = (submit.arguments ?? {}) as { repositories?: unknown };
        answered = Array.isArray(args.repositories)
          ? args.repositories.filter((item): item is string => typeof item === "string")
          : [];
        return {
          ok: true,
          round_trips: roundTrips,
          exposed_bytes: exposedBytes,
          model_ingress_bytes: modelIngressBytes,
          model_egress_bytes: modelEgressBytes,
          runtime_internal_bytes: 0,
          llm_ms: llmMs,
          tool_ms: toolMs,
          e2e_ms: performance.now() - started,
          usage,
          final_text: finalText,
          answered,
          task_pass: exactAnswerMatch(answered, groundTruth),
          maxed_out: false,
        };
      }
    }

    if (toolCalls.length === 0) {
      consecutiveNoTool += 1;
      if (consecutiveNoTool >= minConsecutiveNoTool) {
        // 严格答案：正文作答不算提交 → answered=[]（不 rescue）
        answered = strictAnswer ? [] : extractFullNames(finalText);
        return {
          ok: true,
          round_trips: roundTrips,
          exposed_bytes: exposedBytes,
          model_ingress_bytes: modelIngressBytes,
          model_egress_bytes: modelEgressBytes,
          runtime_internal_bytes: 0,
          llm_ms: llmMs,
          tool_ms: toolMs,
          e2e_ms: performance.now() - started,
          usage,
          final_text: finalText,
          answered,
          task_pass: strictAnswer ? exactAnswerMatch(answered, groundTruth) : matchAnswer(answered, groundTruth, required),
          maxed_out: false,
        };
      }
      continue;
    }

    consecutiveNoTool = 0;
    // 同一 completion 的多个 toolCalls 并行执行（concurrency=5，与 DSL map 对齐）；
    // mapLimit 保持结果顺序，toolResult 按调用顺序回填。
    const results = await mapLimit(toolCalls, 5, async (call) => {
      const tool = toolById.get(call.name);
      if (!tool) {
        return { call, content: `未知工具：${call.name}`, isError: true };
      }
      if (!tool.execute) {
        return { call, content: `工具 ${call.name} 未提供 execute 实现`, isError: true };
      }
      const t1 = performance.now();
      let resultText: string;
      let isError = false;
      try {
        resultText = JSON.stringify(await tool.execute(call.arguments));
      } catch (error) {
        resultText = String((error as Error).message);
        isError = true;
      }
      toolMs += performance.now() - t1;
      exposedBytes += Buffer.byteLength(resultText, "utf8");
      return { call, content: resultText, isError };
    });
    for (const { call, content, isError } of results) {
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError });
    }
  }

  answered = strictAnswer ? [] : extractFullNames(finalText);
  return {
    ok: true,
    round_trips: roundTrips,
    exposed_bytes: exposedBytes,
    model_ingress_bytes: modelIngressBytes,
    model_egress_bytes: modelEgressBytes,
    runtime_internal_bytes: 0,
    llm_ms: llmMs,
    tool_ms: toolMs,
    e2e_ms: performance.now() - started,
    usage,
    final_text: finalText,
    answered,
    task_pass: strictAnswer ? exactAnswerMatch(answered, groundTruth) : matchAnswer(answered, groundTruth, required),
    maxed_out: true,
  };
}
