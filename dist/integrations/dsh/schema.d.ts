import type { TSchema } from "typebox";
import type { JsonSchemaNode } from "@deepseek-ai/dsh-tools";
/** typebox TSchema → DSH 支持的 JSON Schema 节点（未知结构回退 `{}` = 任意 JSON）。 */
export declare function jsonSchemaFromTypebox(schema: unknown): JsonSchemaNode;
/** DSH JSON Schema 节点 → typebox TSchema（子集外结构回退 Type.Any，放行而不误杀）。 */
export declare function typeboxFromJsonSchema(schema: unknown): TSchema;
