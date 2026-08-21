import { jsonSchemaFromTypebox as jsonSchemaFromHarnessTypebox, typeboxFromJsonSchema as typeboxFromHarnessJsonSchema, } from "../../adapter/schema.js";
/**
 * Compatibility facade for the historical DSH schema helpers.
 * The implementation now lives in the host-neutral adapter layer.
 */
export function jsonSchemaFromTypebox(schema) {
    return jsonSchemaFromHarnessTypebox(schema);
}
/** Compatibility facade retaining the original DSH export and signature. */
export function typeboxFromJsonSchema(schema) {
    return typeboxFromHarnessJsonSchema(schema);
}
