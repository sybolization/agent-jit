/**
 * DSL 工具签名层：把 JSON Schema / TypeBox schema 归一为紧凑的 DslType 表示，
 * 并渲染为 `id(params) -> returns` 的紧凑签名。
 *
 * 类型判断**只有一套**：结构归一化统一走 `schemaViewOf`（src/tools/schemaView.ts），
 * 这里只做 SchemaView → DslType 的映射；字段语义标签（label）来自 schema property 的
 * `description`，通过单独的 metadata extraction（`collectFieldLabels`）读取，避免
 * 与 schemaView 重复实现一套 JSON Schema traversal。
 */
import { schemaViewOf } from "./schemaView.js";
/** 从原始 JSON Schema 提取顶层 object（或 array 元素 object）字段的 description 作为语义标签。 */
function collectFieldLabels(schema) {
    const node = (schema ?? {});
    let properties = node.properties;
    if (node.type === "array" && node.items !== null && typeof node.items === "object" && !Array.isArray(node.items)) {
        properties = node.items.properties;
    }
    const labels = {};
    for (const [name, prop] of Object.entries(properties ?? {})) {
        if (prop !== null && typeof prop === "object" && !Array.isArray(prop)) {
            const description = prop.description;
            if (typeof description === "string" && description.length > 0)
                labels[name] = description;
        }
    }
    return labels;
}
/** 把 canonical SchemaView 映射为 DslType；labels 提供对象字段的可选语义标签（来自 description）。 */
export function dslTypeFromSchemaView(view, labels = {}) {
    switch (view.kind) {
        case "string":
            return { kind: "str" };
        case "integer":
            return { kind: "int" };
        case "number":
            return { kind: "num" };
        case "boolean":
            return { kind: "bool" };
        case "null":
            return { kind: "null" };
        case "array":
            return { kind: "list", items: dslTypeFromSchemaView(view.items, labels) };
        case "object": {
            const fields = Object.entries(view.properties).map(([name, prop]) => {
                const field = { name, type: dslTypeFromSchemaView(prop, labels) };
                const label = labels[name];
                if (label !== undefined)
                    field.label = label;
                return field;
            });
            return { kind: "object", fields };
        }
        case "record":
            return { kind: "record", value: dslTypeFromSchemaView(view.value, labels) };
        case "union":
            return { kind: "union", members: view.members.map((member) => dslTypeFromSchemaView(member, labels)) };
        case "unknown":
            return { kind: "unknown" };
    }
}
/** 便捷：JSON Schema → DslType（不含字段语义标签；标签由 dslSignatureOf 单独提取）。 */
export function dslTypeOf(schema) {
    return dslTypeFromSchemaView(schemaViewOf(schema));
}
/** 把 ToolContract 归一为 DslToolSignature：id + 参数（含 required）+ 返回类型（含字段标签）。 */
export function dslSignatureOf(contract) {
    const raw = contract.inputSchema;
    const required = new Set(Array.isArray(raw.required) ? raw.required.filter((item) => typeof item === "string") : []);
    const inputView = schemaViewOf(contract.inputSchema);
    const parameters = inputView.kind === "object"
        ? Object.entries(inputView.properties).map(([name, prop]) => ({
            name,
            type: dslTypeFromSchemaView(prop),
            required: required.has(name),
        }))
        : [];
    const outputView = schemaViewOf(contract.outputSchema);
    const labels = collectFieldLabels(contract.outputSchema);
    return {
        id: contract.id,
        parameters,
        returns: dslTypeFromSchemaView(outputView, labels),
    };
}
/** 把 DslType 渲染为紧凑文本。 */
export function renderDslType(type, options = {}) {
    const { typeStyle = "compact", fieldLabels = false } = options;
    const spell = (compact, schema) => (typeStyle === "schema" ? schema : compact);
    switch (type.kind) {
        case "str":
            return spell("str", "string");
        case "int":
            return spell("int", "integer");
        case "num":
            return spell("num", "number");
        case "bool":
            return spell("bool", "boolean");
        case "null":
            return "null";
        case "list":
            return `list<${renderDslType(type.items, options)}>`;
        case "object": {
            const fields = type.fields
                .map((field) => {
                const rendered = renderDslType(field.type, options);
                return fieldLabels && field.label ? `${field.name}: ${rendered}[${field.label}]` : `${field.name}: ${rendered}`;
            })
                .join(", ");
            return `{${fields}}`;
        }
        case "record":
            return `Record<string, ${renderDslType(type.value, options)}>`;
        case "union":
            return type.members.map((member) => renderDslType(member, options)).join(" | ");
        case "unknown":
            return "unknown";
    }
}
/** 把 DslToolSignature 渲染为 `id(params) -> returns` 的紧凑签名。 */
export function renderDslSignature(signature, options = {}) {
    const { nameTransform = (id) => id } = options;
    const params = signature.parameters
        .map((param) => `${param.name}${param.required ? "" : "?"}: ${renderDslType(param.type, options)}`)
        .join(", ");
    const call = params.length > 0 ? `${nameTransform(signature.id)}(${params})` : `${nameTransform(signature.id)}()`;
    const line = `${call} -> ${renderDslType(signature.returns, options)}`;
    if (options.includeDescription && options.description) {
        return `${line}\n# ${options.description}`;
    }
    return line;
}
