/**
 * DSL 工具签名层：把 JSON Schema / TypeBox schema 归一为紧凑的 DslType 表示，
 * 并渲染为 `id(params) -> returns` 的紧凑签名。
 *
 * 类型判断**只有一套**：结构归一化统一走 `schemaViewOf`（src/tools/schemaView.ts），
 * 这里只做 SchemaView → DslType 的映射；字段语义标签（label）来自 SchemaView
 * 节点自带的 description 元数据（schemaViewOf 递归归一，嵌套 object/array 的
 * 字段标签完整保留）——不再对 raw JSON Schema 做二次 traversal。
 */
import type { ToolContract } from "./definition.js";
import { type SchemaView } from "./schemaView.js";
/** DSL 面向的紧凑类型表示（结构镜像 SchemaView，但用 DSL 原生拼写与元数据）。 */
export type DslType = {
    kind: "str";
} | {
    kind: "int";
} | {
    kind: "num";
} | {
    kind: "bool";
} | {
    kind: "null";
} | {
    kind: "list";
    items: DslType;
} | {
    kind: "object";
    fields: readonly DslField[];
} | {
    kind: "record";
    value: DslType;
} | {
    kind: "union";
    members: readonly DslType[];
} | {
    kind: "unknown";
};
export interface DslField {
    name: string;
    type: DslType;
    /** 可选语义标签，来自该字段 schema 的 description（用于 opaque 工具渲染 key: type[label]）。 */
    label?: string;
}
export interface DslParameter {
    name: string;
    type: DslType;
    required: boolean;
}
export interface DslToolSignature {
    id: string;
    parameters: readonly DslParameter[];
    returns: DslType;
}
export interface RenderDslSignatureOptions {
    /** 在签名行后追加 `# <description>` 注释（catalog 风格）。缺省 false。 */
    includeDescription?: boolean;
    /** 类型拼写：compact = str/int/num/bool；schema = string/integer/number/boolean。缺省 "compact"。 */
    typeStyle?: "compact" | "schema";
    /** 对象字段带 label 时渲染为 `key: type[label]`。缺省 false。 */
    fieldLabels?: boolean;
    /** id 显示转换（如 canonical -> host alias）。缺省恒等。 */
    nameTransform?: (id: string) => string;
    /** 用于 includeDescription 渲染的描述文本（DslToolSignature 本身不携带 description）。 */
    description?: string;
}
/** 把 canonical SchemaView 映射为 DslType；字段语义标签直接取自 SchemaView 节点的 description。 */
export declare function dslTypeFromSchemaView(view: SchemaView): DslType;
/** 便捷：JSON Schema → DslType（字段语义标签由 schemaViewOf 递归归一携带）。 */
export declare function dslTypeOf(schema: unknown): DslType;
/** 把 ToolContract 归一为 DslToolSignature：id + 参数（含 required）+ 返回类型（含嵌套字段标签）。 */
export declare function dslSignatureOf(contract: ToolContract): DslToolSignature;
/** 把 DslType 渲染为紧凑文本。 */
export declare function renderDslType(type: DslType, options?: RenderDslSignatureOptions): string;
/** 把 DslToolSignature 渲染为 `id(params) -> returns` 的紧凑签名。 */
export declare function renderDslSignature(signature: DslToolSignature, options?: RenderDslSignatureOptions): string;
