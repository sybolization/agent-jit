/**
 * Host-neutral Agent JIT integration surface.
 *
 * @experimental This API is additive in 0.1.x but may be refined after a
 * second production harness validates the seam. `agent-jit/dsh` remains the
 * stable compatibility entrypoint.
 */
export { type HarnessJsonSchema, type HarnessDisposer, type HarnessToolContract, type HarnessToolDefinition, type HarnessToolCatalog, type HarnessToolExecution, type HarnessAdapter, } from "./types.js";
export { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "./schema.js";
export { registeredToolAsHarnessTool, harnessToolAsRegisteredTool, type HarnessToolCaller, type RegisteredToolHarnessOptions, } from "./toolAdapter.js";
export { HarnessToolView, unreachableHarnessCaller, DEFAULT_HARNESS_META_NAMES, type HarnessHostToolsConfig, type HarnessToolViewOptions, } from "./toolView.js";
export { createHarnessJitDescribeTool, createHarnessJitExecuteProgramTool, createHarnessJitTools, installLegacyDslJit, type HarnessJitDescribeOptions, type HarnessJitExecuteOptions, type HarnessJitToolsOptions, type HarnessLegacyDslInstallOptions, type HarnessJitExecuteProgramDetails, } from "./jitTools.js";
export { defineTool, type ToolContract, type RegisteredTool } from "../tools/definition.js";
export { ToolRegistry, toolIdAlias, type ToolCatalog, type ToolIdSuggestion, } from "../tools/registry.js";
export type { RuntimeCatalog, RuntimeRegistry } from "../runtime/runtime.js";
