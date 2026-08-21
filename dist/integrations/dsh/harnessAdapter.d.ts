import type { ToolDefinition, ToolRunContext, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { HarnessAdapter, HarnessToolCatalog, HarnessToolContract, HarnessToolDefinition } from "../../adapter/types.js";
/** DSH scope key accepted by ToolRuntime.get / schemas. */
type DshScope = Parameters<ToolRuntime["get"]>[1];
/** Project one live DSH definition onto the host-neutral contract. */
export declare function dshToolAsHarnessContract(definition: ToolDefinition): HarnessToolContract;
/** Project one host-neutral definition onto DSH's native tool shape. */
export declare function harnessToolAsDshTool(definition: HarnessToolDefinition<ToolRunContext>): ToolDefinition;
/**
 * Build a synchronous live catalog for one DSH scope.
 *
 * `schemas()` establishes the host's deterministic visible order, while a
 * same-call `get()` recovers the output contract that DSH intentionally omits
 * from its model-facing ToolSchema projection. No definition is snapshotted.
 */
export declare function createDshHarnessCatalog(tools: ToolRuntime, scope?: DshScope): HarnessToolCatalog;
/**
 * Thin compatibility bridge from DSH's authoritative ToolRuntime to the
 * host-neutral legacy-JIT seam. DSH continues to own scope, policy, parentage,
 * cancellation, registration cleanup, and nested-result normalization.
 */
export declare function createDshHarnessAdapter(tools: ToolRuntime): HarnessAdapter<ToolRunContext>;
export {};
