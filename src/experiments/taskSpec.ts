import type { ComputeNode, ExecutionGraph, ExecutionNode, ToolNode } from "../compiler/ir.js";
import { nodeDependencies } from "../runtime/dependencies.js";

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
  /** R4d：return 数据流上按序（return 侧在前）出现的阶段工具 id；缺省不检查。
   *  "按序"判定 = 路径中 tool 节点 id 序列包含 stageTools 作为子序列（允许多余节点，如源工具）。 */
  stageTools?: readonly string[];
  /** R4d：return 数据流上按序出现的 take count（return 侧在前），如 D3=[3,5]；缺省只用 takeCount 检查最近一个 */
  takeCounts?: readonly number[];
  /** R4e：期望的 compute 字段计算（输出字段 → 表达式字符串），return 可达的任意 compute 节点命中即通过 */
  computeExprs?: Record<string, string>;
  /** R4e：期望的 select 谓词（空白规范化后匹配），return 可达的任意 select 节点命中即通过 */
  selectPreds?: readonly string[];
  /** R4e：期望的 merge_by_key（join 节点）形态（key / sources 数量 / 分支工具集合） */
  mergeSpec?: {
    key: string;
    /** 期望 merge_by_key 的 sources 总数（含基准），如 3 */
    sourceCount?: number;
    /** 期望 merge_by_key 附加（非基准）source 的工具 id 集合（分支工具，如 contributors/commits） */
    extraTools?: readonly string[];
  };
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
    } else if (node.kind === "join" || node.kind === "concat") {
      cursor = node.sources[0]; // 基准/首条链；分支 source 由 mergeSpec 单独检查（return 可达闭包）
    } else {
      break; // tool 节点无 source，数据流到头
    }
  }
  return path;
}

/** return 可达的节点集合（BFS 依赖闭包，含 merge_by_key / concat 的全部分支 source）——R4e 检查用。 */
function returnReachableNodes(graph: ExecutionGraph): ExecutionNode[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const returnNode = graph.nodes.find((node) => node.kind === "return");
  if (!returnNode) return [];
  const visited = new Set<string>();
  const out: ExecutionNode[] = [];
  const queue: ExecutionNode[] = [returnNode];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    out.push(node);
    for (const dep of nodeDependencies(node)) {
      const depNode = nodesById.get(dep);
      if (depNode) queue.push(depNode);
    }
  }
  return out;
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
  const sourceNode = path.find((node): node is ToolNode => node.kind === "tool" && node.tool === sourceToolId);
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

  const takeNode = path.find((node): node is ComputeNode => node.kind === "compute" && node.op === "take");
  if (!takeNode) {
    failures.push("return 数据流中缺少 take 节点");
  } else if (takeNode.args["count"] !== spec.takeCount) {
    failures.push(`take 的 count 应为 ${spec.takeCount}`);
  }

  // R4c：filter 等值条件检查（期望提供时才要求 filter 节点存在）
  if (spec.filterConditions) {
    const filterNode = path.find((node): node is ComputeNode => node.kind === "compute" && node.op === "filter");
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
    const sortNode = path.find((node): node is ComputeNode => node.kind === "compute" && node.op === "sort");
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

  // R4d：多阶段图——阶段工具按序出现（return 侧在前）。
  // 阶段工具以 map 节点（绑定调用）或 tool 节点（顶层调用）存在，两者都计。
  if (spec.stageTools && spec.stageTools.length > 0) {
    const stageIds: string[] = [];
    for (const node of path) {
      if (node.kind === "tool" || node.kind === "map") stageIds.push(node.tool);
    }
    let matched = 0;
    for (const toolId of stageIds) {
      if (matched < spec.stageTools.length && toolId === spec.stageTools[matched]) matched += 1;
    }
    if (matched < spec.stageTools.length) {
      failures.push(
        `return 数据流阶段工具顺序应为 ${spec.stageTools.join(" → ")}（实际 ${stageIds.join(" → ") || "无"}）`,
      );
    }
  }

  // R4d：多阶段 take 序列（return 侧在前），如 D3 = [3, 5]
  if (spec.takeCounts) {
    const counts = path
      .filter((node): node is ComputeNode => node.kind === "compute" && node.op === "take")
      .map((node) => node.args["count"]);
    if (JSON.stringify(counts) !== JSON.stringify(spec.takeCounts)) {
      failures.push(`take 序列应为 ${JSON.stringify(spec.takeCounts)}（实际 ${JSON.stringify(counts)}）`);
    }
  }

  // R4e：return 可达闭包（merge_by_key 全部分支）上的 compute / select / merge_by_key 检查
  if (spec.computeExprs || spec.selectPreds || spec.mergeSpec) {
    const reachable = returnReachableNodes(graph);
    if (spec.computeExprs) {
      const computeNodes = reachable.filter((node): node is ComputeNode => node.kind === "compute" && node.op === "compute");
      for (const [out, expr] of Object.entries(spec.computeExprs)) {
        const found = computeNodes.some((node) => node.args[out] === expr);
        if (!found) failures.push(`compute 缺少字段 ${out} = "${expr}"`);
      }
    }
    if (spec.selectPreds) {
      const selectNodes = reachable.filter((node): node is ComputeNode => node.kind === "compute" && node.op === "select");
      const normalize = (value: string): string => value.replace(/\s+/g, "");
      for (const pred of spec.selectPreds) {
        const found = selectNodes.some((node) => normalize(String(node.args.pred ?? "")) === normalize(pred));
        if (!found) failures.push(`select 缺少谓词 "${pred}"`);
      }
    }
    if (spec.mergeSpec) {
      // 存在性匹配：任一 merge_by_key 节点满足（key + sources 数量 + 分支工具）即通过——
      // 模型可能额外做二次 merge（把 score 再合并一次），第一个未必是分支 merge。
      const mergeSpec = spec.mergeSpec;
      const mergeNodes = reachable.filter((node) => node.kind === "join");
      const graphById = new Map(graph.nodes.map((node) => [node.id, node]));
      const satisfied = mergeNodes.some((mergeNode) => {
        if (mergeNode.key !== mergeSpec.key) return false;
        if (mergeSpec.sourceCount !== undefined && mergeNode.sources.length !== mergeSpec.sourceCount) return false;
        if (mergeSpec.extraTools && mergeSpec.extraTools.length > 0) {
          const extraToolIds = new Set(
            mergeNode.sources.slice(1).flatMap((sourceId) => {
              const source = graphById.get(sourceId);
              if (source && (source.kind === "map" || source.kind === "tool")) return [source.tool];
              return [];
            }),
          );
          for (const toolId of mergeSpec.extraTools) {
            if (!extraToolIds.has(toolId)) return false;
          }
        }
        return true;
      });
      if (!satisfied) {
        failures.push(
          `缺少满足条件的 merge_by_key 节点（key=${mergeSpec.key}，分支工具 ${(mergeSpec.extraTools ?? []).join("、")}）`,
        );
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    ...(bindingPass !== undefined ? { bindingPass, bindingFailures } : {}),
  };
}
