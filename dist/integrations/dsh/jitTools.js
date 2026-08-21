import { createHarnessJitDescribeTool, createHarnessJitExecuteProgramTool, createHarnessJitTools, } from "../../adapter/index.js";
import { createDshHarnessAdapter, harnessToolAsDshTool, } from "./harnessAdapter.js";
/** Compatibility facade over the host-neutral describe-tool factory. */
export function createDshJitDescribeTool(registry, tools, options = {}) {
    const adapter = createDshHarnessAdapter(tools);
    return harnessToolAsDshTool(createHarnessJitDescribeTool(registry, adapter, options));
}
/** Compatibility facade over the host-neutral execute-tool factory. */
export function createDshJitExecuteProgramTool(registry, tools, options = {}) {
    const adapter = createDshHarnessAdapter(tools);
    return harnessToolAsDshTool(createHarnessJitExecuteProgramTool(registry, adapter, options));
}
/**
 * Create the historical DSH `jit_*` set through the neutral factories.
 * `describeTools:false` continues to omit only the discovery transport.
 */
export function createDshJitTools(registry, tools, options = {}) {
    const adapter = createDshHarnessAdapter(tools);
    return createHarnessJitTools(registry, adapter, options).map(harnessToolAsDshTool);
}
