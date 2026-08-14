/**
 * collect：把任意值（对象 / 数组 / 标量）按顺序包成一个新数组。
 *
 * `collect(<值1>, <值2>, ...)` — 位置参数全部是变量引用（≥1，≤20），
 * 输出是一个新数组 [值1, 值2, ...]，元素原样保留。
 *
 * 与 concat 的分工：concat 消费数组、做真正的列表拼接；collect 消费
 * 任意值、做"对象包装成数组"——宿主工具（bash / web_search / glob）多返回
 * 对象，collect 把它们合进一个数组后才能接 take / map 等数组操作。
 */
/** collect 的 source 数量上限（与 IR CollectNodeSchema.maxItems 一致；在此显式诊断而非 schema_invalid）。 */
const MAX_COLLECT_SOURCES = 20;
export function buildCollectNode(statement, _options, defined, diagnostics) {
    const sources = [];
    for (const arg of statement.args) {
        if (arg.key === undefined) {
            if (arg.value.kind !== "ref") {
                diagnostics.push({
                    line: arg.line,
                    code: "invalid_reference",
                    message: "collect 的参数必须是先前定义的变量引用",
                    suggestion: "如 collect(hits, proof)",
                });
                continue;
            }
            const name = arg.value.name ?? "";
            if (!defined.has(name)) {
                diagnostics.push({
                    line: arg.line,
                    code: "undefined_reference",
                    message: `collect 引用了未定义的变量“${name}”`,
                    suggestion: `“${name}”必须在 collect 之前定义`,
                });
                continue;
            }
            if (sources.length >= MAX_COLLECT_SOURCES) {
                diagnostics.push({
                    line: arg.line,
                    code: "TOO_MANY_POSITIONAL_ARGS",
                    message: `collect 最多 ${MAX_COLLECT_SOURCES} 个值（位置参数）`,
                    suggestion: `一条 collect 包 ${MAX_COLLECT_SOURCES} 个值；更多请拆分后用 concat 拼接`,
                });
                continue;
            }
            sources.push(name);
            continue;
        }
        diagnostics.push({
            line: arg.line,
            code: "unknown_parameter",
            message: `collect 不支持参数“${arg.key}”`,
            suggestion: "collect 仅支持位置参数（变量引用，≥1 个），无 key",
        });
    }
    if (sources.length < 1) {
        diagnostics.push({
            line: statement.line,
            code: "syntax",
            message: "collect 至少需要 1 个值（把任意值包成数组）",
            suggestion: "如 collect(hits, proof)",
        });
        return undefined;
    }
    return { id: statement.name, kind: "collect", sources };
}
