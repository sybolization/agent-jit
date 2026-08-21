import { CallId } from "@deepseek-ai/dsh-llm";
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolRunContext,
  ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import type {
  HarnessAdapter,
  HarnessJsonSchema,
  HarnessToolCatalog,
  HarnessToolContract,
  HarnessToolDefinition,
} from "../../adapter/types.js";

/** DSH scope key accepted by ToolRuntime.get / schemas. */
type DshScope = Parameters<ToolRuntime["get"]>[1];

/** Preserve the historical empty-catalog fallback used by lightweight stubs. */
function hasCatalogSurface(
  tools: ToolRuntime,
): tools is ToolRuntime {
  const candidate = tools as Partial<ToolRuntime>;
  return (
    typeof candidate.get === "function" &&
    typeof candidate.schemas === "function"
  );
}

/** Project one live DSH definition onto the host-neutral contract. */
export function dshToolAsHarnessContract(
  definition: ToolDefinition,
): HarnessToolContract {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.parameters,
    outputSchema: definition.output.schema as unknown as HarnessJsonSchema,
  };
}

/** Project one host-neutral definition onto DSH's native tool shape. */
export function harnessToolAsDshTool(
  definition: HarnessToolDefinition<ToolRunContext>,
): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema as Record<string, unknown>,
    output: {
      schema: definition.outputSchema as JsonSchemaNode,
      render: (args, value) => [
        { type: "text", text: definition.renderText(args, value) },
      ],
    },
    execute: (args, context) => definition.execute(args, context),
  };
}

/**
 * Build a synchronous live catalog for one DSH scope.
 *
 * `schemas()` establishes the host's deterministic visible order, while a
 * same-call `get()` recovers the output contract that DSH intentionally omits
 * from its model-facing ToolSchema projection. No definition is snapshotted.
 */
export function createDshHarnessCatalog(
  tools: ToolRuntime,
  scope?: DshScope,
): HarnessToolCatalog {
  return {
    getTool(name) {
      if (!hasCatalogSurface(tools)) return undefined;
      const definition = tools.get(name, scope);
      return definition === undefined
        ? undefined
        : dshToolAsHarnessContract(definition);
    },
    listTools() {
      if (!hasCatalogSurface(tools)) return [];
      const contracts: HarnessToolContract[] = [];
      for (const schema of tools.schemas(scope)) {
        const definition = tools.get(schema.name, scope);
        if (definition !== undefined) {
          contracts.push(dshToolAsHarnessContract(definition));
        }
      }
      return contracts;
    },
  };
}

/**
 * Thin compatibility bridge from DSH's authoritative ToolRuntime to the
 * host-neutral legacy-JIT seam. DSH continues to own scope, policy, parentage,
 * cancellation, registration cleanup, and nested-result normalization.
 */
export function createDshHarnessAdapter(
  tools: ToolRuntime,
): HarnessAdapter<ToolRunContext> {
  return {
    registerTool(definition) {
      return tools.register(harnessToolAsDshTool(definition));
    },
    catalog(context) {
      // Some historical factory tests invoke a tool body with `undefined as
      // never`; retaining the global catalog in that case preserves the old
      // facade behavior without weakening the public context type.
      return createDshHarnessCatalog(tools, context?.agent);
    },
    execution(context) {
      const catalog = createDshHarnessCatalog(tools, context?.agent);
      // Sequence is local to this outer JIT execution, exactly as before the
      // adapter extraction. The first nested call is therefore `:dsl:1`.
      let sequence = 0;
      return {
        ...catalog,
        async callTool(name, args) {
          const result = await tools.execute({
            callId: CallId(`${context.callId}:dsl:${++sequence}`),
            rootCallId: context.rootCallId,
            name,
            arguments: args,
            signal: context.signal,
            agent: context.agent,
            parent: context.token,
          });
          if (result.isError) throw new Error(result.error.message);
          return result.value;
        },
      };
    },
  };
}
