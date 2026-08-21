import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  harnessToolAsRegisteredTool,
  registeredToolAsHarnessTool,
  type HarnessToolCaller,
} from "../../adapter/toolAdapter.js";
import type { RegisteredTool } from "../../tools/definition.js";
import {
  dshToolAsHarnessContract,
  harnessToolAsDshTool,
} from "./harnessAdapter.js";

/** Historical DSH name retained for downstream callers. */
export type DslToolCaller = HarnessToolCaller;

export interface DshToolAdapterOptions {
  /** Whether to append the compact DSL signature. Defaults to `inline`. */
  dslSignature?: "inline" | "none";
}

/**
 * Compatibility facade: RegisteredTool -> neutral definition -> DSH tool.
 * Its public signature and observable projection remain unchanged.
 */
export function adaptRegisteredTool(
  tool: RegisteredTool,
  options: DshToolAdapterOptions = {},
): ToolDefinition {
  return harnessToolAsDshTool(
    registeredToolAsHarnessTool<ToolRunContext>(tool, options),
  );
}

/** Compatibility facade for importing one live DSH tool into the DSL runtime. */
export function dshToolAsRegisteredTool(
  definition: ToolDefinition,
  caller: DslToolCaller,
): RegisteredTool {
  return harnessToolAsRegisteredTool(
    dshToolAsHarnessContract(definition),
    caller,
  );
}
