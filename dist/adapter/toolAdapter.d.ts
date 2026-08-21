import type { RegisteredTool } from "../tools/definition.js";
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
export declare function registeredToolAsHarnessTool<TContext = unknown>(tool: RegisteredTool, options?: RegisteredToolHarnessOptions): HarnessToolDefinition<TContext>;
/**
 * Adapt a host-visible tool contract into the RegisteredTool shape consumed by
 * the legacy compiler/runtime. Calls always return to the supplied authoritative
 * host dispatcher rather than invoking a captured host implementation directly.
 */
export declare function harnessToolAsRegisteredTool(contract: HarnessToolContract, caller: HarnessToolCaller): RegisteredTool;
