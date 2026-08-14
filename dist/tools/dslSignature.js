/**
 * DSL 工具签名层：把 JSON Schema / TypeBox schema 归一为紧凑的 DslType 表示，
 * 并渲染为 `id(params) -> returns` 的紧凑签名。
 *
 * 类型判断**只有一套**：结构归一化统一走 `schemaViewOf`（src/tools/schemaView.ts），
 * 这里只做 SchemaView → DslType 的映射；字段语义标签（label）来自 SchemaView
 * 节点自带的 description 元数据（schemaViewOf 递归归一，嵌套 object/array 的
 * 字段标签完整保留）——不再对 raw JSON Schema 做二次 traversal。
 */
import { schemaViewOf } from "./schemaView.js";
/** 把 canonical SchemaView 映射为 DslType；字段语义标签直接取自 SchemaView 节点的 description。 */
export function dslTypeFromSchemaView(view) {
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
            return { kind: "list", items: dslTypeFromSchemaView(view.items) };
        case "object": {
            const fields = Object.entries(view.properties).map(([name, prop]) => {
                const field = { name, type: dslTypeFromSchemaView(prop) };
                if (prop.description !== undefined)
                    field.label = prop.description;
                return field;
            });
            return { kind: "object", fields };
        }
        case "record":
            return { kind: "record", value: dslTypeFromSchemaView(view.value) };
        case "union":
            return { kind: "union", members: view.members.map((member) => dslTypeFromSchemaView(member)) };
        case "unknown":
            return { kind: "unknown" };
    }
}
/** 便捷：JSON Schema → DslType（字段语义标签由 schemaViewOf 递归归一携带）。 */
export function dslTypeOf(schema) {
    return dslTypeFromSchemaView(schemaViewOf(schema));
}
/** 把 ToolContract 归一为 DslToolSignature：id + 参数（含 required）+ 返回类型（含嵌套字段标签）。 */
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
    return {
        id: contract.id,
        parameters,
        returns: dslTypeFromSchemaView(outputView),
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
