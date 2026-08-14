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
} | {
    kind: "integer";
} | {
    kind: "number";
} | {
    kind: "boolean";
} | {
    kind: "null";
} | {
    kind: "array";
    items: SchemaView;
} | {
    kind: "object";
    properties: Record<string, SchemaView>;
    required: readonly string[];
} | {
    kind: "record";
    value: SchemaView;
} | {
    kind: "union";
    members: readonly SchemaView[];
} | {
    kind: "unknown";
};
/** 把 JSON Schema / TypeBox schema 归一为 SchemaView；无法识别 → unknown。 */
export declare function schemaViewOf(schema: unknown): SchemaView;
/** 把 SchemaView 渲染为人类可读文本（catalog 与诊断共用）。 */
export declare function schemaViewText(view: SchemaView): string;
