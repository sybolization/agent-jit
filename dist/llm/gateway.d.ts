import { type Model, type Tool } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
/**
 * Pi Agent runtime：pi-agent-core `Agent` 需要的模型 + stream 函数。
 *
 * LlmGateway（completeSimple）与 Agent（streamSimple）共用同一 DeepSeek provider——
 * 两通道的模型配置只有一处（createDeepSeekModels），实验代码接触模型的入口不分裂。
 */
/**
 * LLM gateway：实验代码唯一接触模型的地方。
 *
 * 基于 pi-ai（项目已装的 agent 基座）——用 `createProvider` 注册一个
 * OpenAI 兼容的 DeepSeek 端点（baseUrl + openAICompletionsApi），调用方
 * 只与 `LlmGateway` 接口打交道，未来换模型 / 换 provider 只改这里。
 *
 * 支持两通道（传输协议分层）：
 * - text：模型的自然语言输出（给人）；
 * - tool call：结构化 transport（给机器），如 `jit_execute_program(source)`。
 * 两通道互不污染——`LlmResult.content` 与 `LlmResult.toolCalls` 分离。
 *
 * API key 从环境变量 `DEEPSEEK_API_KEY` 读取（.env，已被 gitignore）。
 */
export interface LlmToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export type LlmMessage = {
    role: "system";
    content: string;
} | {
    role: "user";
    content: string;
} | {
    role: "assistant";
    content: string;
    toolCalls?: LlmToolCall[];
} | {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: string;
    isError: boolean;
};
export interface LlmUsage {
    input: number;
    output: number;
    cacheRead: number;
    totalTokens: number;
}
export interface LlmResult {
    /** 模型 text 部分（无则空串）——给人看，不参与程序解析 */
    content: string;
    /** 模型工具调用（transport envelope）——给机器，程序只从这里取 */
    toolCalls: LlmToolCall[];
    usage: LlmUsage;
}
export interface LlmGateway {
    complete(messages: readonly LlmMessage[], options?: {
        tools?: readonly Tool[];
    }): Promise<LlmResult>;
}
export declare function createDeepSeekGateway(): LlmGateway;
/** pi-agent-core `Agent` 的运行基座：模型 + stream 函数（Agent 负责工具调用循环）。 */
export interface PiRuntime {
    model: Model<"openai-completions">;
    streamFn: StreamFn;
    /**
     * 开启模型 reasoning 时给 Agent 的 thinking level（对应 pi-agent-core `Agent` 的
     * `initialState.thinkingLevel`，会经 streamFn 的 `reasoning` 选项转为请求参数）。
     *
     * 缺省 = 开启思考（V4 Flash 默认思考，显式传 reasoning:false 才关闭）。
     */
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
/**
 * 创建 DeepSeek 的 Pi Agent runtime（与 LlmGateway 共用同一个 provider 配置）。
 *
 * 默认开启思考（reasoning:true → model.reasoning + Agent thinkingLevel="medium"）——
 * 只有两者都满足，pi-ai 的 openai-completions API 才会在请求里发
 * `thinking:{type:"enabled"}`（DeepSeek thinking 模式），响应才会带 reasoning_content。
 * 显式传 reasoning:false 关闭思考（model.reasoning=false 且不置 thinkingLevel）。
 */
export declare function createDeepSeekPiRuntime(options?: {
    reasoning?: boolean;
}): PiRuntime;
