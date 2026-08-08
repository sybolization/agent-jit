import type { ExecutionGraph } from "../compiler/ir.js";
import type { ToolDefinition } from "../tools/definition.js";
import { nodeDependencies } from "./dependencies.js";
import { executeNode, type ExecutionContext } from "./executor.js";
import { type TraceEntry } from "./trace.js";
import { ValueStore } from "./valueStore.js";

/**
 * 执行 runtime：把 ExecutionGraph 变成真实执行。
 *
 * 调度模型：依赖扫描 → 依赖计数 → 就绪队列 → 批量并发执行 → 解析
 * 依赖者。**绝不依赖 nodes 数组顺序**——同一批就绪的节点自动并行，
 * 这与将来多智能体/多 tool 并发共享同一调度器。
 *
 * ```text
 * scan dependencies
 *       ↓
 * dependency count
 *       ↓
 * ready queue
 *       ↓
 * execute
 *       ↓
 * resolve dependents
 * ```
 */

/** 运行时工具 = 工具定义（execute 可选；缺少时由 executor 守卫拒绝）。 */
export type RuntimeTool = ToolDefinition;

export type RuntimeRegistry = ReadonlyMap<string, RuntimeTool>;

export interface ExecutionResult {
  ok: boolean;
  /** return 节点的输出（图出口）。 */
  result: unknown;
  trace: readonly TraceEntry[];
  totalDurationMs: number;
  error?: string;
}

export async function execute(graph: ExecutionGraph, registry: RuntimeRegistry): Promise<ExecutionResult> {
  const started = performance.now();
  const store = new ValueStore();
  const trace: TraceEntry[] = [];
  const ctx: ExecutionContext = { registry, store, trace };

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  // 1. 依赖扫描 + 计数 + 依赖者索引。
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const deps = nodeDependencies(node);
    indegree.set(node.id, deps.length);
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new Error(`图中缺少依赖节点“${dep}”（${node.id} 依赖它）`);
      }
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  // 2. 就绪队列（无依赖者）。
  const ready: string[] = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);

  // 3. 循环执行：同一批就绪节点并发；完成后解锁依赖者。
  while (ready.length > 0) {
    const batch = ready.splice(0);
    await Promise.all(
      batch.map(async (id) => {
        const node = byId.get(id);
        if (!node) throw new Error(`未知节点：${id}`);
        const value = await executeNode(node, ctx);
        store.set(node.id, value);
        for (const dependent of dependents.get(id) ?? []) {
          const remaining = (indegree.get(dependent) ?? 1) - 1;
          indegree.set(dependent, remaining);
          if (remaining === 0) ready.push(dependent);
        }
      }),
    );
  }

  const returnNode = graph.nodes.find((node) => node.kind === "return");
  const result = returnNode ? store.get(returnNode.id) : undefined;
  const totalDurationMs = Math.round(performance.now() - started);

  if (trace.some((entry) => entry.status === "error")) {
    return { ok: false, result, trace, totalDurationMs, error: "部分节点执行失败" };
  }
  return { ok: true, result, trace, totalDurationMs };
}
