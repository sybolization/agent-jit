import { schemaViewOf } from "./schemaView.js";
const LEAF_KINDS = new Set(["string", "integer", "number", "boolean"]);
/** 叶子类型兼容：同 kind，或 integer ↔ number（integer 是 number 的子集）。 */
function typeCompatible(left, right) {
    if (left.kind === right.kind)
        return true;
    return ((left.kind === "integer" && right.kind === "number") ||
        (left.kind === "number" && right.kind === "integer"));
}
/** 收集工具的"输出字段"（对象 / 数组元素对象），返回 tool id → 字段 map。 */
function outputFields(contract) {
    const view = schemaViewOf(contract.outputSchema);
    if (view.kind === "array" && view.items.kind === "object") {
        return { fromArray: true, fields: new Map(Object.entries(view.items.properties)) };
    }
    if (view.kind === "object") {
        return { fromArray: false, fields: new Map(Object.entries(view.properties)) };
    }
    return undefined;
}
/** 收集工具的"input 参数"（对象 schema 的属性）。 */
function inputParams(contract) {
    const view = schemaViewOf(contract.inputSchema);
    if (view.kind !== "object")
        return undefined;
    return new Map(Object.entries(view.properties));
}
/**
 * 确定性推导局部兼容连接。只使用传入的 contracts 子集（调用方传"本次 describe 请求的工具"）。
 */
export function deriveCompositionHints(contracts) {
    const outputs = contracts
        .map((contract) => ({ tool: contract.id, ...outputFields(contract) }))
        .filter((entry) => entry.fields !== undefined);
    const inputs = contracts
        .map((contract) => ({ tool: contract.id, params: inputParams(contract) }))
        .filter((entry) => entry.params !== undefined);
    const hints = [];
    for (const out of outputs) {
        for (const [field, fieldView] of out.fields) {
            if (!LEAF_KINDS.has(fieldView.kind))
                continue;
            for (const input of inputs) {
                if (input.tool === out.tool)
                    continue; // 排除自引用
                const paramView = input.params.get(field);
                if (paramView === undefined)
                    continue;
                if (!LEAF_KINDS.has(paramView.kind))
                    continue;
                if (!typeCompatible(fieldView, paramView))
                    continue;
                hints.push({
                    fromTool: out.tool,
                    fromField: field,
                    fromArray: out.fromArray,
                    toTool: input.tool,
                    toParam: field,
                    type: fieldView.kind,
                });
            }
        }
    }
    // 去重 + 确定性排序（fromTool → fromField → toTool → toParam）
    const seen = new Set();
    const unique = [];
    for (const hint of hints) {
        const key = `${hint.fromTool}|${hint.fromField}|${hint.fromArray}|${hint.toTool}|${hint.toParam}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(hint);
    }
    unique.sort((left, right) => left.fromTool.localeCompare(right.fromTool) ||
        left.fromField.localeCompare(right.fromField) ||
        left.toTool.localeCompare(right.toTool) ||
        left.toParam.localeCompare(right.toParam));
    return unique;
}
/**
 * 渲染 `## Compatible bindings` 段（供 jit_describe_tools 追加；无 hint 时返回空串）。
 * 数组元素字段渲染为 `tool[].field`，单对象字段渲染为 `tool.field`。
 */
export function renderCompositionBindings(catalog, ids) {
    const contracts = ids
        .map((id) => catalog.get(id))
        .filter((contract) => contract !== undefined);
    const hints = deriveCompositionHints(contracts);
    if (hints.length === 0)
        return "";
    const lines = hints.map((hint) => {
        const from = hint.fromArray ? `${hint.fromTool}[].${hint.fromField}` : `${hint.fromTool}.${hint.fromField}`;
        return `${from}\n  → ${hint.toTool}(${hint.toParam})`;
    });
    return ["## Compatible bindings", "", ...lines].join("\n");
}
