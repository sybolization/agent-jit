/**
 * DSL 工具签名层：把 JSON Schema / TypeBox schema 归一为紧凑的 DslType 表示，
 * 并渲染为 `id(params) -> returns` 的紧凑签名。
 *
 * 结构镜像 SchemaView（schemaView.ts），但用 DSL 原生拼写（str/int/num/bool）
 * 并携带字段级元数据（label 来自 description），面向 opaque 工具的
 * `key: type[label]` 渲染与后续 DSL 生成链路。
 */

import type { ToolContract } from "./definition.js";

/** DSL 面向的紧凑类型表示（结构镜像 SchemaView，但用 DSL 原生拼写与元数据）。 */
export type DslType =
  | { kind: "str" }
  | { kind: "int" }
  | { kind: "num" }
  | { kind: "bool" }
  | { kind: "null" }
  | { kind: "list"; items: DslType }
  | { kind: "object"; fields: readonly DslField[] }
  | { kind: "record"; value: DslType }
  | { kind: "union"; members: readonly DslType[] }
  | { kind: "unknown" };

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

interface RawSchema {
  type?: string;
  anyOf?: unknown[];
  oneOf?: unknown[];
  items?: unknown;
  properties?: Record<string, unknown>;
  patternProperties?: Record<string, unknown>;
  additionalProperties?: unknown;
  description?: unknown;
}

/** 把 JSON Schema / TypeBox schema 归一为 DslType；无法识别 → unknown。 */
export function dslTypeOf(schema: unknown): DslType {
  const node = (schema ?? {}) as RawSchema;

  // union：anyOf / oneOf 取成员（typebox Type.Union 输出 anyOf）
  const unionMembers = node.anyOf ?? node.oneOf;
  if (Array.isArray(unionMembers) && unionMembers.length > 0) {
    return { kind: "union", members: unionMembers.map(dslTypeOf) };
  }

  switch (node.type) {
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
    case "array": {
      const items = dslTypeOf(node.items);
      return items.kind === "unknown" ? { kind: "unknown" } : { kind: "list", items };
    }
    case "object": {
      // patternProperties / additionalProperties（对象 schema）→ record<T>
      const patternValues = node.patternProperties ? Object.values(node.patternProperties) : [];
      const patternValue = patternValues[0];
      if (patternValue !== undefined) {
        const value = dslTypeOf(patternValue);
        return value.kind === "unknown" ? { kind: "unknown" } : { kind: "record", value };
      }
      if (typeof node.additionalProperties === "object" && node.additionalProperties !== null) {
        const value = dslTypeOf(node.additionalProperties);
        return value.kind === "unknown" ? { kind: "unknown" } : { kind: "record", value };
      }
      const fields: DslField[] = [];
      for (const [name, prop] of Object.entries(node.properties ?? {})) {
        const type = dslTypeOf(prop);
        const field: DslField = { name, type };
        if (prop !== null && typeof prop === "object" && !Array.isArray(prop)) {
          const description = (prop as { description?: unknown }).description;
          if (typeof description === "string" && description.length > 0) {
            field.label = description;
          }
        }
        fields.push(field);
      }
      return { kind: "object", fields };
    }
    default:
      return { kind: "unknown" };
  }
}

/** 把 ToolContract 归一为 DslToolSignature：id + 参数（含 required）+ 返回类型。 */
export function dslSignatureOf(contract: ToolContract): DslToolSignature {
  const raw = contract.inputSchema as { required?: unknown; properties?: Record<string, unknown> };
  const required = new Set<string>(
    Array.isArray(raw.required) ? raw.required.filter((item): item is string => typeof item === "string") : [],
  );
  const inputType = dslTypeOf(contract.inputSchema);
  const parameters: DslParameter[] =
    inputType.kind === "object"
      ? inputType.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: required.has(field.name),
        }))
      : [];
  return {
    id: contract.id,
    parameters,
    returns: dslTypeOf(contract.outputSchema),
  };
}

/** 把 DslType 渲染为紧凑文本。 */
export function renderDslType(type: DslType, options: RenderDslSignatureOptions = {}): string {
  const { typeStyle = "compact", fieldLabels = false } = options;
  const spell = (compact: string, schema: string): string => (typeStyle === "schema" ? schema : compact);
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
export function renderDslSignature(signature: DslToolSignature, options: RenderDslSignatureOptions = {}): string {
  const { nameTransform = (id: string) => id } = options;
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
