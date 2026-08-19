import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";

/**
 * typebox ↔ DSH JSON Schema 转换层。
 *
 * DSH 工具注册表（ctx.tools）只认 JSON Schema（`ToolDefinition.parameters` /
 * `output.schema`），且校验器只接受受支持子集：
 * type / oneOf / properties / required / additionalProperties / items /
 * enum / const + annotations（description / title / default / examples）。
 *
 * 两个方向：
 * - jsonSchemaFromTypebox：agent-jit 契约（typebox TSchema）→ DSH 注册用
 *   JSON Schema（模型看到的 parameters / output 契约）；
 * - typeboxFromJsonSchema：DSH 宿主工具（bash / fs / 用户插件）→ agent-jit
 *   RuntimeRegistry 需要的 typebox TSchema（编译器 input 校验 / 运行时
 *   output 校验用 Value.Check）。
 *
 * 语义保证：DSL 编译器的严格校验永远基于 agent-jit 自有的完整 typebox
 * 契约（contracts.ts），本层只影响「DSH 侧展示」与「宿主工具反向导入」两个
 * 方向的保真度；反向导入遇到子集外结构（patternProperties 等）回退 Type.Any，
 * 放行而不误杀。
 */

/** typebox 运行时节点结构（TSchema 类型不透出内部字段，这里按运行时形状收敛）。 */
interface RawSchemaNode {
  type?: unknown;
  properties?: Record<string, RawSchemaNode>;
  required?: unknown;
  items?: RawSchemaNode;
  additionalProperties?: unknown;
  enum?: unknown;
  const?: unknown;
  anyOf?: RawSchemaNode[];
  oneOf?: RawSchemaNode[];
  title?: unknown;
  description?: unknown;
}

/** DSH 支持的标量 type 拼写。 */
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean", "null"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 提取 typebox 节点上的 annotation（title / description 透传给 DSH 展示）。 */
function annotationsOf(raw: RawSchemaNode): Pick<JsonSchemaNode, "title" | "description"> {
  const result: Pick<JsonSchemaNode, "title" | "description"> = {};
  if (typeof raw.title === "string" && raw.title.length > 0) result.title = raw.title;
  if (typeof raw.description === "string" && raw.description.length > 0) result.description = raw.description;
  return result;
}

/** typebox TSchema → DSH 支持的 JSON Schema 节点（未知结构回退 `{}` = 任意 JSON）。 */
export function jsonSchemaFromTypebox(schema: unknown): JsonSchemaNode {
  if (!isRecord(schema)) return {};
  const raw = schema as RawSchemaNode;

  if (raw.type === "object") {
    const properties: Record<string, JsonSchemaNode> = {};
    for (const [key, prop] of Object.entries(raw.properties ?? {})) {
      properties[key] = jsonSchemaFromTypebox(prop);
    }
    const required = Array.isArray(raw.required)
      ? raw.required.filter((item): item is string => typeof item === "string")
      : [];
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(raw.additionalProperties === false ? { additionalProperties: false } : {}),
      ...annotationsOf(raw),
    };
  }
  if (raw.type === "array") {
    return { type: "array", ...(raw.items !== undefined ? { items: jsonSchemaFromTypebox(raw.items) } : {}) };
  }
  if (typeof raw.type === "string" && SCALAR_TYPES.has(raw.type)) {
    return { type: raw.type as JsonSchemaNode["type"] };
  }
  // typebox Enum 节点只有 enum 数组；补上可推导的标量 type 让契约更明确。
  if (Array.isArray(raw.enum)) {
    const members = raw.enum.filter((item) => typeof item === "string" || typeof item === "number");
    const memberType = members.length > 0 && members.every((item) => typeof item === "string")
      ? "string"
      : members.length > 0 && members.every((item) => typeof item === "number")
        ? "number"
        : undefined;
    return { ...(memberType === undefined ? {} : { type: memberType }), enum: members as JsonSchemaNode["enum"] };
  }
  // typebox Union 输出 anyOf；DSH 只支持 oneOf（恰好一支成立），语义等价。
  const union = raw.oneOf ?? raw.anyOf;
  if (Array.isArray(union) && union.length >= 2) {
    return { oneOf: union.map((member) => jsonSchemaFromTypebox(member)) };
  }
  // record（typebox 输出 type:"object" + patternProperties）等子集外结构：
  // object 分支已按开放对象放行（value 类型约束只保留在 agent-jit 自有的
  // typebox 契约里，DSL 编译器校验不受影响）。
  return {};
}

/** 必填字段集合提取（DSH JSON Schema required 数组 → Set）。 */
function requiredOf(schema: unknown): Set<string> {
  if (!isRecord(schema)) return new Set();
  const required = schema.required;
  return new Set(Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : []);
}

/** DSH JSON Schema 节点 → typebox TSchema（子集外结构回退 Type.Any，放行而不误杀）。 */
export function typeboxFromJsonSchema(schema: unknown): TSchema {
  if (!isRecord(schema)) return Type.Any();
  const raw = schema as RawSchemaNode;

  if (raw.type === "object") {
    const required = requiredOf(schema);
    const properties: Record<string, TSchema> = {};
    for (const [key, prop] of Object.entries(raw.properties ?? {})) {
      const inner = typeboxFromJsonSchema(prop);
      properties[key] = required.has(key) ? inner : Type.Optional(inner);
    }
    return Type.Object(
      properties,
      raw.additionalProperties === false ? { additionalProperties: false } : {},
    );
  }
  if (raw.type === "array") {
    return Type.Array(raw.items === undefined ? Type.Any() : typeboxFromJsonSchema(raw.items));
  }
  // enum / const 必须先于标量 type 分支：DSH 形态 {type:'string', enum:[...]} 若先命中
  // type 分支，enum 成员会在导入时丢失——取值既进不了编译期校验，也进不了签名渲染。
  const enumSource =
    Array.isArray(raw.enum) && raw.enum.length > 0 ? raw.enum : raw.const !== undefined ? [raw.const] : undefined;
  if (enumSource !== undefined) {
    // Type.Enum 接受 string | number 字面量数组；过滤后为空则回退（放行原 type 分支语义）。
    const members = enumSource.filter(
      (item): item is string | number => typeof item === "string" || typeof item === "number",
    );
    if (members.length > 0) return Type.Enum(members as (string | number)[]);
  }
  if (raw.type === "string") return Type.String();
  if (raw.type === "integer") return Type.Integer();
  if (raw.type === "number") return Type.Number();
  if (raw.type === "boolean") return Type.Boolean();
  if (raw.type === "null") return Type.Null();
  const union = raw.oneOf ?? raw.anyOf;
  if (Array.isArray(union) && union.length >= 2) {
    return Type.Union(union.map((member) => typeboxFromJsonSchema(member)));
  }
  return Type.Any();
}
