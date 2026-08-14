/**
 * 执行 Trace：每个节点的执行记录 + 文本渲染。
 *
 * 第一版记录确定性维度（duration / fanout / concurrency / input-output
 * size），为后续 benchmark 打底；加入 LLM 后同一结构再扩展
 * agent_calls / tokens / cache_read 等字段。
 */
export interface TraceEntry {
    id: string;
    kind: string;
    status: "success" | "error";
    durationMs: number;
    outputSize?: number;
    inputSize?: number;
    fanout?: number;
    concurrency?: number;
    error?: string;
}
/** 数组取长度，其余取 1（第一版足够区分集合输出）。 */
export declare function valueSize(value: unknown): number;
export declare function renderTraceText(entries: readonly TraceEntry[], totalDurationMs: number, runId: string): string;
