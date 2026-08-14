/**
 * 归一化的 schema 视图层：把 JSON Schema / TypeBox schema 映射为 SchemaView。
 *
 * Compiler（toolParams / elementSchemaOf / map 绑定字段类型匹配）与 catalog
 * renderer 共用这一层；无法识别的类型保留 `unknown`，**不默认解释成 string**。
 *
 * 覆盖：string / integer / number / boolean / null / array<T> / object{...} /
 * record<T> / union<...> / unknown（识别 anyOf / oneOf、嵌套 items / properties /
 * patternProperties / additionalProperties）。
 */
/** 把 JSON Schema / TypeBox schema 归一为 SchemaView；无法识别 → unknown。 */
export function schemaViewOf(schema) {
    const node = (schema ?? {});
    // union：anyOf / oneOf 取成员（typebox Type.Union 输出 anyOf）
    const unionMembers = node.anyOf ?? node.oneOf;
    if (Array.isArray(unionMembers) && unionMembers.length > 0) {
        return { kind: "union", members: unionMembers.map(schemaViewOf) };
    }
    switch (node.type) {
        case "string":
            return { kind: "string" };
        case "integer":
            return { kind: "integer" };
        case "number":
            return { kind: "number" };
        case "boolean":
            return { kind: "boolean" };
        case "null":
            return { kind: "null" };
        case "array": {
            const items = schemaViewOf(node.items);
            return items.kind === "unknown" ? { kind: "unknown" } : { kind: "array", items };
        }
        case "object": {
            // patternProperties / additionalProperties（对象 schema）→ record<T>
            const patternValues = node.patternProperties ? Object.values(node.patternProperties) : [];
            const patternValue = patternValues[0];
            if (patternValue !== undefined) {
                const value = schemaViewOf(patternValue);
                return value.kind === "unknown" ? { kind: "unknown" } : { kind: "record", value };
            }
            if (typeof node.additionalProperties === "object" && node.additionalProperties !== null) {
                const value = schemaViewOf(node.additionalProperties);
                return value.kind === "unknown" ? { kind: "unknown" } : { kind: "record", value };
            }
            const properties = {};
            for (const [key, prop] of Object.entries(node.properties ?? {})) {
                properties[key] = schemaViewOf(prop);
            }
            return { kind: "object", properties, required: node.required ?? [] };
        }
        default:
            return { kind: "unknown" };
    }
}
/** 把 SchemaView 渲染为人类可读文本（catalog 与诊断共用）。 */
export function schemaViewText(view) {
    switch (view.kind) {
        case "string":
            return "string";
        case "integer":
            return "integer";
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "array":
            return `list<${schemaViewText(view.items)}>`;
        case "object": {
            const fields = Object.entries(view.properties)
                .map(([key, prop]) => `${key}: ${schemaViewText(prop)}`)
                .join(", ");
            return `{ ${fields} }`;
        }
        case "record":
            return `Record<string, ${schemaViewText(view.value)}>`;
        case "union":
            return view.members.map(schemaViewText).join(" | ");
        case "unknown":
            return "unknown";
    }
}
