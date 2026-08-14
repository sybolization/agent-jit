import type { ExecutionGraph } from "../compiler/ir.js";
import type { RegisteredTool } from "../tools/definition.js";
import type { ToolCatalog } from "../tools/registry.js";
import { type TraceEntry } from "./trace.js";
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
/** runtime 工具目录：ToolCatalog 之上，get/all 保证返回已绑定 execute 的 RegisteredTool。 */
export interface RuntimeCatalog extends ToolCatalog {
    get(id: string): RegisteredTool | undefined;
    all(): readonly RegisteredTool[];
}
export type RuntimeRegistry = RuntimeCatalog;
/** 执行结果判别联合：成功带 result；失败带 error（trace 中对应节点 status="error"）。 */
export type ExecutionResult = {
    status: "success";
    result: unknown;
    trace: readonly TraceEntry[];
    totalDurationMs: number;
} | {
    status: "failed";
    error: string;
    trace: readonly TraceEntry[];
    totalDurationMs: number;
};
export declare function execute(graph: ExecutionGraph, registry: RuntimeRegistry): Promise<ExecutionResult>;
