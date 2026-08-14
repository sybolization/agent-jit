/** 常见诊断 code → "期望语义"提示（一次修复成功率的关键：明确指出错在哪、期望是什么）。 */
const FIX_HINTS = {
    unknown_tool: "期望：已注册业务工具 id，或语言关键字 map / take / filter / sort / compute / select / merge_by_key / concat / return",
    unknown_parameter: "期望：只使用该工具契约声明的参数名（见 active tool 的 DSL signature），不得自创参数",
    UNKNOWN_FIELD: "期望：绑定字段 _.字段 必须来自上游工具输出 schema（见契约的输出字段）",
    MAP_BINDING_REF_INVALID: "期望：绑定值必须形如 _.字段（引用当前元素），不能是字面量或外部变量",
    undefined_reference: "期望：被引用的变量必须在该语句之前定义（不允许前向引用）",
    duplicate_name: "期望：变量名必须唯一，改名后重新定义",
    duplicate_argument: "期望：每个参数只能赋值一次",
    invalid_reference: "期望：该参数必须是先前定义的变量引用（或字面量，见具体说明）",
    config_type_mismatch: "期望：字面量类型/形状必须与契约声明的参数类型一致",
    expression_invalid: "期望：compute 表达式 = 字段引用 + 数字 + 四则运算 + 括号；select 谓词 = 顶层比较（> >= < <= == !=）",
    TOO_MANY_POSITIONAL_ARGS: "期望：位置参数数量不超过该关键字定义的槽位（顺序见提示）",
    syntax: "期望：语句形如 <变量> = <调用>(<参数>, ...)，检查标点、引号与参数形式",
    missing_return: "期望：程序必须包含且仅包含一条 terminal return（最后一行 return <变量>，变量必须已定义）",
    duplicate_return: "期望：只保留一条 return（最终输出那一条），删除其余 return",
};
/** 编译诊断 code → JIT 层紧凑 code（R6.1：只映射编译器能给出结构化字段的 4 类）。 */
const MAPPED_COMPILE_CODES = {
    unknown_tool: "UNKNOWN_TOOL",
    unknown_parameter: "UNKNOWN_ARGUMENT",
    UNKNOWN_FIELD: "UNKNOWN_OUTPUT_FIELD",
    config_type_mismatch: "TYPE_MISMATCH",
};
/**
 * R6.1：把编译诊断拆为可结构化渲染的 mapped 与需 prose 回退的 unmapped。
 * mapped 携带 line + 编译器确定的结构化字段（tool/argument/field/...），
 * unmapped 原样保留（编译器拿不出结构化字段的 code）。
 */
export function toJitDiagnostics(diagnostics) {
    const mapped = [];
    const unmapped = [];
    for (const item of diagnostics) {
        const code = MAPPED_COMPILE_CODES[item.code];
        if (!code) {
            unmapped.push(item);
            continue;
        }
        mapped.push({
            code,
            line: item.line,
            tool: item.tool,
            argument: item.argument,
            field: item.field,
            availableFields: item.availableFields,
            legalArguments: item.legalArguments,
            suggestions: item.suggestions,
            expected: item.expected,
            actual: item.actual,
        });
    }
    return { mapped, unmapped };
}
/** 供测试/调用方直接构造 JitCompileFailure（只含可结构化渲染的诊断）。 */
export function toJitCompileFailure(diagnostics) {
    return { status: "compile_error", diagnostics: toJitDiagnostics(diagnostics).mapped };
}
/** 单条诊断的旧 prose 行（unmapped 回退渲染与 compileErrorFeedback 共用）。 */
function diagnosticProseLine(item) {
    const hint = FIX_HINTS[item.code];
    const parts = [`L${item.line}: ${item.code}: ${item.message}`];
    if (item.suggestion)
        parts.push(`（${item.suggestion}）`);
    if (hint)
        parts.push(`——${hint}`);
    return parts.join("");
}
/** 编译失败的诊断反馈（模型据此一次修复；每条附"期望语义"）。 */
export function compileErrorFeedback(error) {
    return [
        "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
        ...error.diagnostics.map(diagnosticProseLine),
    ].join("\n");
}
/** R6.1：mapped 诊断的紧凑行（机器可解析，供模型一次修复）。 */
function renderMappedDiagnosticLine(item) {
    const prefix = `L${item.line}`;
    switch (item.code) {
        case "UNKNOWN_OUTPUT_FIELD": {
            const target = item.field !== undefined ? `_.${item.field}` : "_";
            const available = item.availableFields?.length ? `[${item.availableFields.join(", ")}]` : "[]";
            return `${prefix} UNKNOWN_OUTPUT_FIELD: ${target} → 可用字段: ${available}`;
        }
        case "UNKNOWN_ARGUMENT": {
            const legal = item.legalArguments?.length ? `[${item.legalArguments.join(", ")}]` : "[]";
            return `${prefix} UNKNOWN_ARGUMENT: ${item.argument ?? ""} → 合法参数: ${legal}`;
        }
        case "UNKNOWN_TOOL": {
            const suggestions = item.suggestions ? item.suggestions.slice(0, 2) : [];
            const list = suggestions.length ? `[${suggestions.join(", ")}]` : "[]";
            return `${prefix} UNKNOWN_TOOL: ${item.tool ?? ""} → 建议: ${list}`;
        }
        case "TYPE_MISMATCH": {
            const target = item.argument ?? item.field ?? "";
            return `${prefix} TYPE_MISMATCH: ${target} 期望 ${item.expected ?? "unknown"}，实际 ${item.actual ?? "unknown"}`;
        }
    }
}
/**
 * R6.1：编译失败的紧凑反馈——mapped 诊断输出结构化行，unmapped 保留 prose；
 * 头部固定以“编译失败”开头（测试依赖此前缀），尾部给出一行修复指令。
 */
export function renderCompileFailure(error) {
    const { mapped, unmapped } = toJitDiagnostics(error.diagnostics);
    return [
        "编译失败：",
        ...mapped.map(renderMappedDiagnosticLine),
        ...unmapped.map(diagnosticProseLine),
        "请根据上述诊断修正 DSL 后再次调用 jit_execute_program 重新提交。",
    ].join("\n");
}
