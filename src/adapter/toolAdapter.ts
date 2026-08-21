import type { RegisteredTool } from "../tools/definition.js";
import { dslSignatureOf, renderDslSignature } from "../tools/dslSignature.js";
import { toolIdAlias } from "../tools/registry.js";
import { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "./schema.js";
import type { HarnessToolContract, HarnessToolDefinition } from "./types.js";

/** Host-neutral nested tool dispatcher used by a DSL runtime binding. */
export type HarnessToolCaller = (name: string, args: unknown) => Promise<unknown>;

export interface RegisteredToolHarnessOptions {
  /** Preserve the current production default: append the compact DSL signature. */
  dslSignature?: "inline" | "none";
}

/**
 * Adapt an agent-jit provider tool to the neutral harness registration shape.
 * Host naming, DSL signature injection, schemas, execution, and JSON rendering
 * match the current DSH adapter exactly.
 */
export function registeredToolAsHarnessTool<TContext = unknown>(
  tool: RegisteredTool,
  options: RegisteredToolHarnessOptions = {},
): HarnessToolDefinition<TContext> {
  const mode = options.dslSignature ?? "inline";
  const description =
    mode === "inline"
      ? `${tool.description ?? tool.label}\nDSL: ${renderDslSignature(dslSignatureOf(tool), { fieldLabels: true })}`
      : (tool.description ?? tool.label);

  return {
    name: toolIdAlias(tool.id),
    description,
    inputSchema: jsonSchemaFromTypebox(tool.inputSchema),
    outputSchema: jsonSchemaFromTypebox(tool.outputSchema),
    execute: async (args) => tool.execute(args),
    // RegisteredTool output is schema-validated JSON in every current host.
    renderText: (_args, value) => JSON.stringify(value) as string,
  };
}

/**
 * Adapt a host-visible tool contract into the RegisteredTool shape consumed by
 * the legacy compiler/runtime. Calls always return to the supplied authoritative
 * host dispatcher rather than invoking a captured host implementation directly.
 */
export function harnessToolAsRegisteredTool(
  contract: HarnessToolContract,
  caller: HarnessToolCaller,
): RegisteredTool {
  return {
    id: contract.name,
    label: contract.name,
    description: contract.description,
    inputSchema: typeboxFromJsonSchema(contract.inputSchema),
    outputSchema: typeboxFromJsonSchema(contract.outputSchema),
    execute: async (input) => caller(contract.name, input),
  };
}
