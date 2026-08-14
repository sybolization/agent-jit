import { pushMissing } from "../helpers.js";
/**
 * merge_by_key（R4e 遗留关键字 join 的 canonical 名称；join 保留为别名，编译产物同一节点）：
 * 多输入按 key 合并字段——语义是"给每条基准记录附加另一批数据的字段"，**不是**对称合并。
 * `merge_by_key(<base>, <source2>, ...≥2, key="<字段>")` — 位置参数全部是 source（数量不定），
 * sources[0] 为基准（base），其余按 key 匹配后附加字段（基准已有字段不覆盖）。
 *
 * 与 concat（列表拼接）的分工：需要"把两段列表接在一起"时用 concat；需要
 * "按 key 把另一批数据的字段附加到每条记录"时用 merge_by_key。
 */
export function buildJoinNode(statement, _options, defined, diagnostics) {
    const sources = [];
    let key;
    for (const arg of statement.args) {
        if (arg.key === undefined) {
            if (arg.value.kind !== "ref") {
                diagnostics.push({
                    line: arg.line,
                    code: "invalid_reference",
                    message: "merge_by_key 的 source 参数必须是先前定义的变量引用",
                    suggestion: '如 merge_by_key(details, contrib, commit, key="full_name")',
                });
                continue;
            }
            const name = arg.value.name ?? "";
            if (!defined.has(name)) {
                diagnostics.push({
                    line: arg.line,
                    code: "undefined_reference",
                    message: `merge_by_key 引用了未定义的变量“${name}”`,
                    suggestion: `“${name}”必须在 merge_by_key 之前定义`,
                });
                continue;
            }
            sources.push(name);
            continue;
        }
        if (arg.key === "key") {
            if (arg.value.kind !== "literal" || typeof arg.value.literal !== "string") {
                diagnostics.push({
                    line: arg.line,
                    code: "config_type_mismatch",
                    message: "merge_by_key 的参数“key”需要字符串字面量（两个列表匹配的字段名）",
                    suggestion: '如 key="full_name"',
                });
            }
            else {
                key = arg.value.literal;
            }
            continue;
        }
        diagnostics.push({
            line: arg.line,
            code: "unknown_parameter",
            message: `merge_by_key 不支持参数“${arg.key}”`,
            suggestion: "merge_by_key 仅支持位置参数 source（≥2 个）与 key",
        });
    }
    if (!key)
        pushMissing(diagnostics, statement.line, "merge_by_key", "key");
    if (sources.length < 2) {
        diagnostics.push({
            line: statement.line,
            code: "syntax",
            message: "merge_by_key 至少需要 2 个 source（第一个是基准，其余按 key 附加字段）",
            suggestion: '如 merge_by_key(details, contrib, commit, key="full_name")',
        });
    }
    if (sources.length < 2 || !key)
        return undefined;
    return { id: statement.name, kind: "join", sources, key };
}
