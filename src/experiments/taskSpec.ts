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
  query: string;
  /** 必须在 search query 中出现的全部子串（默认只要求 query 本身） */
  queryTokens?: readonly string[];
  limit: number;
  mapKey: string;
  takeCount: number;
}

export interface TaskCorrectness {
  pass: boolean;
  failures: string[];
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

  const path = returnDataflowPath(graph);
  if (path.length === 0) {
    failures.push("缺少 return 节点");
    return { pass: false, failures };
  }

  const searchNode = path.find((node) => node.kind === "tool" && node.tool === "github.search_repositories");
  if (!searchNode) {
    failures.push("return 数据流中缺少 search 节点（github.search_repositories）");
  } else {
    const query = searchNode.args["query"];
    const tokens = spec.queryTokens?.length ? [...spec.queryTokens] : [spec.query];
    const missing = tokens.filter(
      (token) => !(query?.kind === "literal" && typeof query.value === "string" && query.value.includes(token)),
    );
    if (missing.length > 0) failures.push(`search query 缺少关键词：${missing.join("、")}`);

    const limit = searchNode.args["limit"];
    if (!(limit?.kind === "literal" && limit.value === spec.limit)) {
      failures.push(`search limit 应为 ${spec.limit}`);
    }
  }

  const mapNode = path.find((node) => node.kind === "map");
  if (!mapNode) {
    failures.push("return 数据流中缺少 map 节点");
  } else if (mapNode.key !== spec.mapKey) {
    failures.push(`map 的 key 应为 ${spec.mapKey}（当前 ${mapNode.key}）`);
  }

  const takeNode = path.find((node) => node.kind === "compute" && node.op === "take");
  if (!takeNode) {
    failures.push("return 数据流中缺少 take 节点");
  } else if (takeNode.args["count"] !== spec.takeCount) {
    failures.push(`take 的 count 应为 ${spec.takeCount}`);
  }

  return { pass: failures.length === 0, failures };
}
