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

export type SchemaView =
  | { kind: "string"; description?: string }
  | { kind: "integer"; description?: string }
  | { kind: "number"; description?: string }
  | { kind: "boolean"; description?: string }
  | { kind: "null"; description?: string }
  | { kind: "array"; items: SchemaView; description?: string }
  | { kind: "object"; properties: Record<string, SchemaView>; required: readonly string[]; description?: string }
  | { kind: "record"; value: SchemaView; description?: string }
  | { kind: "union"; members: readonly SchemaView[]; description?: string }
  | { kind: "unknown"; description?: string };

interface RawSchema {
  type?: string;
  anyOf?: unknown[];
  oneOf?: unknown[];
  items?: unknown;
  properties?: Record<string, unknown>;
  patternProperties?: Record<string, unknown>;
  additionalProperties?: unknown;
  required?: string[];
  description?: unknown;
}

/** 从 raw 节点提取语义标签（schema property 的 description；非空字符串才保留）。 */
function descriptionOf(node: RawSchema): string | undefined {
  return typeof node.description === "string" && node.description.length > 0 ? node.description : undefined;
}

/**
 * 把 JSON Schema / TypeBox schema 归一为 SchemaView；无法识别 → unknown。
 * 每个节点携带自身 schema 的 description（语义标签）——DSL 签名层据此
 * 递归渲染 `key: type[label]`，嵌套 object/array 的标签不再丢失，
 * 也不再需要 dslSignature 对 raw JSON Schema 做二次 traversal。
 */
export function schemaViewOf(schema: unknown): SchemaView {
  const node = (schema ?? {}) as RawSchema;
  const description = descriptionOf(node);

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
      if (items.kind === "unknown") return { kind: "unknown", ...(description !== undefined ? { description } : {}) };
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
      const properties: Record<string, SchemaView> = {};
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
export function schemaViewText(view: SchemaView): string {
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
