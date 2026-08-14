import type { ExecutionNode } from "../compiler/ir.js";
import type { RuntimeRegistry } from "./runtime.js";
import { type TraceEntry } from "./trace.js";
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
/** 并发受限的数组映射：最多 concurrency 个任务同时进行，保持输出顺序。 */
export declare function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
/**
 * 通用值比较（sort 的 closed comparator）：两侧都是 number → 数值比较；
 * 都是 string → 字典序；字段缺失（undefined）视为最小；其余类型先转数值，
 * NaN 视为最小。executor 的 compute.sort 与 benchmark 的确定性答案共用，
 * 保证"执行语义 == oracle 语义"。
 */
export declare function compareValues(a: unknown, b: unknown): number;
export declare function executeNode(node: ExecutionNode, ctx: ExecutionContext): Promise<unknown>;
