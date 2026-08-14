import { Value } from "typebox/value";
import { evalExpr } from "../language/expression.js";
import { valueSize } from "./trace.js";
function nodeKindLabel(node) {
    switch (node.kind) {
        case "tool":
            return "tool";
        case "map":
            return "map";
        case "compute":
            return `compute.${node.op}`;
        case "return":
            return "return";
        case "join":
            return "join";
        case "concat":
            return "concat";
    }
}
function resolveArgs(args, store) {
    const resolved = {};
    for (const [key, value] of Object.entries(args)) {
        resolved[key] = value.kind === "ref" ? store.get(value.name) : value.value;
    }
    return resolved;
}
/** REQ-2：工具输出必须匹配其声明的 outputSchema；不匹配抛错（由 executeNode 记入 trace）。 */
function validateToolOutput(toolId, schema, output) {
    if (Value.Check(schema, output))
        return;
    const first = Value.Errors(schema, output)[0];
    throw new Error(`TOOL_OUTPUT_SCHEMA_MISMATCH: 工具 ${toolId} 输出与声明 schema 不匹配${first ? `（${first.message}）` : ""}`);
}
/** REQ-3：工具入参必须匹配其声明的 inputSchema；不匹配抛错（execute 不应被调用）。 */
function validateToolInput(toolId, schema, input) {
    if (Value.Check(schema, input))
        return;
    const first = Value.Errors(schema, input)[0];
    throw new Error(`TOOL_INPUT_SCHEMA_MISMATCH: 工具 ${toolId} 入参与声明 schema 不匹配${first ? `（${first.message}）` : ""}`);
}
/** 并发受限的数组映射：最多 concurrency 个任务同时进行，保持输出顺序。 */
export async function mapLimit(items, concurrency, fn) {
    const results = new Array(items.length);
    const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length)
                return;
            results[index] = await fn(items[index], index);
        }
    }));
    return results;
}
/**
 * 通用值比较（sort 的 closed comparator）：两侧都是 number → 数值比较；
 * 都是 string → 字典序；字段缺失（undefined）视为最小；其余类型先转数值，
 * NaN 视为最小。executor 的 compute.sort 与 benchmark 的确定性答案共用，
 * 保证"执行语义 == oracle 语义"。
 */
export function compareValues(a, b) {
    if (a === b)
        return 0;
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    if (typeof a === "string" && typeof b === "string")
        return a < b ? -1 : 1;
    if (a === undefined)
        return -1;
    if (b === undefined)
        return 1;
    const aNum = typeof a === "number" ? a : Number(a);
    const bNum = typeof b === "number" ? b : Number(b);
    if (Number.isNaN(aNum))
        return -1;
    if (Number.isNaN(bNum))
        return 1;
    return aNum - bNum;
}
async function runNode(node, ctx, trace) {
    switch (node.kind) {
        case "tool": {
            const tool = ctx.registry.get(node.tool);
            if (!tool)
                throw new Error(`未注册的工具：${node.tool}`);
            const args = resolveArgs(node.args, ctx.store);
            validateToolInput(node.tool, tool.inputSchema, args);
            const output = await tool.execute(args);
            validateToolOutput(node.tool, tool.outputSchema, output);
            return output;
        }
        case "map": {
            const source = ctx.store.get(node.source);
            if (!Array.isArray(source)) {
                throw new Error(`map 的 source “${node.source}” 不是数组（得到 ${typeof source}）`);
            }
            const tool = ctx.registry.get(node.tool);
            if (!tool)
                throw new Error(`map 引用了未注册的工具：${node.tool}`);
            trace.fanout = source.length;
            trace.concurrency = node.concurrency;
            return mapLimit(source, node.concurrency, async (item) => {
                const itemRecord = item;
                const args = {};
                for (const [param, field] of Object.entries(node.bindings)) {
                    args[param] = itemRecord[field];
                }
                validateToolInput(node.tool, tool.inputSchema, args);
                const output = await tool.execute(args);
                validateToolOutput(node.tool, tool.outputSchema, output);
                return output;
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
                    if (typeof item !== "object" || item === null)
                        return false;
                    const record = item;
                    for (const [field, literal] of Object.entries(node.args)) {
                        if (record[field] !== literal)
                            return false;
                    }
                    return true;
                });
                return filtered;
            }
            if (node.op === "sort") {
                const key = String(node.args.key ?? "");
                const desc = node.args.desc === true;
                const compare = (left, right) => {
                    const a = left?.[key];
                    const b = right?.[key];
                    const base = compareValues(a, b);
                    return desc ? -base : base;
                };
                // 稳定排序（ES2019 起 Array.prototype.sort 稳定），不修改源数组
                return [...source].sort((left, right) => compare(left, right));
            }
            if (node.op === "compute") {
                // 元素级字段计算：浅拷贝 + 按 <输出字段>=<表达式> 计算新字段（按声明顺序）；
                // AST 在编译期已解析好并随 IR 携带（node.expr），执行只 eval 不再 parse
                const exprs = (node.expr ?? {});
                return source.map((item) => {
                    const record = typeof item === "object" && item !== null ? { ...item } : {};
                    for (const [out, exprSrc] of Object.entries(node.args)) {
                        const ast = exprs[out];
                        if (!ast)
                            throw new Error(`compute 节点缺少字段 "${out}" 的表达式 AST`);
                        record[out] = evalExpr(ast, record);
                    }
                    return record;
                });
            }
            if (node.op === "select") {
                const ast = node.expr?.["pred"];
                if (!ast)
                    throw new Error("select 节点缺少谓词 AST");
                return source.filter((item) => {
                    if (typeof item !== "object" || item === null)
                        return false;
                    return evalExpr(ast, item) === true;
                });
            }
            throw new Error(`compute op “${node.op}” 尚未实现`);
        }
        case "join": {
            const base = ctx.store.get(node.sources[0]);
            if (!Array.isArray(base)) {
                throw new Error(`join 的基准 source “${node.sources[0]}” 不是数组（得到 ${typeof base}）`);
            }
            trace.inputSize = base.length;
            // 其余 source 按 key 建索引（同 key 后者覆盖前者，R4e 数据互斥路径不会冲突）
            const extraIndexes = [];
            for (const sourceName of node.sources.slice(1)) {
                const array = ctx.store.get(sourceName);
                if (!Array.isArray(array)) {
                    throw new Error(`join 的 source “${sourceName}” 不是数组（得到 ${typeof array}）`);
                }
                const index = new Map();
                for (const item of array) {
                    if (typeof item !== "object" || item === null)
                        continue;
                    const record = item;
                    const key = record[node.key];
                    if (typeof key === "string")
                        index.set(key, record);
                }
                extraIndexes.push(index);
            }
            return base.map((item) => {
                const record = typeof item === "object" && item !== null ? { ...item } : {};
                const key = record[node.key];
                if (typeof key === "string") {
                    for (const index of extraIndexes) {
                        const extra = index.get(key);
                        if (!extra)
                            continue;
                        // 基准优先：已有字段不覆盖（两条路径都写 score，但同 key 只会命中一条）
                        for (const [field, value] of Object.entries(extra)) {
                            if (!(field in record))
                                record[field] = value;
                        }
                    }
                }
                return record;
            });
        }
        case "concat": {
            const arrays = [];
            let total = 0;
            for (const sourceName of node.sources) {
                const array = ctx.store.get(sourceName);
                if (!Array.isArray(array)) {
                    throw new Error(`concat 的 source “${sourceName}” 不是数组（得到 ${typeof array}）`);
                }
                arrays.push(array);
                total += array.length;
            }
            trace.inputSize = total;
            return arrays.flat();
        }
        case "return": {
            return ctx.store.get(node.value);
        }
    }
}
export async function executeNode(node, ctx) {
    const started = performance.now();
    const trace = { id: node.id, kind: nodeKindLabel(node), status: "success", durationMs: 0 };
    try {
        const value = await runNode(node, ctx, trace);
        trace.outputSize = valueSize(value);
        return value;
    }
    catch (error) {
        trace.status = "error";
        trace.error = error.message;
        throw error;
    }
    finally {
        trace.durationMs = Math.round(performance.now() - started);
        ctx.trace.push(trace);
    }
}
