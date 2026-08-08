import type { ToolDefinition } from "../tools/definition.js";

/**
 * 把 tool registry 渲染为 DSL 调用签名目录（给 LLM 的系统 prompt）。
 *
 * 与 canvas 的 `renderWorkflowDslCatalog` 同一思路：从 registry 自动
 * 渲染，模型看到的参数名/类型/必填与编译器校验完全一致，杜绝"自创参数"
 * （编译器用 unknown_parameter 拒绝幻觉参数名）。
 *
 * 参数/输出均从 inputSchema / outputSchema 渲染（唯一事实源），不再有
 * 第二份手工描述。
 */

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface SchemaNode {
  type?: string;
  properties?: Record<string, { type?: string }>;
  items?: unknown;
  patternProperties?: Record<string, { type?: string }>;
  additionalProperties?: unknown;
}

/** 把 outputSchema 渲染为目录文本：array → list<...>、object → { k: type, ... }、record → Record<string, ...>。 */
export function schemaTypeText(schema: unknown): string {
  const node = (schema ?? {}) as SchemaNode;
  if (node.type === "array" && node.items !== undefined) {
    return `list<${schemaTypeText(node.items)}>`;
  }
  if (node.type === "object" && node.properties) {
    const fields = Object.entries(node.properties)
      .map(([key, prop]) => `${key}: ${prop.type ?? "unknown"}`)
      .join(", ");
    return `{ ${fields} }`;
  }
  if (node.type === "object" && (node.patternProperties || node.additionalProperties)) {
    const valueSchema = node.patternProperties
      ? (Object.values(node.patternProperties)[0] as { type?: string } | undefined)
      : (node.additionalProperties as { type?: string } | undefined);
    return `Record<string, ${valueSchema?.type ?? "unknown"}>`;
  }
  return node.type ?? "unknown";
}

function renderToolSignature(tool: ToolDefinition, nameTransform: (id: string) => string): string {
  const input = tool.inputSchema as unknown as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  const required = new Set(input.required ?? []);
  const args = Object.entries(input.properties ?? {})
    .map(([key, prop]) => `${key}=${prop.type ?? "unknown"}${required.has(key) ? "*" : ""}`)
    .join(", ");
  const description = tool.description ? `  # ${tool.description}` : "";
  return `${nameTransform(tool.id)}(${args}) -> ${schemaTypeText(tool.outputSchema)}${description}`;
}

/**
 * 渲染工具目录。nameTransform 用于与 pi-ai 工具定义的命名保持一致
 * （如把 "github.search_repositories" 映射为 "github_search_repositories"）。
 */
export function renderExecutionToolCatalog(tools: readonly ToolDefinition[], nameTransform: (id: string) => string = (id) => id): string {
  const sorted = [...tools].sort((left, right) => compareText(left.id, right.id));
  const lines = [
    `# 工具目录（DSL 调用签名）— 共 ${sorted.length} 个`,
    "# 参数格式 <名称>=<类型>*（* = 必填）；参数名必须与签名完全一致，不得自创参数",
    "",
    ...sorted.map((tool) => renderToolSignature(tool, nameTransform)),
  ];
  return lines.join("\n");
}
