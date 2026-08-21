import { harnessToolAsRegisteredTool, registeredToolAsHarnessTool, } from "../../adapter/toolAdapter.js";
import { dshToolAsHarnessContract, harnessToolAsDshTool, } from "./harnessAdapter.js";
/**
 * Compatibility facade: RegisteredTool -> neutral definition -> DSH tool.
 * Its public signature and observable projection remain unchanged.
 */
export function adaptRegisteredTool(tool, options = {}) {
    return harnessToolAsDshTool(registeredToolAsHarnessTool(tool, options));
}
/** Compatibility facade for importing one live DSH tool into the DSL runtime. */
export function dshToolAsRegisteredTool(definition, caller) {
    return harnessToolAsRegisteredTool(dshToolAsHarnessContract(definition), caller);
}
