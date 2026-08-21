/**
 * Host-neutral Agent JIT integration surface.
 *
 * @experimental This API is additive in 0.1.x but may be refined after a
 * second production harness validates the seam. `agent-jit/dsh` remains the
 * stable compatibility entrypoint.
 */
export { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "./schema.js";
export { registeredToolAsHarnessTool, harnessToolAsRegisteredTool, } from "./toolAdapter.js";
export { HarnessToolView, unreachableHarnessCaller, DEFAULT_HARNESS_META_NAMES, } from "./toolView.js";
export { createHarnessJitDescribeTool, createHarnessJitExecuteProgramTool, createHarnessJitTools, installLegacyDslJit, } from "./jitTools.js";
// The generic factories accept the existing executable registry. Re-export
// its construction vocabulary here so consumers never need an unexported
// internal package path to use the public adapter entrypoint.
export { defineTool } from "../tools/definition.js";
export { ToolRegistry, toolIdAlias, } from "../tools/registry.js";
