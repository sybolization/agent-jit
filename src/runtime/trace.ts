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
export function valueSize(value: unknown): number {
  return Array.isArray(value) ? value.length : 1;
}

export function renderTraceText(entries: readonly TraceEntry[], totalDurationMs: number, runId: string): string {
  const lines: string[] = [runId, "─".repeat(30), ""];
  for (const entry of entries) {
    lines.push(entry.id);
    lines.push(`  kind: ${entry.kind}`);
    lines.push(`  status: ${entry.status}`);
    if (entry.fanout !== undefined) lines.push(`  fanout: ${entry.fanout}`);
    if (entry.concurrency !== undefined) lines.push(`  concurrency: ${entry.concurrency}`);
    if (entry.inputSize !== undefined) lines.push(`  input_size: ${entry.inputSize}`);
    if (entry.outputSize !== undefined) lines.push(`  output_size: ${entry.outputSize}`);
    if (entry.error !== undefined) lines.push(`  error: ${entry.error}`);
    lines.push(`  duration: ${entry.durationMs}ms`);
    lines.push("");
  }
  lines.push(`total: ${totalDurationMs}ms`);
  return lines.join("\n");
}
