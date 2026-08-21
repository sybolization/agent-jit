import type { TSchema } from "typebox";
import type { HarnessJsonSchema } from "./types.js";
/**
 * Convert a TypeBox schema to the JSON Schema subset used by the current
 * harness integration. Unknown structures degrade to `{}` (any JSON), exactly
 * like the pre-extraction DSH adapter.
 */
export declare function jsonSchemaFromTypebox(schema: unknown): HarnessJsonSchema;
/**
 * Convert a host JSON Schema contract to TypeBox for the existing compiler and
 * runtime. Unsupported structures degrade to `Type.Any()` so the adapter never
 * rejects values the host itself may accept.
 */
export declare function typeboxFromJsonSchema(schema: unknown): TSchema;
