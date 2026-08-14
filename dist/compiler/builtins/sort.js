import { applyPositionalArgs, literalArg, refArg } from "../helpers.js";
/**
 * sort：按字段排序（R4c closed operator）。
 * `sort(<source>, key=<字段名>, desc=<true|false>)` — source 位置参数（引用），
 * key 必填字符串字面量，desc 可选布尔字面量（默认 false 升序）。
 */
export function buildSortNode(statement, _options, defined, diagnostics) {
    const effective = applyPositionalArgs(statement, ["source"], diagnostics);
    if (!effective)
        return undefined;
    const source = refArg(effective, "source", defined, diagnostics);
    const key = literalArg(effective, "key", diagnostics, { required: true });
    let descValue = false;
    const desc = literalArg(effective, "desc", diagnostics);
    if (desc !== undefined && typeof desc !== "boolean") {
        diagnostics.push({
            line: statement.line,
            code: "config_type_mismatch",
            message: "sort 的参数“desc”期望布尔值",
            suggestion: "如 desc=true 或 desc=false",
        });
    }
    else if (desc !== undefined) {
        descValue = desc;
    }
    for (const arg of effective.args) {
        if (!["source", "key", "desc"].includes(arg.key ?? "")) {
            diagnostics.push({
                line: arg.line,
                code: "unknown_parameter",
                message: `sort 不支持参数“${arg.key}”`,
                suggestion: "sort 仅支持 source / key / desc",
            });
        }
    }
    if (key !== undefined && typeof key !== "string") {
        diagnostics.push({
            line: statement.line,
            code: "config_type_mismatch",
            message: "sort 的参数“key”应为字符串字段名",
            suggestion: '如 key="forks"',
        });
    }
    if (!source || typeof key !== "string")
        return undefined;
    return { id: statement.name, kind: "compute", op: "sort", source, args: { key, desc: descValue } };
}
