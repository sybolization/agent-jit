import { createModels, createProvider, envApiKeyAuth, } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL_ID = "deepseek-v4-flash";
function createDeepSeekModel(options) {
    return {
        id: DEEPSEEK_MODEL_ID,
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        provider: "deepseek",
        baseUrl: DEEPSEEK_BASE_URL,
        reasoning: options?.reasoning ?? true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
    };
}
export function createDeepSeekGateway() {
    const models = createDeepSeekModels();
    const model = getDeepSeekModel(models);
    return {
        async complete(messages, options) {
            const systemPrompt = messages
                .filter((message) => message.role === "system")
                .map((message) => message.content)
                .join("\n\n");
            const chatMessages = messages
                .filter((message) => message.role !== "system")
                .map((message) => {
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
                        const blocks = [{ type: "text", text: message.content }];
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
                        };
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
            const context = {
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
            const toolCalls = response.content
                .filter((block) => block.type === "toolCall")
                .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));
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
/** DeepSeek provider 的唯一创建点（LlmGateway 与 Agent 两通道共用）。 */
function createDeepSeekModels(options) {
    const provider = createProvider({
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: DEEPSEEK_BASE_URL,
        auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
        models: [createDeepSeekModel(options)],
        api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);
    return models;
}
function getDeepSeekModel(models) {
    const model = models.getModel("deepseek", DEEPSEEK_MODEL_ID);
    if (!model)
        throw new Error("DeepSeek 模型未就绪：deepseek-v4-flash");
    return model;
}
/**
 * 创建 DeepSeek 的 Pi Agent runtime（与 LlmGateway 共用同一个 provider 配置）。
 *
 * 默认开启思考（reasoning:true → model.reasoning + Agent thinkingLevel="medium"）——
 * 只有两者都满足，pi-ai 的 openai-completions API 才会在请求里发
 * `thinking:{type:"enabled"}`（DeepSeek thinking 模式），响应才会带 reasoning_content。
 * 显式传 reasoning:false 关闭思考（model.reasoning=false 且不置 thinkingLevel）。
 */
export function createDeepSeekPiRuntime(options) {
    const models = createDeepSeekModels(options);
    return {
        model: getDeepSeekModel(models),
        streamFn: models.streamSimple.bind(models),
        ...(options?.reasoning ?? true ? { thinkingLevel: "medium" } : {}),
    };
}
