import type { ExecutionGraph } from "../compiler/ir.js";

/**
 * Task correctness 检查器：从 ExecutionIR 层面判断程序是否真的完成了任务
 * 要求，与"编译成功 / 执行成功"解耦（避免可执行但任务错误的程序被算作成功）。
 *
 * 检查项只针对当前 demo 任务的已知形状（search -> map -> take -> return），
 * 随任务扩展时按需补充。
 */

export interface TaskSpec {
  query: string;
  limit: number;
  mapKey: string;
  takeCount: number;
}

export interface TaskCorrectness {
  pass: boolean;
  failures: string[];
}

export function checkTaskCorrectness(graph: ExecutionGraph, spec: TaskSpec): TaskCorrectness {
  const failures: string[] = [];

  const searchNode = graph.nodes.find((node) => node.kind === "tool" && node.tool === "github.search_repositories");
  if (!searchNode) {
    failures.push("缺少 search 节点（github.search_repositories）");
  } else {
    const query = searchNode.args["query"];
    if (!query || query.kind !== "literal" || typeof query.value !== "string" || !query.value.includes(spec.query)) {
      failures.push(`search query 应包含“${spec.query}”`);
    }
    const limit = searchNode.args["limit"];
    if (!limit || limit.kind !== "literal" || limit.value !== spec.limit) {
      failures.push(`search limit 应为 ${spec.limit}`);
    }
  }

  const mapNode = graph.nodes.find((node) => node.kind === "map");
  if (mapNode) {
    if (mapNode.key !== spec.mapKey) {
      failures.push(`map 的 key 应为 ${spec.mapKey}（当前 ${mapNode.key}）`);
    }
  } else {
    failures.push("缺少 map 节点");
  }

  const takeNode = graph.nodes.find((node) => node.kind === "compute" && node.op === "take");
  if (takeNode) {
    // ComputeNode.args 是裸字面量（区别于 ToolNode.args 的 ValueExpr 包装）
    if (takeNode.args["count"] !== spec.takeCount) {
      failures.push(`take 的 count 应为 ${spec.takeCount}`);
    }
  } else {
    failures.push("缺少 take 节点");
  }

  if (!graph.nodes.some((node) => node.kind === "return")) {
    failures.push("缺少 return 节点");
  }

  return { pass: failures.length === 0, failures };
}
