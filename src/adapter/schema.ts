import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { HarnessJsonSchema } from "./types.js";

/** Runtime schema shape shared by TypeBox and JSON Schema objects. */
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

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean", "null"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function annotationsOf(raw: RawSchemaNode): HarnessJsonSchema {
  const result: Record<string, unknown> = {};
  if (typeof raw.title === "string" && raw.title.length > 0) result["title"] = raw.title;
  if (typeof raw.description === "string" && raw.description.length > 0) {
    result["description"] = raw.description;
  }
  return result;
}

/**
 * Convert a TypeBox schema to the JSON Schema subset used by the current
 * harness integration. Unknown structures degrade to `{}` (any JSON), exactly
 * like the pre-extraction DSH adapter.
 */
export function jsonSchemaFromTypebox(schema: unknown): HarnessJsonSchema {
  if (!isRecord(schema)) return {};
  const raw = schema as RawSchemaNode;

  if (raw.type === "object") {
    const properties: Record<string, HarnessJsonSchema> = {};
    for (const [key, property] of Object.entries(raw.properties ?? {})) {
      properties[key] = jsonSchemaFromTypebox(property);
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
    return {
      type: "array",
      ...(raw.items !== undefined ? { items: jsonSchemaFromTypebox(raw.items) } : {}),
    };
  }

  if (typeof raw.type === "string" && SCALAR_TYPES.has(raw.type)) {
    return { type: raw.type };
  }

  if (Array.isArray(raw.enum)) {
    const members = raw.enum.filter((item) => typeof item === "string" || typeof item === "number");
    const memberType =
      members.length > 0 && members.every((item) => typeof item === "string")
        ? "string"
        : members.length > 0 && members.every((item) => typeof item === "number")
          ? "number"
          : undefined;
    return {
      ...(memberType === undefined ? {} : { type: memberType }),
      enum: members,
    };
  }

  const union = raw.oneOf ?? raw.anyOf;
  if (Array.isArray(union) && union.length >= 2) {
    return { oneOf: union.map((member) => jsonSchemaFromTypebox(member)) };
  }

  return {};
}

function requiredOf(schema: unknown): Set<string> {
  if (!isRecord(schema)) return new Set();
  const required = schema["required"];
  return new Set(
    Array.isArray(required)
      ? required.filter((item): item is string => typeof item === "string")
      : [],
  );
}

/**
 * Convert a host JSON Schema contract to TypeBox for the existing compiler and
 * runtime. Unsupported structures degrade to `Type.Any()` so the adapter never
 * rejects values the host itself may accept.
 */
export function typeboxFromJsonSchema(schema: unknown): TSchema {
  if (!isRecord(schema)) return Type.Any();
  const raw = schema as RawSchemaNode;

  if (raw.type === "object") {
    const required = requiredOf(schema);
    const properties: Record<string, TSchema> = {};
    for (const [key, property] of Object.entries(raw.properties ?? {})) {
      const inner = typeboxFromJsonSchema(property);
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

  // enum / const must precede scalar handling or their literal set is lost.
  const enumSource =
    Array.isArray(raw.enum) && raw.enum.length > 0
      ? raw.enum
      : raw.const !== undefined
        ? [raw.const]
        : undefined;
  if (enumSource !== undefined) {
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
