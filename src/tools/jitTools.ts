import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { ToolCatalog } from "./registry.js";
import { renderToolContracts } from "./llmCatalog.js";
import { dslSignatureOf, renderDslSignature } from "./dslSignature.js";

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
export const MAX_DESCRIBE_TOOLS = 20;

/** 获取指定工具在 DSL 中的用法契约（输入参数 + 输出字段）。 */
export const DESCRIBE_TOOLS_TOOL: Tool = {
  name: "jit_describe_tools",
  description:
    "获取当前上下文中未提供或需要额外查询的工具 DSL 函数签名（输入参数 + 输出字段）。"
    + "仅用于动态工具发现或大型工具集合中的按需查询；已随 active tool 定义提供 DSL signature 时无需调用。",
  parameters: Type.Object({
    tool_names: Type.Array(Type.String(), {
      description:
        '要获取 DSL 契约的工具 id 列表（canonical 与 host alias 等价，如 "github.search_repositories" / "github_search_repositories"）',
      minItems: 1,
      maxItems: MAX_DESCRIBE_TOOLS,
    }),
  }),
};

/** 提交 DSL 程序源码给 Harness 编译执行（DSL 臂唯一的 transport 工具）。 */
export const EXECUTE_PROGRAM_TOOL: Tool = {
  name: "jit_execute_program",
  description: "提交一段 Agent Execution DSL 程序源码给 Harness 编译执行（把完整程序放在 source 参数里）。",
  parameters: Type.Object({
    source: Type.String({ description: "Agent Execution DSL 程序源码（每条语句独占一行）" }),
  }),
};

/** DSL 臂注册到 gateway 的全部元工具（模型可动态调用：describe → 写程序 → execute）。 */
export const JIT_META_TOOLS: readonly Tool[] = [DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL];

/** 每个未知名字的确定性近似建议行（最多 2 个候选；相似度太低则不出现）。 */
function suggestionLines(catalog: ToolCatalog, unknowns: readonly string[]): string {
  const lines: string[] = [];
  for (const name of unknowns) {
    const suggestions = catalog.suggestIds(name);
    if (suggestions.length === 0) continue;
    const list = suggestions
      .map(({ alias, canonical }) => (alias === canonical ? `“${canonical}”` : `“${alias}”（${canonical}）`))
      .join(" / ");
    lines.push(`- “${name}”：你是否指 ${list}？`);
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/**
 * describe 契约渲染格式：
 * - "signature"（production 默认）：与 active tool 内联 DSL 签名同一渲染器
 *   （dslSignatureOf → renderDslSignature），函数式单行签名；
 * - "legacy"（历史 eager 臂）：llmCatalog 四段式（类型定义段 + 参数格式说明），
 *   仅供历史实验逐字节复现，勿在新入口使用。
 */
export type DescribeContractFormat = "signature" | "legacy";

/**
 * 确定性渲染：tool_names → ToolIdResolver（canonical / host alias 无感）→
 * 函数式 DSL 签名（format: "signature"，与 inline 签名同源）或历史四段式契约
 * （format: "legacy"）。保持请求顺序。
 *
 * 严格语义：**不允许 partial success**——任一 id 未知即整体失败，一次性列出全部未知
 * （UNKNOWN_TOOL）+ 确定性近似建议，绝不返回部分契约。
 */
export function describeToolContracts(
  catalog: ToolCatalog,
  toolNames: readonly string[],
  options: { header?: string; format?: DescribeContractFormat } = {},
): string {
  const format = options.format ?? "signature";
  const names = [...new Set(toolNames.map((name) => name.trim()).filter((name) => name.length > 0))];
  if (names.length === 0) {
    return "错误：tool_names 为空。请传入要获取 DSL 契约的工具 id 列表（canonical 或 host alias 均可）。";
  }
  if (names.length > MAX_DESCRIBE_TOOLS) {
    return `错误：tool_names 最多 ${MAX_DESCRIBE_TOOLS} 个（当前 ${names.length} 个）。请分批查询要编排的工具。`;
  }

  const canonicalIds: string[] = [];
  const unknowns: string[] = [];
  for (const name of names) {
    const canonical = catalog.resolveId(name);
    if (canonical === undefined) {
      unknowns.push(name);
      continue;
    }
    if (!canonicalIds.includes(canonical)) canonicalIds.push(canonical);
  }

  if (unknowns.length > 0) {
    return `错误：UNKNOWN_TOOL: ${unknowns.join(", ")}${suggestionLines(catalog, unknowns)}`;
  }

  if (format === "legacy") {
    return renderToolContracts(catalog, {
      ids: canonicalIds,
      ...(options.header !== undefined ? { header: options.header } : {}),
    });
  }

  // signature（production）：与 active tool 内联 DSL 签名同一渲染器。
  const signatures = canonicalIds
    .map((id) => {
      const tool = catalog.get(id);
      if (!tool) return "";
      return renderDslSignature(dslSignatureOf(tool), { fieldLabels: true });
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
  const header = options.header !== undefined ? `${options.header}\n\n` : "";
  return `${header}${signatures}`;
}

/** Pi gateway 工具调用消息的最小结构镜像（类型层）——避免把 pi gateway 拉进 dist 运行时图。 */
interface LlmToolCallLike {
  id: string;
  arguments: Record<string, unknown>;
}

/** jit_describe_tools 的 toolResult 消息（与 gateway.LlmMessage 的 toolResult 变体同构）。 */
export interface DescribeToolsResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

/**
 * 把一次 jit_describe_tools 工具调用转成 toolResult 消息（供历史实验的 DSL 臂 dispatch：
 * describeToolsCase / dslGenerationExperiment / programmaticBenchmark / r4eBenchmark /
 * semanticBenchmark）。缺省 legacy 格式——这些 R1–R5 历史实验的 describe 输出逐字节
 * 保持不变；新入口请直接用 describeToolContracts（缺省 signature）。
 */
export function describeToolsResult(
  catalog: ToolCatalog,
  call: LlmToolCallLike,
  format: DescribeContractFormat = "legacy",
): DescribeToolsResultMessage {
  const names = Array.isArray(call.arguments["tool_names"])
    ? call.arguments["tool_names"].map(String)
    : [];
  const text = describeToolContracts(catalog, names, { format });
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: DESCRIBE_TOOLS_TOOL.name,
    content: text,
    isError: text.startsWith("错误"),
  };
}
