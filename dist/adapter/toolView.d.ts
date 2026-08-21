import type { RegisteredTool } from "../tools/definition.js";
import { type ToolCatalog, type ToolIdSuggestion } from "../tools/registry.js";
import { type HarnessToolCaller } from "./toolAdapter.js";
import type { HarnessToolCatalog } from "./types.js";
/** Host-tool visibility controls shared by every harness adapter. */
export interface HarnessHostToolsConfig {
    /** `undefined` = all live tools, `[]` = none, non-empty = allowlist. */
    allow?: readonly string[];
    /** Always excluded after applying the allowlist. */
    exclude?: readonly string[];
}
export interface HarnessToolViewOptions extends HarnessHostToolsConfig {
    /** Live catalog bound to the current harness scope. */
    catalog: HarnessToolCatalog;
    /** Authoritative dispatcher, or an unreachable caller for describe-only use. */
    caller: HarnessToolCaller;
    /** Plugin-owned tools take precedence over host tools with the same name. */
    base?: ToolCatalog;
    /** Extra meta tools to exclude in addition to the two legacy JIT transports. */
    metaNames?: readonly string[];
}
/** Legacy JIT transports must never recursively call themselves. */
export declare const DEFAULT_HARNESS_META_NAMES: readonly ["jit_describe_tools", "jit_execute_program"];
/** Describe-only dispatcher with the same deterministic failure as the DSH path. */
export declare function unreachableHarnessCaller(): HarnessToolCaller;
/**
 * Live host catalog projected into the ToolCatalog/RegisteredTool vocabulary
 * used by the current DSL compiler and runtime.
 */
export declare class HarnessToolView implements ToolCatalog {
    private readonly catalog;
    private readonly caller;
    private readonly base;
    private readonly allow;
    private readonly exclude;
    private readonly meta;
    constructor(options: HarnessToolViewOptions);
    private admits;
    get(name: string): RegisteredTool | undefined;
    all(): readonly RegisteredTool[];
    resolveId(name: string): string | undefined;
    suggestIds(name: string, max?: number): readonly ToolIdSuggestion[];
}
