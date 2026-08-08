import type { ExecutionNode, ValueExpr } from "../compiler/ir.js";
import type { RuntimeRegistry } from "./runtime.js";
import { evalExpr, parseExpr } from "./expr.js";
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

/**
 * 通用值比较（sort 的 closed comparator）：两侧都是 number → 数值比较；
 * 都是 string → 字典序；字段缺失（undefined）视为最小；其余类型先转数值，
 * NaN 视为最小。executor 的 compute.sort 与 benchmark 的确定性答案共用，
 * 保证"执行语义 == oracle 语义"。
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : 1;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const aNum = typeof a === "number" ? a : Number(a);
  const bNum = typeof b === "number" ? b : Number(b);
  if (Number.isNaN(aNum)) return -1;
  if (Number.isNaN(bNum)) return 1;
  return aNum - bNum;
}

async function runNode(node: ExecutionNode, ctx: ExecutionContext, trace: TraceEntry): Promise<unknown> {
  switch (node.kind) {
    case "tool": {
      const tool = ctx.registry.get(node.tool);
      if (!tool) throw new Error(`未注册的工具：${node.tool}`);
      if (!tool.execute) throw new Error(`工具 ${node.tool} 未提供 execute 实现`);
      return tool.execute(resolveArgs(node.args, ctx.store));
    }
    case "map": {
      const source = ctx.store.get(node.source);
      if (!Array.isArray(source)) {
        throw new Error(`map 的 source “${node.source}” 不是数组（得到 ${typeof source}）`);
      }
      const tool = ctx.registry.get(node.tool);
      if (!tool) throw new Error(`map 引用了未注册的工具：${node.tool}`);
      if (!tool.execute) throw new Error(`map 引用的工具 ${node.tool} 未提供 execute 实现`);
      trace.fanout = source.length;
      trace.concurrency = node.concurrency;
      return mapLimit(source, node.concurrency, async (item) => {
        const itemRecord = item as Record<string, unknown>;
        const args: Record<string, unknown> = {};
        for (const [param, field] of Object.entries(node.bindings)) {
          args[param] = itemRecord[field];
        }
        return tool.execute!(args);
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
      if (node.op === "filter") {
        // 等值条件筛选：元素需满足全部 <字段> == <字面量> 才保留；非对象或缺字段 → 丢弃
        const filtered = source.filter((item) => {
          if (typeof item !== "object" || item === null) return false;
          const record = item as Record<string, unknown>;
          for (const [field, literal] of Object.entries(node.args)) {
            if (record[field] !== literal) return false;
          }
          return true;
        });
        return filtered;
      }
      if (node.op === "sort") {
        const key = String(node.args.key ?? "");
        const desc = node.args.desc === true;
        const compare = (left: unknown, right: unknown): number => {
          const a = (left as Record<string, unknown> | null)?.[key];
          const b = (right as Record<string, unknown> | null)?.[key];
          const base = compareValues(a, b);
          return desc ? -base : base;
        };
        // 稳定排序（ES2019 起 Array.prototype.sort 稳定），不修改源数组
        return [...source].sort((left, right) => compare(left, right));
      }
      if (node.op === "compute") {
        // 元素级字段计算：浅拷贝 + 按 <输出字段>=<表达式字符串> 计算新字段（按声明顺序）
        return source.map((item) => {
          const record =
            typeof item === "object" && item !== null ? { ...(item as Record<string, unknown>) } : {};
          for (const [out, exprSrc] of Object.entries(node.args)) {
            const parsed = parseExpr(String(exprSrc));
            if (!parsed.ok) throw new Error(`compute 表达式 "${exprSrc}" 解析失败：${parsed.error}`);
            record[out] = evalExpr(parsed.node, record);
          }
          return record;
        });
      }
      if (node.op === "select") {
        const parsed = parseExpr(String(node.args.pred ?? ""));
        if (!parsed.ok) throw new Error(`select 谓词 "${node.args.pred}" 解析失败：${parsed.error}`);
        return source.filter((item) => {
          if (typeof item !== "object" || item === null) return false;
          return evalExpr(parsed.node, item as Record<string, unknown>) === true;
        });
      }
      throw new Error(`compute op “${node.op}” 尚未实现`);
    }
    case "join": {
      const base = ctx.store.get(node.sources[0]!);
      if (!Array.isArray(base)) {
        throw new Error(`join 的基准 source “${node.sources[0]}” 不是数组（得到 ${typeof base}）`);
      }
      trace.inputSize = base.length;
      // 其余 source 按 key 建索引（同 key 后者覆盖前者，R4e 数据互斥路径不会冲突）
      const extraIndexes: Array<Map<string, Record<string, unknown>>> = [];
      for (const sourceName of node.sources.slice(1)) {
        const array = ctx.store.get(sourceName);
        if (!Array.isArray(array)) {
          throw new Error(`join 的 source “${sourceName}” 不是数组（得到 ${typeof array}）`);
        }
        const index = new Map<string, Record<string, unknown>>();
        for (const item of array) {
          if (typeof item !== "object" || item === null) continue;
          const record = item as Record<string, unknown>;
          const key = record[node.key];
          if (typeof key === "string") index.set(key, record);
        }
        extraIndexes.push(index);
      }
      return base.map((item) => {
        const record =
          typeof item === "object" && item !== null ? { ...(item as Record<string, unknown>) } : {};
        const key = record[node.key];
        if (typeof key === "string") {
          for (const index of extraIndexes) {
            const extra = index.get(key);
            if (!extra) continue;
            // 基准优先：已有字段不覆盖（两条路径都写 score，但同 key 只会命中一条）
            for (const [field, value] of Object.entries(extra)) {
              if (!(field in record)) record[field] = value;
            }
          }
        }
        return record;
      });
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
