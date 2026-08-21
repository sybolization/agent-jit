import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ToolCatalog, ToolIdSuggestion } from "../../tools/registry.js";
import type { DslToolCaller } from "./toolAdapter.js";
/** DSH tool-catalog scope, historically supplied as `exec.agent`. */
type ScopeKey = Parameters<ToolRuntime["get"]>[1];
/** Historical constructor shape retained as a DSH compatibility facade. */
export interface HostToolViewOptions {
    tools: ToolRuntime;
    scope?: ScopeKey;
    caller: DslToolCaller;
    base?: ToolCatalog;
    allow?: readonly string[];
    exclude?: readonly string[];
    metaNames?: readonly string[];
}
/** Describe-only caller retaining the original deterministic error message. */
export declare function unreachableHostCaller(): DslToolCaller;
/**
 * Historical DSH HostToolView backed by the neutral live-view implementation.
 * The class remains exported so downstream construction sites need no changes.
 */
export declare class HostToolView implements ToolCatalog {
    private readonly view;
    constructor(options: HostToolViewOptions);
    get(name: string): import("../../tools/definition.js").RegisteredTool | undefined;
    all(): readonly import("../../tools/definition.js").RegisteredTool[];
    resolveId(name: string): string | undefined;
    suggestIds(name: string, max?: number): readonly ToolIdSuggestion[];
}
export {};
