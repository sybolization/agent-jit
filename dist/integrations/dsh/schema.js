import { Type } from "typebox";
/** DSH 支持的标量 type 拼写。 */
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean", "null"]);
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** 提取 typebox 节点上的 annotation（title / description 透传给 DSH 展示）。 */
function annotationsOf(raw) {
    const result = {};
    if (typeof raw.title === "string" && raw.title.length > 0)
        result.title = raw.title;
    if (typeof raw.description === "string" && raw.description.length > 0)
        result.description = raw.description;
    return result;
}
/** typebox TSchema → DSH 支持的 JSON Schema 节点（未知结构回退 `{}` = 任意 JSON）。 */
export function jsonSchemaFromTypebox(schema) {
    if (!isRecord(schema))
        return {};
    const raw = schema;
    if (raw.type === "object") {
        const properties = {};
        for (const [key, prop] of Object.entries(raw.properties ?? {})) {
            properties[key] = jsonSchemaFromTypebox(prop);
        }
        const required = Array.isArray(raw.required)
            ? raw.required.filter((item) => typeof item === "string")
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
        return { type: raw.type };
    }
    // typebox Enum 节点只有 enum 数组；补上可推导的标量 type 让契约更明确。
    if (Array.isArray(raw.enum)) {
        const members = raw.enum.filter((item) => typeof item === "string" || typeof item === "number");
        const memberType = members.length > 0 && members.every((item) => typeof item === "string")
            ? "string"
            : members.length > 0 && members.every((item) => typeof item === "number")
                ? "number"
                : undefined;
        return { ...(memberType === undefined ? {} : { type: memberType }), enum: members };
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
function requiredOf(schema) {
    if (!isRecord(schema))
        return new Set();
    const required = schema.required;
    return new Set(Array.isArray(required) ? required.filter((item) => typeof item === "string") : []);
}
/** DSH JSON Schema 节点 → typebox TSchema（子集外结构回退 Type.Any，放行而不误杀）。 */
export function typeboxFromJsonSchema(schema) {
    if (!isRecord(schema))
        return Type.Any();
    const raw = schema;
    if (raw.type === "object") {
        const required = requiredOf(schema);
        const properties = {};
        for (const [key, prop] of Object.entries(raw.properties ?? {})) {
            const inner = typeboxFromJsonSchema(prop);
            properties[key] = required.has(key) ? inner : Type.Optional(inner);
        }
        return Type.Object(properties, raw.additionalProperties === false ? { additionalProperties: false } : {});
    }
    if (raw.type === "array") {
        return Type.Array(raw.items === undefined ? Type.Any() : typeboxFromJsonSchema(raw.items));
    }
    // enum / const 必须先于标量 type 分支：DSH 形态 {type:'string', enum:[...]} 若先命中
    // type 分支，enum 成员会在导入时丢失——取值既进不了编译期校验，也进不了签名渲染。
    const enumSource = Array.isArray(raw.enum) && raw.enum.length > 0 ? raw.enum : raw.const !== undefined ? [raw.const] : undefined;
    if (enumSource !== undefined) {
        // Type.Enum 接受 string | number 字面量数组；过滤后为空则回退（放行原 type 分支语义）。
        const members = enumSource.filter((item) => typeof item === "string" || typeof item === "number");
        if (members.length > 0)
            return Type.Enum(members);
    }
    if (raw.type === "string")
        return Type.String();
    if (raw.type === "integer")
        return Type.Integer();
    if (raw.type === "number")
        return Type.Number();
    if (raw.type === "boolean")
        return Type.Boolean();
    if (raw.type === "null")
        return Type.Null();
    const union = raw.oneOf ?? raw.anyOf;
    if (Array.isArray(union) && union.length >= 2) {
        return Type.Union(union.map((member) => typeboxFromJsonSchema(member)));
    }
    return Type.Any();
}
