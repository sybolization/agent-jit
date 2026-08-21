import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { type HarnessToolCaller } from "../../adapter/toolAdapter.js";
import type { RegisteredTool } from "../../tools/definition.js";
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
export declare function adaptRegisteredTool(tool: RegisteredTool, options?: DshToolAdapterOptions): ToolDefinition;
/** Compatibility facade for importing one live DSH tool into the DSL runtime. */
export declare function dshToolAsRegisteredTool(definition: ToolDefinition, caller: DslToolCaller): RegisteredTool;
