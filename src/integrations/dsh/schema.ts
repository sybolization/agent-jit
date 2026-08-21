import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { TSchema } from "typebox";
import {
  jsonSchemaFromTypebox as jsonSchemaFromHarnessTypebox,
  typeboxFromJsonSchema as typeboxFromHarnessJsonSchema,
} from "../../adapter/schema.js";

/**
 * Compatibility facade for the historical DSH schema helpers.
 * The implementation now lives in the host-neutral adapter layer.
 */
export function jsonSchemaFromTypebox(schema: unknown): JsonSchemaNode {
  return jsonSchemaFromHarnessTypebox(schema) as JsonSchemaNode;
}

/** Compatibility facade retaining the original DSH export and signature. */
export function typeboxFromJsonSchema(schema: unknown): TSchema {
  return typeboxFromHarnessJsonSchema(schema);
}
