import type { Tool } from "@earendil-works/pi-ai";
import type { LlmMessage, LlmToolCall } from "../llm/gateway.js";
import type { ToolCatalog } from "./registry.js";
/**
 * Agent JIT 元工具（jit_*）。
 *
 * 与普通工具的分工：
 * - 普通工具（github.search_repositories ...）：模型已经知道"有什么工具、单次怎么调用"
 *   （Pi 的 Tool Calling 通道注册，天然以 JSON schema 形式存在）；
 * - JIT 元工具：告诉模型"这些工具在 DSL 程序里如何组合、输出长什么样"。
 *
 * 工具名用下划线而非点号（jit_describe_tools / jit_execute_program）：
 * OpenAI / DeepSeek 的 function name 只允许 `[a-zA-Z0-9_-]`，不允许 `.`——
 * 与 host alias（github.search_repositories → github_search_repositories）同理。
 * DSL 程序里的 callee 两种写法等价（resolver 解析），IR 永远写 canonical id。
 *
 * jit_describe_tools 是确定性的：tool_names → ToolIdResolver → SchemaView →
 * compact DSL 契约文本（输入参数 + 命名输出类型），不经过任何概率过程。
 * 模型只有在判断"接下来这几步可以程序化"时才调用它——常驻 context 因此
 * 只需要 DSL 语法/原则 + 两个元工具，不需要内嵌全部业务工具的契约。
 *
 * 严格语义：**不允许 partial success**——请求里任何一个 id 未知就整体失败
 * （UNKNOWN_TOOL 一次性列出全部未知 + 确定性近似建议），不返回部分契约，
 * 避免模型拿着不完整契约继续编程。
 */
/** tool_names 上限：防止模型一次 describe 几百个工具，把 lazy loading 变回 eager loading。 */
export declare const MAX_DESCRIBE_TOOLS = 20;
/** 获取指定工具在 DSL 中的用法契约（输入参数 + 输出字段）。 */
export declare const DESCRIBE_TOOLS_TOOL: Tool;
/** 提交 DSL 程序源码给 Harness 编译执行（DSL 臂唯一的 transport 工具）。 */
export declare const EXECUTE_PROGRAM_TOOL: Tool;
/** DSL 臂注册到 gateway 的全部元工具（模型可动态调用：describe → 写程序 → execute）。 */
export declare const JIT_META_TOOLS: readonly Tool[];
/**
 * 确定性渲染：tool_names → ToolIdResolver（canonical / host alias 无感）→ SchemaView →
 * compact DSL 契约文本。保持请求顺序。
 *
 * 严格语义：**不允许 partial success**——任一 id 未知即整体失败，一次性列出全部未知
 * （UNKNOWN_TOOL）+ 确定性近似建议，绝不返回部分契约。
 */
export declare function describeToolContracts(catalog: ToolCatalog, toolNames: readonly string[], options?: {
    header?: string;
}): string;
/** 把一次 jit_describe_tools 工具调用转成 toolResult 消息（供 DSL 臂 dispatch）。 */
export declare function describeToolsResult(catalog: ToolCatalog, call: LlmToolCall): Extract<LlmMessage, {
    role: "toolResult";
}>;
