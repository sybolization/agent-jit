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
/** enum 值的基类型：全字符串 → "string"；全数字 → "number"；混编 → "mixed"（values 非空）。 */
export function enumBaseOf(values) {
    const hasString = values.some((value) => typeof value === "string");
    const hasNumber = values.some((value) => typeof value === "number");
    if (hasString && hasNumber)
        return "mixed";
    return hasString ? "string" : "number";
}
/** 从 raw 节点提取语义标签（schema property 的 description；非空字符串才保留）。 */
function descriptionOf(node) {
    return typeof node.description === "string" && node.description.length > 0 ? node.description : undefined;
}
/** 提取合法 enum 成员（enum 数组或 const 单值；过滤到 string|number，非空才构成 enum）。 */
function enumMembersOf(node) {
    const raw = Array.isArray(node.enum) ? node.enum : node.const !== undefined ? [node.const] : undefined;
    if (raw === undefined)
        return undefined;
    const members = raw.filter((item) => typeof item === "string" || typeof item === "number");
    return members.length > 0 ? members : undefined;
}
/**
 * 把 JSON Schema / TypeBox schema 归一为 SchemaView；无法识别 → unknown。
 * 每个节点携带自身 schema 的 description（语义标签）——DSL 签名层据此
 * 递归渲染 `key: type[label]`，嵌套 object/array 的标签不再丢失，
 * 也不再需要 dslSignature 对 raw JSON Schema 做二次 traversal。
 */
export function schemaViewOf(schema) {
    const node = (schema ?? {});
    const description = descriptionOf(node);
    // enum / const：字面量枚举——覆盖 TypeBox Type.Enum 的无 type 形态（{enum:[...]}）、
    // DSH JSON Schema 形态（{type:..., enum:[...]}）与 const 单值（{type:..., const: 值}）。
    // 必须先于 union：任一形态都要保留合法取值，而不是把成员抹成 base 类型。
    const enumMembers = enumMembersOf(node);
    if (enumMembers !== undefined) {
        return { kind: "enum", values: enumMembers, ...(description !== undefined ? { description } : {}) };
    }
    // union：anyOf / oneOf 取成员（typebox Type.Union 输出 anyOf）
    const unionMembers = node.anyOf ?? node.oneOf;
    if (Array.isArray(unionMembers) && unionMembers.length > 0) {
        return { kind: "union", members: unionMembers.map(schemaViewOf), ...(description !== undefined ? { description } : {}) };
    }
    switch (node.type) {
        case "string":
            return { kind: "string", ...(description !== undefined ? { description } : {}) };
        case "integer":
            return { kind: "integer", ...(description !== undefined ? { description } : {}) };
        case "number":
            return { kind: "number", ...(description !== undefined ? { description } : {}) };
        case "boolean":
            return { kind: "boolean", ...(description !== undefined ? { description } : {}) };
        case "null":
            return { kind: "null", ...(description !== undefined ? { description } : {}) };
        case "array": {
            const items = schemaViewOf(node.items);
            if (items.kind === "unknown")
                return { kind: "unknown", ...(description !== undefined ? { description } : {}) };
            return { kind: "array", items, ...(description !== undefined ? { description } : {}) };
        }
        case "object": {
            // patternProperties / additionalProperties（对象 schema）→ record<T>
            const patternValues = node.patternProperties ? Object.values(node.patternProperties) : [];
            const patternValue = patternValues[0];
            if (patternValue !== undefined) {
                const value = schemaViewOf(patternValue);
                return value.kind === "unknown"
                    ? { kind: "unknown", ...(description !== undefined ? { description } : {}) }
                    : { kind: "record", value, ...(description !== undefined ? { description } : {}) };
            }
            if (typeof node.additionalProperties === "object" && node.additionalProperties !== null) {
                const value = schemaViewOf(node.additionalProperties);
                return value.kind === "unknown"
                    ? { kind: "unknown", ...(description !== undefined ? { description } : {}) }
                    : { kind: "record", value, ...(description !== undefined ? { description } : {}) };
            }
            const properties = {};
            for (const [key, prop] of Object.entries(node.properties ?? {})) {
                properties[key] = schemaViewOf(prop);
            }
            return {
                kind: "object",
                properties,
                required: node.required ?? [],
                ...(description !== undefined ? { description } : {}),
            };
        }
        default:
            return { kind: "unknown", ...(description !== undefined ? { description } : {}) };
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
        case "enum":
            return view.values.map((value) => JSON.stringify(value)).join(" | ");
        case "unknown":
            return "unknown";
    }
}
