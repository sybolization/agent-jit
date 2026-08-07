import type { CanvasWorkflowTool } from "../../contracts/canvas.js";

/**
 * Automatically render the workflow catalog as Canvas DSL call signatures.
 *
 * The input is the exact `workflow_tools` payload the Agent receives from the
 * backend (see `canvas_agent_tooling.with_catalog_tools`), so the DSL catalog
 * is always a synchronous translation of the same interface the Agent uses to
 * see node inputs/outputs — never a hand-maintained list.
 *
 * Rendering rules mirror the compiler in `canvasDsl.ts` and the Harness
 * readiness rules:
 * - reference inputs (kind image/audio/video) can take a node output or a
 *   literal asset id; parameters can only take literals (into config);
 * - a key that is both reference and parameter is rendered once as reference;
 * - `*` marks "required and has no default" (empty-string defaults do not
 *   force a value, matching Harness readiness);
 * - internal execution keys (filename_prefix/output_prefix) are excluded.
 */

const INTERNAL_PARAMETER_KEYS = new Set(["filename_prefix", "output_prefix"]);
const KIND_LABELS: Record<string, string> = { textarea: "text", select: "text" };
const DESCRIPTION_LIMIT = 80;

type CatalogReference = NonNullable<CanvasWorkflowTool["references"]>[number];
type CatalogParameter = NonNullable<CanvasWorkflowTool["parameters"]>[number];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parameterDefault(tool: CanvasWorkflowTool, key: string): unknown {
  const parameter = (tool.parameters ?? []).find((item) => item.key === key);
  if (parameter?.default !== undefined) return parameter.default;
  return tool.defaults?.[key];
}

function hasDefault(tool: CanvasWorkflowTool, key: string): boolean {
  return parameterDefault(tool, key) !== undefined;
}

function renderSignature(tool: CanvasWorkflowTool): string {
  const references: Array<{ key: string; reference: CatalogReference }> = [];
  for (const reference of tool.references ?? []) {
    if (typeof reference.parameterKey !== "string" || reference.parameterKey.length === 0) continue;
    references.push({ key: reference.parameterKey, reference });
  }
  references.sort((left, right) => compareText(left.key, right.key));
  const referenceKeys = new Set(references.map((item) => item.key));

  const parameters: Array<{ key: string; parameter: CatalogParameter }> = [];
  for (const parameter of tool.parameters ?? []) {
    if (!parameter.key || referenceKeys.has(parameter.key) || INTERNAL_PARAMETER_KEYS.has(parameter.key)) continue;
    parameters.push({ key: parameter.key, parameter });
  }
  parameters.sort((left, right) => compareText(left.key, right.key));

  const args: string[] = [];
  for (const { key, reference } of references) {
    args.push(`${key}=${reference.kind ?? "reference"}${reference.required ? "*" : ""}`);
  }
  for (const { key, parameter } of parameters) {
    const kind = KIND_LABELS[parameter.kind ?? ""] ?? parameter.kind ?? "value";
    const required = parameter.required === true && !hasDefault(tool, key);
    args.push(`${key}=${kind}${required ? "*" : ""}`);
  }

  const outputKind = tool.outputKind ?? tool.output_kind ?? "output";
  const note = references.map((item) => item.key).join(", ");
  const description = [tool.label, tool.description]
    .filter((value): value is string => Boolean(value))
    .join("：")
    .replace(/\s+/g, " ")
    .slice(0, DESCRIPTION_LIMIT);
  const suffix = [note ? `引用: ${note}` : "", description ? description : ""].filter(Boolean).join(" ｜ ");
  return `${tool.id}(${args.join(", ")}) → ${outputKind}${suffix ? `  # ${suffix}` : ""}`;
}

export function renderWorkflowDslCatalog(workflowTools: readonly CanvasWorkflowTool[]): string {
  const tools = [...workflowTools].sort((left, right) => compareText(left.id, right.id));
  const lines: string[] = [
    `# 工作流目录（DSL 调用签名）— 共 ${tools.length} 个`,
    "# 参数格式 <名称>=<类型>*（* = 必填且无默认值）；「引用」标注的参数可接节点输出或素材ID，其余参数只能写字面量",
    "# 普通参数名必须与下方签名完全一致，不得自创参数；字面量类型须与声明的类型匹配（未声明参数会报 unknown_parameter）",
    "",
    ...tools.map(renderSignature),
  ];
  return lines.join("\n");
}
