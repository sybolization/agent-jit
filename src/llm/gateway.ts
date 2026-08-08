import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Context,
  type Message,
  type Model,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

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

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: string; isError: boolean };

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
  complete(messages: readonly LlmMessage[], options?: { tools?: readonly Tool[] }): Promise<LlmResult>;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL_ID = "deepseek-chat";

function createDeepSeekModel(): Model<"openai-completions"> {
  return {
    id: DEEPSEEK_MODEL_ID,
    name: "DeepSeek Chat",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

export function createDeepSeekGateway(): LlmGateway {
  const provider = createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: DEEPSEEK_BASE_URL,
    auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
    models: [createDeepSeekModel()],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("deepseek", DEEPSEEK_MODEL_ID);
  if (!model) throw new Error("DeepSeek 模型未就绪：deepseek-chat");

  return {
    async complete(messages, options) {
      const systemPrompt = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const chatMessages: Context["messages"] = messages
        .filter((message) => message.role !== "system")
        .map((message): Context["messages"][number] => {
          const timestamp = Date.now();
          switch (message.role) {
            case "user":
              return { role: "user", content: message.content, timestamp };
            case "assistant": {
              // pi-ai 期望 assistant 消息 content 是 block 数组，且上下文估算会读
              // assistant.usage（estimate.ts getLastAssistantUsageInfo）——缺失会抛
              // "Cannot read properties of undefined (reading 'totalTokens')"；
              // 全 0 usage 让估算回退到纯字符估算。toolCall block 需随消息回传，
              // 否则 hasToolHistory 无法识别历史中的工具调用。
              const blocks: (TextContent | ToolCall)[] = [{ type: "text", text: message.content }];
              for (const call of message.toolCalls ?? []) {
                blocks.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
              }
              // pi-ai 的 AssistantMessage 类型要求 api/provider/model 元字段，但传输层
              // 与上下文估算只读 role/content/usage/stopReason——回填的历史 assistant 消息
              // 携带真实 usage（全 0）即可，元字段此处缺省；用双重断言保持发送协议不变。
              return {
                role: "assistant",
                content: blocks,
                timestamp,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: (message.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
              } as unknown as Message;
            }
            case "toolResult":
              return {
                role: "toolResult",
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                content: [{ type: "text", text: message.content }],
                isError: message.isError,
                timestamp,
              };
          }
        });

      const context: Context = {
        ...(systemPrompt ? { systemPrompt } : {}),
        messages: chatMessages,
        ...(options?.tools && options.tools.length > 0 ? { tools: [...options.tools] } : {}),
      };

      const response = await models.completeSimple(model, context);

      // pi-ai 对 HTTP 错误（如 400 非法 tool name / 429 限流）不抛异常，
      // 而是返回 stopReason="error" + errorMessage——这里显式抛出，避免实验静默空转。
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "模型调用失败（stopReason=error）");
      }

      const content = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls: LlmToolCall[] = response.content
        .filter((block) => block.type === "toolCall")
        .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments as Record<string, unknown> }));

      const usage = response.usage;
      return {
        content,
        toolCalls,
        usage: {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        },
      };
    },
  };
}
