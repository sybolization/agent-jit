import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
import type { TSchema } from "typebox";
/**
 * Compatibility facade for the historical DSH schema helpers.
 * The implementation now lives in the host-neutral adapter layer.
 */
export declare function jsonSchemaFromTypebox(schema: unknown): JsonSchemaNode;
/** Compatibility facade retaining the original DSH export and signature. */
export declare function typeboxFromJsonSchema(schema: unknown): TSchema;
