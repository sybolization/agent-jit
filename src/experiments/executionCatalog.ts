import type { ToolContract } from "../tools/definition.js";
import type { ToolCatalog } from "../tools/registry.js";
import { schemaViewOf, schemaViewText } from "../tools/schemaView.js";

/**
 * 遗留全量目录渲染（旧格式）：把 tool registry 渲染为"DSL 调用签名"目录。
 *
 * #8 合并 renderer 后，正式 DSL contract renderer 只有 `src/tools/llmCatalog.ts`
 * （renderCompactToolCatalog / renderToolContracts）。本文件是从 `src/compiler/catalog.ts`
 * 迁移来的旧格式，仅供旧 benchmark（r4e / programmatic / semantic）的 iterative 臂
 * 系统提示词使用；新代码请用 `src/tools/llmCatalog.ts`。
 *
 * 参数/输出仍从 inputSchema / outputSchema 渲染（唯一事实源），与编译器校验一致。
 */

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 把任意 JSON Schema / TypeBox schema 渲染为目录文本（经 SchemaView 归一，支持 string | null / 嵌套 / union）。 */
export function schemaTypeText(schema: unknown): string {
  return schemaViewText(schemaViewOf(schema));
}

function renderToolSignature(tool: ToolContract, nameTransform: (id: string) => string): string {
  const inputView = schemaViewOf(tool.inputSchema);
  const required = inputView.kind === "object" ? new Set(inputView.required) : new Set<string>();
  const properties = inputView.kind === "object" ? inputView.properties : {};
  const args = Object.entries(properties)
    .map(([key, prop]) => `${key}=${schemaViewText(prop)}${required.has(key) ? "*" : ""}`)
    .join(", ");
  const description = tool.description ? `  # ${tool.description}` : "";
  return `${nameTransform(tool.id)}(${args}) -> ${schemaTypeText(tool.outputSchema)}${description}`;
}

/**
 * 渲染工具目录。nameTransform 用于与 pi-ai 工具定义的命名保持一致
 * （如把 "github.search_repositories" 映射为 host alias "github_search_repositories"）。
 */
export function renderExecutionToolCatalog(catalog: ToolCatalog, nameTransform: (id: string) => string = (id) => id): string {
  const sorted = [...catalog.all()].sort((left, right) => compareText(left.id, right.id));
  const lines = [
    `# 工具目录（DSL 调用签名）— 共 ${sorted.length} 个`,
    "# 参数格式 <名称>=<类型>*（* = 必填）；参数名必须与签名完全一致，不得自创参数",
    "",
    ...sorted.map((tool) => renderToolSignature(tool, nameTransform)),
  ];
  return lines.join("\n");
}
