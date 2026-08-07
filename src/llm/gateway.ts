import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * LLM gateway：实验代码唯一接触模型的地方。
 *
 * 基于 pi-ai（项目已装的 agent 基座）——用 `createProvider` 注册一个
 * OpenAI 兼容的 DeepSeek 端点（baseUrl + openAICompletionsApi），调用方
 * 只与 `LlmGateway` 接口打交道，未来换模型 / 换 provider 只改这里。
 *
 * API key 从环境变量 `DEEPSEEK_API_KEY` 读取（.env，已被 gitignore）。
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
}

export interface LlmResult {
  content: string;
  usage: LlmUsage;
}

export interface LlmGateway {
  complete(messages: readonly LlmMessage[]): Promise<LlmResult>;
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
    async complete(messages) {
      const systemPrompt = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const chatMessages = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role as "user" | "assistant",
          // pi-ai 期望 assistant 消息的 content 是 block 数组（estimate 的
          // estimateMessageTokens 会遍历 content 取 block 字段；传 string 会抛
          // "Cannot read properties of undefined (reading 'length')"）
          content: message.role === "assistant" ? [{ type: "text", text: message.content }] : message.content,
          timestamp: Date.now(),
          // pi-ai 的上下文估算会读 assistant.usage（estimate.ts getLastAssistantUsageInfo），
          // 缺失会抛 "Cannot read properties of undefined (reading 'totalTokens')"。
          // 全 0 usage 让估算回退到纯字符估算，行为正确。
          ...(message.role === "assistant"
            ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
            : {}),
        }));

      const context: Context = systemPrompt
        ? { systemPrompt, messages: chatMessages }
        : { messages: chatMessages };

      const response = await models.completeSimple(model, context);

      const content = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");

      const usage = response.usage;
      return {
        content,
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
