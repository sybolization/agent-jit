import { toolIdAlias } from "../../tools/registry.js";
import { dslSignatureOf, renderDslSignature } from "../../tools/dslSignature.js";
import { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "./schema.js";
/** 单个 RegisteredTool → DSH ToolDefinition（注册用，name = host alias）。 */
export function adaptRegisteredTool(tool, options = {}) {
    const mode = options.dslSignature ?? "inline";
    const description = mode === "inline"
        ? `${tool.description ?? tool.label}\nDSL: ${renderDslSignature(dslSignatureOf(tool), { fieldLabels: true })}`
        : (tool.description ?? tool.label);
    return {
        name: toolIdAlias(tool.id),
        description,
        parameters: jsonSchemaFromTypebox(tool.inputSchema),
        output: {
            schema: jsonSchemaFromTypebox(tool.outputSchema),
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: async (args) => tool.execute(args),
    };
}
/**
 * DSH 宿主 ToolDefinition → agent-jit RegisteredTool（DSL 程序可编排宿主工具）。
 * id 用 DSH 原名（宿主工具无点号约定，不做 alias 转换）；输入输出 schema
 * 从 DSH JSON Schema 反向映射为 typebox（子集外结构回退 Type.Any，放行不误杀）。
 */
export function dshToolAsRegisteredTool(definition, caller) {
    return {
        id: definition.name,
        label: definition.name,
        description: definition.description,
        inputSchema: typeboxFromJsonSchema(definition.parameters),
        outputSchema: typeboxFromJsonSchema(definition.output.schema),
        execute: async (input) => caller(definition.name, input),
    };
}
