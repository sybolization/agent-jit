import type { CanvasEdge, CanvasNode, CanvasWorkflowTool } from "../../contracts/canvas.js";
import type {
  SemanticCanvasGraphV1,
  SemanticCanvasInput,
  SemanticCanvasJsonValue,
  SemanticCanvasNodeV1,
  SemanticCanvasReadiness,
} from "../../contracts/semanticCanvas.js";

/**
 * Translate a React Flow/ComfyUI-shaped canvas graph (nodes + edges) into a
 * `SemanticCanvasGraphV1` — the same contract `compileCanvasDsl` produces.
 *
 * This is the JSON-arm counterpart of the DSL compiler: the DSL path builds a
 * semantic graph directly from statements, while this path derives it from the
 * classic canvas JSON (`type: "workflow"` nodes + edges with
 * `data.parameterKey`). The DSL-vs-JSON conformance tests compare both outputs
 * field by field (`toEqual`), so the node shape must mirror `buildNode` in
 * `canvasDsl.ts`: sorted `config`, `node_output` bindings on reference inputs,
 * ports from tool references, readiness from required inputs.
 */

export interface ToSemanticCanvasGraphOptions {
  canvasVersion?: string | null;
  workflowTools?: readonly CanvasWorkflowTool[];
}

function compareNodes(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function workflowTool(node: CanvasNode, tools: ReadonlyMap<string, CanvasWorkflowTool>): CanvasWorkflowTool {
  const data = node.data ?? {};
  const workflowId = typeof data.workflowId === "string" ? data.workflowId : undefined;
  const tool = workflowId !== undefined ? tools.get(workflowId) : undefined;
  if (!tool) throw new Error(`toSemanticCanvasGraph: 未注册的工作流 ${String(workflowId)}`);
  return tool;
}

function referenceKeysOf(tool: CanvasWorkflowTool): Set<string> {
  return new Set((tool.references ?? []).map((reference) => reference.parameterKey).filter((key): key is string => Boolean(key)));
}

function hasDefault(tool: CanvasWorkflowTool, key: string): boolean {
  const parameter = (tool.parameters ?? []).find((item) => item.key === key);
  if (parameter?.default !== undefined) return true;
  return tool.defaults?.[key] !== undefined;
}

export function toSemanticCanvasGraph(
  canvasGraph: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  options: ToSemanticCanvasGraphOptions = {},
): SemanticCanvasGraphV1 {
  const tools = new Map((options.workflowTools ?? []).map((tool) => [tool.id, tool]));
  const nodesById = new Map<string, CanvasNode>(canvasGraph.nodes.map((node) => [node.id, node]));

  // 入边按 target 聚合：画布边（data.parameterKey）即 DSL 中的节点引用。
  const incomingByTarget = new Map<string, CanvasEdge[]>();
  for (const edge of canvasGraph.edges ?? []) {
    const list = incomingByTarget.get(edge.target);
    if (list) list.push(edge);
    else incomingByTarget.set(edge.target, [edge]);
  }

  const inputValuesOf = (node: CanvasNode): Record<string, unknown> =>
    (node.data?.inputValues as Record<string, unknown> | undefined) ?? {};

  // 第一遍：构建不依赖引用边的字段。
  const nodes: SemanticCanvasNodeV1[] = canvasGraph.nodes.map((node) => {
    if (node.type !== "workflow") {
      throw new Error(`toSemanticCanvasGraph: 不支持的节点类型 ${node.type}（仅支持 workflow）`);
    }
    const tool = workflowTool(node, tools);
    const referenceKeys = referenceKeysOf(tool);

    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputValuesOf(node))) {
      if (!referenceKeys.has(key)) config[key] = value;
    }

    const inputPorts = (tool.references ?? [])
      .filter((reference) => reference.parameterKey)
      .map((reference) => ({
        name: reference.parameterKey as string,
        type: reference.kind ?? "reference",
        cardinality: "single" as const,
        required: reference.required === true,
      }));

    const outputKind = tool.outputKind ?? tool.output_kind ?? "output";
    return {
      id: node.id,
      kind: "workflow",
      title: node.id,
      inputs: {},
      input_ports: inputPorts,
      config: sortRecord(config),
      workflow_id: tool.id,
      outputs: [{ name: outputKind, type: outputKind }],
      readiness: { status: "complete" as const, missing_inputs: [], invalid_inputs: [] },
    };
  });

  // 第二遍：填充 inputs —— 边 → node_output 绑定；reference 键的字面量 → literal 绑定。
  for (const node of canvasGraph.nodes) {
    const semantic = nodes.find((item) => item.id === node.id);
    if (!semantic) continue;
    const tool = workflowTool(node, tools);
    const referenceKeys = referenceKeysOf(tool);
    const inputs: Record<string, SemanticCanvasInput> = {};

    for (const edge of incomingByTarget.get(node.id) ?? []) {
      const key = edge.data?.parameterKey;
      if (typeof key !== "string" || key.length === 0) continue;
      const source = nodesById.get(edge.source);
      if (!source) continue;
      const sourceOutput = workflowTool(source, tools);
      const sourceOutputKind = sourceOutput.outputKind ?? sourceOutput.output_kind ?? "output";
      inputs[key] = { kind: "node_output", node_id: edge.source, output: sourceOutputKind };
    }

    for (const [key, value] of Object.entries(inputValuesOf(node))) {
      if (referenceKeys.has(key) && inputs[key] === undefined) {
        inputs[key] = { kind: "literal", value: value as SemanticCanvasJsonValue };
      }
    }
    semantic.inputs = sortRecord(inputs);
  }

  // 第三遍：readiness —— 必填引用输入与必填参数是否齐备（对齐 buildNode 规则）。
  for (const node of canvasGraph.nodes) {
    const semantic = nodes.find((item) => item.id === node.id);
    if (!semantic) continue;
    const tool = workflowTool(node, tools);
    const inputs = semantic.inputs;
    const missingInputs: string[] = [];

    for (const reference of tool.references ?? []) {
      const key = reference.parameterKey;
      if (!key) continue;
      if (reference.required === true && inputs[key] === undefined) missingInputs.push(key);
    }
    for (const parameter of tool.parameters ?? []) {
      if (referenceKeysOf(tool).has(parameter.key)) continue;
      if (!parameter.required || hasDefault(tool, parameter.key)) continue;
      const value = semantic.config[parameter.key];
      const usable = value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
      if (!usable) missingInputs.push(parameter.key);
    }

    semantic.readiness =
      missingInputs.length === 0
        ? { status: "complete", missing_inputs: [], invalid_inputs: [] }
        : { status: "incomplete", missing_inputs: missingInputs, invalid_inputs: [] };
  }

  nodes.sort(compareNodes);
  return { schema_version: "1", canvas_version: options.canvasVersion ?? null, nodes };
}
