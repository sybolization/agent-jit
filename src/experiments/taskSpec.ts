import type { ExecutionGraph, ExecutionNode } from "../compiler/ir.js";

/**
 * Task correctness 检查器：从 ExecutionIR 层面判断程序是否真的完成了任务
 * 要求，与"编译成功 / 执行成功"解耦（避免可执行但任务错误的程序被算作成功）。
 *
 * 检查对象是 **return 实际使用的数据流路径**（从 return 节点沿 source 反向
 * 回溯），而不是全局节点列表——冗余分支（如多余的 take / map）不参与判定，
 * 避免 false negative（见 docs/r2实验判断.md：冗余 `take(repos, 10)` 曾导致
 * checker 找到第一个 take 而误判）。
 */
export interface TaskSpec {
  /** 期望的源工具 id（任务起点），默认 "github.search_repositories" */
  sourceTool?: string;
  /** 源工具的 query 参数需包含的串（源工具无 query 参数时省略） */
  query?: string;
  /** 必须在 query 中出现的全部子串（默认只要求 query 本身） */
  queryTokens?: readonly string[];
  /** 源工具的 limit 参数期望值（源工具无 limit 参数时省略） */
  limit?: number;
  /** R2 兼容：map 的 key（参数名 == 字段名语义）；R3 任务用 bindings */
  mapKey?: string;
  takeCount: number;
  /** R3：期望 map 的 element→argument 绑定映射（如 { full_name: "full_name" }）；缺省不检查 binding */
  bindings?: Record<string, string>;
  /** R4c：filter 期望的等值条件（字段 → 字面量），缺省不检查 filter 节点 */
  filterConditions?: Record<string, unknown>;
  /** R4c：sort 期望的排序键（字段名），缺省不检查 sort 节点 */
  sortKey?: string;
  /** R4c：sort 期望的降序标记，缺省不检查 desc */
  sortDesc?: boolean;
}

export interface TaskCorrectness {
  pass: boolean;
  failures: string[];
  /** 仅当 spec.bindings 提供时有值：map 绑定映射是否与期望完全一致（核心指标） */
  bindingPass?: boolean;
  bindingFailures?: string[];
}

/**
 * 从 return 节点沿数据流反向回溯，收集任务真正使用的节点链（return 最近者在前）。
 * 无 return 时返回空数组。
 */
function returnDataflowPath(graph: ExecutionGraph): ExecutionNode[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const returnNode = graph.nodes.find((node) => node.kind === "return");
  if (!returnNode) return [];

  const path: ExecutionNode[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = returnNode.value;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = nodesById.get(cursor);
    if (!node) break;
    path.push(node);
    if (node.kind === "map" || node.kind === "compute") {
      cursor = node.source;
    } else {
      break; // tool 节点无 source，数据流到头
    }
  }
  return path;
}

export function checkTaskCorrectness(graph: ExecutionGraph, spec: TaskSpec): TaskCorrectness {
  const failures: string[] = [];
  let bindingPass: boolean | undefined;
  const bindingFailures: string[] = [];

  const path = returnDataflowPath(graph);
  if (path.length === 0) {
    failures.push("缺少 return 节点");
    return { pass: false, failures };
  }

  const sourceToolId = spec.sourceTool ?? "github.search_repositories";
  const sourceNode = path.find((node) => node.kind === "tool" && node.tool === sourceToolId);
  if (!sourceNode) {
    failures.push(`return 数据流中缺少源工具 ${sourceToolId}`);
  } else {
    if (spec.query) {
      const query = sourceNode.args["query"];
      const tokens = spec.queryTokens?.length ? [...spec.queryTokens] : [spec.query];
      const missing = tokens.filter(
        (token) => !(query?.kind === "literal" && typeof query.value === "string" && query.value.includes(token)),
      );
      if (missing.length > 0) failures.push(`${sourceToolId} query 缺少关键词：${missing.join("、")}`);
    }
    if (spec.limit !== undefined) {
      const limit = sourceNode.args["limit"];
      if (!(limit?.kind === "literal" && limit.value === spec.limit)) {
        failures.push(`${sourceToolId} limit 应为 ${spec.limit}`);
      }
    }
  }

  const mapNode = path.find((node) => node.kind === "map");
  if (!mapNode) {
    failures.push("return 数据流中缺少 map 节点");
  } else {
    const actual = mapNode.bindings;
    // R2 兼容：mapKey 语义 = 参数名与字段名相同的单字段绑定
    if (spec.mapKey && actual[spec.mapKey] !== spec.mapKey) {
      failures.push(`map 的 key 应为 ${spec.mapKey}（当前 ${JSON.stringify(actual)}）`);
    }
    // R3 核心：binding correctness —— 期望映射的每个参数都精确绑定到期望字段，且无多余绑定
    if (spec.bindings) {
      for (const [param, field] of Object.entries(spec.bindings)) {
        if (actual[param] !== field) {
          bindingFailures.push(`${param} 应绑定 ${field}（实际 ${actual[param] ?? "未绑定"}）`);
        }
      }
      for (const param of Object.keys(actual)) {
        if (!(param in spec.bindings)) {
          bindingFailures.push(`多余绑定 ${param}（期望仅 ${Object.keys(spec.bindings).join("、")}）`);
        }
      }
      bindingPass = bindingFailures.length === 0;
      failures.push(...bindingFailures.map((item) => `map 绑定错误：${item}`));
    }
  }

  const takeNode = path.find((node) => node.kind === "compute" && node.op === "take");
  if (!takeNode) {
    failures.push("return 数据流中缺少 take 节点");
  } else if (takeNode.args["count"] !== spec.takeCount) {
    failures.push(`take 的 count 应为 ${spec.takeCount}`);
  }

  // R4c：filter 等值条件检查（期望提供时才要求 filter 节点存在）
  if (spec.filterConditions) {
    const filterNode = path.find((node) => node.kind === "compute" && node.op === "filter");
    if (!filterNode) {
      failures.push("return 数据流中缺少 filter 节点");
    } else {
      const actual = filterNode.args;
      for (const [field, literal] of Object.entries(spec.filterConditions)) {
        if (actual[field] !== literal) {
          failures.push(`filter 条件 ${field} 应为 ${JSON.stringify(literal)}（实际 ${JSON.stringify(actual[field])}）`);
        }
      }
      for (const field of Object.keys(actual)) {
        if (!(field in spec.filterConditions)) {
          failures.push(`filter 多余条件 ${field}（期望仅 ${Object.keys(spec.filterConditions).join("、")}）`);
        }
      }
    }
  }

  // R4c：sort 键/方向检查
  if (spec.sortKey) {
    const sortNode = path.find((node) => node.kind === "compute" && node.op === "sort");
    if (!sortNode) {
      failures.push(`return 数据流中缺少 sort 节点（key=${spec.sortKey}）`);
    } else {
      if (sortNode.args["key"] !== spec.sortKey) {
        failures.push(`sort 的 key 应为 ${spec.sortKey}（实际 ${JSON.stringify(sortNode.args["key"])}）`);
      }
      if (spec.sortDesc !== undefined && sortNode.args["desc"] !== spec.sortDesc) {
        failures.push(`sort 的 desc 应为 ${spec.sortDesc}（实际 ${JSON.stringify(sortNode.args["desc"])}）`);
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    ...(bindingPass !== undefined ? { bindingPass, bindingFailures } : {}),
  };
}
