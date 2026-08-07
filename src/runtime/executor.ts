import type { ExecutionNode, ValueExpr } from "../compiler/ir.js";
import type { RuntimeRegistry } from "./runtime.js";
import { type TraceEntry, valueSize } from "./trace.js";
import type { ValueStore } from "./valueStore.js";

/**
 * 节点执行器：把单个 IR 节点变成具体行为。
 *
 * - tool：解析 args（ref → 上游值），调用 registry 中的工具；
 * - map：source 必须是数组，按 concurrency 限流的 fan-out 执行
 *   `tool({ [key]: item[key] })` 并 join 回数组（逻辑并行度由 DSL 描述，
 *   实际调度由 runtime 决定）；
 * - compute.take：截取前 count 个；
 * - return：取引用的值作为图出口。
 */

export interface ExecutionContext {
  registry: RuntimeRegistry;
  store: ValueStore;
  trace: TraceEntry[];
}

function nodeKindLabel(node: ExecutionNode): string {
  switch (node.kind) {
    case "tool":
      return "tool";
    case "map":
      return "map";
    case "compute":
      return `compute.${node.op}`;
    case "return":
      return "return";
  }
}

function resolveArgs(args: Record<string, ValueExpr>, store: ValueStore): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = value.kind === "ref" ? store.get(value.name) : value.value;
  }
  return resolved;
}

/** 并发受限的数组映射：最多 concurrency 个任务同时进行，保持输出顺序。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T, index);
      }
    }),
  );
  return results;
}

async function runNode(node: ExecutionNode, ctx: ExecutionContext, trace: TraceEntry): Promise<unknown> {
  switch (node.kind) {
    case "tool": {
      const tool = ctx.registry.get(node.tool);
      if (!tool) throw new Error(`未注册的工具：${node.tool}`);
      return tool.execute(resolveArgs(node.args, ctx.store));
    }
    case "map": {
      const source = ctx.store.get(node.source);
      if (!Array.isArray(source)) {
        throw new Error(`map 的 source “${node.source}” 不是数组（得到 ${typeof source}）`);
      }
      const tool = ctx.registry.get(node.tool);
      if (!tool) throw new Error(`map 引用了未注册的工具：${node.tool}`);
      trace.fanout = source.length;
      trace.concurrency = node.concurrency;
      return mapLimit(source, node.concurrency, async (item) => {
        const itemRecord = item as Record<string, unknown>;
        return tool.execute({ [node.key]: itemRecord[node.key] });
      });
    }
    case "compute": {
      const source = ctx.store.get(node.source);
      if (!Array.isArray(source)) {
        throw new Error(`compute.${node.op} 的 source “${node.source}” 不是数组（得到 ${typeof source}）`);
      }
      trace.inputSize = source.length;
      if (node.op === "take") {
        const count = Number(node.args.count ?? 0);
        return source.slice(0, count);
      }
      throw new Error(`compute op “${node.op}” 尚未实现`);
    }
    case "return": {
      return ctx.store.get(node.value);
    }
  }
}

export async function executeNode(node: ExecutionNode, ctx: ExecutionContext): Promise<unknown> {
  const started = performance.now();
  const trace: TraceEntry = { id: node.id, kind: nodeKindLabel(node), status: "success", durationMs: 0 };
  try {
    const value = await runNode(node, ctx, trace);
    trace.outputSize = valueSize(value);
    return value;
  } catch (error) {
    trace.status = "error";
    trace.error = (error as Error).message;
    throw error;
  } finally {
    trace.durationMs = Math.round(performance.now() - started);
    ctx.trace.push(trace);
  }
}
