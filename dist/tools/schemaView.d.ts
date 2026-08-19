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
export type SchemaView = {
    kind: "string";
    description?: string;
} | {
    kind: "integer";
    description?: string;
} | {
    kind: "number";
    description?: string;
} | {
    kind: "boolean";
    description?: string;
} | {
    kind: "null";
    description?: string;
} | {
    kind: "array";
    items: SchemaView;
    description?: string;
} | {
    kind: "object";
    properties: Record<string, SchemaView>;
    required: readonly string[];
    description?: string;
} | {
    kind: "record";
    value: SchemaView;
    description?: string;
} | {
    kind: "union";
    members: readonly SchemaView[];
    description?: string;
} | {
    kind: "enum";
    values: readonly (string | number)[];
    description?: string;
} | {
    kind: "unknown";
    description?: string;
};
/** enum 值的基类型：全字符串 → "string"；全数字 → "number"；混编 → "mixed"（values 非空）。 */
export declare function enumBaseOf(values: readonly (string | number)[]): "string" | "number" | "mixed";
/**
 * 把 JSON Schema / TypeBox schema 归一为 SchemaView；无法识别 → unknown。
 * 每个节点携带自身 schema 的 description（语义标签）——DSL 签名层据此
 * 递归渲染 `key: type[label]`，嵌套 object/array 的标签不再丢失，
 * 也不再需要 dslSignature 对 raw JSON Schema 做二次 traversal。
 */
export declare function schemaViewOf(schema: unknown): SchemaView;
/** 把 SchemaView 渲染为人类可读文本（catalog 与诊断共用）。 */
export declare function schemaViewText(view: SchemaView): string;
