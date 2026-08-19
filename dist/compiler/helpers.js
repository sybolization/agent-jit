import { schemaViewOf } from "../tools/schemaView.js";
/**
 * Execution DSL 编译器共享 helper（Task 5 拆分自 compiler.ts）。
 *
 * 本文件只放无副作用、无派发职责的纯工具：字面量归一化 / 参数取值 /
 * 位置参数映射 / tool 参数契约 / 元素 schema 视图。构造 builder 见
 * `toolCall.ts` 与 `builtins/`，入口见 `compile.ts`。
 */
/** 节点排序：按 id 字典序（保证编译产物确定性）。 */
export function compareNodes(left, right) {
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
/**
 * unknown_tool 诊断的确定性近似建议文本：经 ToolIdResolver 的近似匹配，
 * 同时展示 host alias 与 canonical（如 "github_get_repository"（github.get_repository））；
 * 相似度太低 / 无工具目录时返回 undefined（诊断回退到通用提示）。
 */
export function suggestToolNames(tools, name) {
    if (!tools)
        return undefined;
    const suggestions = tools.suggestIds(name);
    if (suggestions.length === 0)
        return undefined;
    const list = suggestions
        .map(({ alias, canonical }) => (alias === canonical ? `“${canonical}”` : `“${alias}”（${canonical}）`))
        .join(" / ");
    return `你是否指 ${list}？`;
}
/** 原始类型 → ToolParamSpec.kind；enum → "enum"；其余（含 union/array/object/null/record）→ "unknown"。 */
function kindOfParam(view) {
    switch (view.kind) {
        case "string":
            return "string";
        case "integer":
            return "int";
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "enum":
            return "enum";
        default:
            return "unknown";
    }
}
export function toolParams(tool) {
    const view = schemaViewOf(tool.inputSchema);
    if (view.kind !== "object")
        return [];
    const required = new Set(view.required);
    return Object.entries(view.properties).map(([key, prop]) => {
        const kind = kindOfParam(prop);
        return {
            key,
            kind,
            ...(kind === "enum" && prop.kind === "enum" ? { legalValues: prop.values } : {}),
            required: required.has(key),
        };
    });
}
/** 从工具 outputSchema 提取元素 schema：array 取 items 的 object，object 取自身。 */
export function elementSchemaOf(definition) {
    if (!definition)
        return undefined;
    const view = schemaViewOf(definition.outputSchema);
    if (view.kind === "array" && view.items.kind === "object") {
        return { properties: view.items.properties };
    }
    if (view.kind === "object")
        return { properties: view.properties };
    return undefined;
}
/** 节点输出 → 元素 schema（编译循环随符号表维护）；compute 形状动态未知，join/concat 取第一个 source。 */
export function nodeElementSchema(node, tools, symbols, valueViews) {
    switch (node.kind) {
        case "tool":
        case "map":
            return tools ? elementSchemaOf(tools.get(node.tool)) : undefined;
        case "compute":
            // compute 会新增字段，元素形状不可静态确定 → 视为未知（避免 _.ratio 误报 UNKNOWN_FIELD）
            return undefined;
        case "join":
        case "concat":
            return symbols.get(node.sources[0]);
        case "project": {
            // 投影结果作为 map source 时的元素 schema：字段视图 array<object> → items；object → 自身。
            const sourceView = valueViews?.get(node.source);
            return sourceView ? projectElementSchema(sourceView, node.field) : undefined;
        }
        case "collect":
            // 异构集合，元素形状不可静态确定 → 未知（不误报）
            return undefined;
        case "return":
            return undefined;
    }
}
/**
 * 节点输出 → **值级** SchemaView（project 静态字段校验的事实源）。
 *
 * 与 nodeElementSchema 的区别：ElementSchema 是"扁平化元素形状"（array 时取
 * items），无法回答"这个变量的值本身是不是对象、有哪些字段"——而 project
 * 的静态校验需要值级形状。tool → outputSchema；map → array<items>；
 * compute/join/concat/collect 异构 → unknown；project → 源对象视图的字段视图；
 * return → 透传。无法静态确定时返回 undefined（不误报，运行时兜底）。
 */
export function nodeValueView(node, tools, valueViews) {
    switch (node.kind) {
        case "tool":
        case "map": {
            if (!tools)
                return undefined;
            const definition = tools.get(node.tool);
            if (!definition)
                return undefined;
            const view = schemaViewOf(definition.outputSchema);
            return node.kind === "map" && view.kind !== "unknown"
                ? { kind: "array", items: view }
                : view;
        }
        case "compute":
        case "join":
        case "concat":
        case "collect":
            return undefined;
        case "project": {
            const sourceView = valueViews.get(node.source);
            if (!sourceView)
                return undefined;
            return fieldViewOf(sourceView, node.field);
        }
        case "return":
            return valueViews.get(node.value);
    }
}
/** 对象视图上取字段视图（含 union 任一成员命中）；非对象 / 字段缺失 → undefined。 */
export function fieldViewOf(view, field) {
    if (view.kind === "object")
        return view.properties[field];
    if (view.kind === "union") {
        for (const member of view.members) {
            const found = fieldViewOf(member, field);
            if (found !== undefined)
                return found;
        }
    }
    return undefined;
}
/**
 * 投影字段视图 → 元素 schema（供 project 结果作为 map source 的绑定校验）：
 * array<object> → items 属性；object → 自身属性；其余 → undefined（未知）。
 */
export function projectElementSchema(sourceView, field) {
    const fieldView = fieldViewOf(sourceView, field);
    if (!fieldView)
        return undefined;
    if (fieldView.kind === "array" && fieldView.items.kind === "object") {
        return { properties: fieldView.items.properties };
    }
    if (fieldView.kind === "object")
        return { properties: fieldView.properties };
    return undefined;
}
export function normalizeLiteral(value, kind) {
    if (typeof value !== "string")
        return value;
    const text = value.trim();
    const normalized = kind.toLowerCase();
    if ((normalized === "int" || normalized === "integer") && /^[-+]?\d+$/.test(text))
        return Number(text);
    if ((normalized === "float" || normalized === "number") && text !== "" && Number.isFinite(Number(text))) {
        return Number(text);
    }
    if (normalized === "bool" || normalized === "boolean") {
        if (/^(true|1)$/i.test(text))
            return true;
        if (/^(false|0)$/i.test(text))
            return false;
    }
    return value;
}
export function literalKindError(value, parameterKey, kind, legalValues) {
    if (value === null || value === undefined)
        return null;
    const normalized = kind.toLowerCase();
    // enum：字面量必须属于合法取值集（错误从运行时提前到编译期）；无 legalValues 时放行（防御，不误报）
    if (normalized === "enum") {
        if (legalValues === undefined)
            return null;
        if (legalValues.includes(value))
            return null;
        return `参数“${parameterKey}”期望取值 ${legalValues.map((item) => JSON.stringify(item)).join(" | ")}，得到 ${JSON.stringify(value)}`;
    }
    // "unknown"（非原始类型参数）：不校验类型，保留 unknown（不误报，也不当 string 放行）
    if (normalized === "unknown")
        return null;
    if (normalized === "int" || normalized === "integer") {
        if (typeof value !== "number" || !Number.isInteger(value)) {
            return `参数“${parameterKey}”期望整数，得到 ${typeof value === "number" ? "非整数" : typeof value}`;
        }
    }
    else if (normalized === "float" || normalized === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return `参数“${parameterKey}”期望数字，得到 ${typeof value}`;
        }
    }
    else if (normalized === "bool" || normalized === "boolean") {
        if (typeof value !== "boolean")
            return `参数“${parameterKey}”期望布尔值，得到 ${typeof value}`;
    }
    else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return `参数“${parameterKey}”期望字符串/数字/布尔，得到 ${Array.isArray(value) ? "数组" : "对象"}`;
    }
    return null;
}
export function pushMissing(diagnostics, line, callee, key) {
    diagnostics.push({
        line,
        code: "syntax",
        message: `${callee} 缺少必填参数“${key}”`,
        suggestion: `为 ${callee} 补充 ${key}=<值>`,
    });
}
/** 取字面量参数；ref 或缺失时报错，返回 undefined。 */
export function literalArg(statement, key, diagnostics, options = {}) {
    const arg = statement.args.find((item) => item.key === key);
    if (!arg) {
        if (options.required)
            pushMissing(diagnostics, statement.line, statement.callee, key);
        return undefined;
    }
    if (arg.value.kind === "ref") {
        diagnostics.push({
            line: arg.line,
            code: "invalid_reference",
            message: `${statement.callee} 的参数“${key}”需要字面量，不能引用节点`,
            suggestion: `把 ${key} 写成字面量（如 ${key}="..."）`,
        });
        return undefined;
    }
    return arg.value.literal ?? null;
}
/** 取变量引用参数；literal、缺失或未定义时报错，返回引用名。 */
export function refArg(statement, key, defined, diagnostics) {
    const arg = statement.args.find((item) => item.key === key);
    if (!arg) {
        pushMissing(diagnostics, statement.line, statement.callee, key);
        return undefined;
    }
    if (arg.value.kind === "literal") {
        diagnostics.push({
            line: arg.line,
            code: "invalid_reference",
            message: `${statement.callee} 的参数“${key}”必须引用先前定义的变量`,
            suggestion: `把 ${key} 写成变量名（如 ${key}=<某条语句的变量名>）`,
        });
        return undefined;
    }
    const name = arg.value.name ?? "";
    if (!defined.has(name)) {
        diagnostics.push({
            line: arg.line,
            code: "undefined_reference",
            message: `${statement.callee} 引用了未定义的变量“${name}”`,
            suggestion: `“${name}”必须在 ${statement.callee} 之前定义`,
        });
        return undefined;
    }
    return name;
}
/**
 * 位置参数 → 命名参数映射（canonical：位置参数永远允许）。
 *
 * parser 中性支持位置参数（key 为 undefined）；canonical 语法冻结后
 * 位置参数是语言一部分（如 `map(repos, ...)`、`take(details, 3)`）。
 * 按 `slots` 顺序映射为命名参数；越界报 `TOO_MANY_POSITIONAL_ARGS`，
 * 与同名命名参数冲突报 `duplicate_argument`。
 */
export function applyPositionalArgs(statement, slots, diagnostics) {
    const positionalArgs = statement.args.filter((arg) => arg.key === undefined);
    if (positionalArgs.length === 0)
        return statement;
    const args = [...statement.args];
    positionalArgs.forEach((arg, index) => {
        const slot = slots[index];
        if (!slot) {
            diagnostics.push({
                line: arg.line,
                code: "TOO_MANY_POSITIONAL_ARGS",
                message: `${statement.callee} 的位置参数过多（最多 ${slots.length} 个）`,
                suggestion: `位置参数顺序：${slots.join(", ")}`,
            });
            return;
        }
        if (args.some((existing) => existing.key === slot)) {
            diagnostics.push({
                line: arg.line,
                code: "duplicate_argument",
                message: `参数“${slot}”被位置参数与命名参数同时提供`,
                suggestion: "只保留一种写法",
            });
            return;
        }
        args.push({ line: arg.line, key: slot, value: arg.value });
    });
    // 越界/冲突的位置参数已报错，丢弃避免后续 unknown_parameter 重复报
    return { ...statement, args: args.filter((arg) => arg.key !== undefined) };
}
