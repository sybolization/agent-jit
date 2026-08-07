import type { ToolSpec } from "./registry.js";

/**
 * 把 tool registry 渲染为 DSL 调用签名目录（给 LLM 的系统 prompt）。
 *
 * 与 canvas 的 `renderWorkflowDslCatalog` 同一思路：从 registry 自动
 * 渲染，模型看到的参数名/类型/必填与编译器校验完全一致，杜绝"自创参数"
 * （编译器用 unknown_parameter 拒绝幻觉参数名）。
 */

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderToolSignature(tool: ToolSpec): string {
  const args = tool.parameters
    .map((parameter) => `${parameter.key}=${parameter.kind}${parameter.required ? "*" : ""}`)
    .join(", ");
  const description = tool.description ? `  # ${tool.description}` : "";
  return `${tool.id}(${args}) -> ${tool.outputKind}${description}`;
}

export function renderExecutionToolCatalog(tools: readonly ToolSpec[]): string {
  const sorted = [...tools].sort((left, right) => compareText(left.id, right.id));
  const lines = [
    `# 工具目录（DSL 调用签名）— 共 ${sorted.length} 个`,
    "# 参数格式 <名称>=<类型>*（* = 必填）；参数名必须与签名完全一致，不得自创参数",
    "",
    ...sorted.map(renderToolSignature),
  ];
  return lines.join("\n");
}
