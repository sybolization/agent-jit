import type { RegisteredTool } from "../tools/definition.js";
import {
  editDistance,
  type ToolCatalog,
  type ToolIdSuggestion,
} from "../tools/registry.js";
import {
  harnessToolAsRegisteredTool,
  type HarnessToolCaller,
} from "./toolAdapter.js";
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
export const DEFAULT_HARNESS_META_NAMES = [
  "jit_describe_tools",
  "jit_execute_program",
] as const;

/** Describe-only dispatcher with the same deterministic failure as the DSH path. */
export function unreachableHarnessCaller(): HarnessToolCaller {
  return async () => {
    throw new Error("jit_describe_tools 只渲染契约，不执行宿主工具");
  };
}

function withinThreshold(name: string, candidate: string, distance: number): boolean {
  const maxLength = Math.max(name.length, candidate.length);
  return distance <= 2 && distance <= Math.max(1, Math.floor(maxLength / 3));
}

/**
 * Live host catalog projected into the ToolCatalog/RegisteredTool vocabulary
 * used by the current DSL compiler and runtime.
 */
export class HarnessToolView implements ToolCatalog {
  private readonly catalog: HarnessToolCatalog;
  private readonly caller: HarnessToolCaller;
  private readonly base: ToolCatalog | undefined;
  private readonly allow: ReadonlySet<string> | undefined;
  private readonly exclude: ReadonlySet<string>;
  private readonly meta: ReadonlySet<string>;

  constructor(options: HarnessToolViewOptions) {
    this.catalog = options.catalog;
    this.caller = options.caller;
    this.base = options.base;
    this.allow = options.allow === undefined ? undefined : new Set(options.allow);
    this.exclude = new Set(options.exclude ?? []);
    this.meta = new Set([
      ...DEFAULT_HARNESS_META_NAMES,
      ...(options.metaNames ?? []),
    ]);
  }

  private admits(name: string): boolean {
    if (this.exclude.has(name) || this.meta.has(name)) return false;
    if (this.base !== undefined && this.base.resolveId(name) !== undefined) return false;
    if (this.allow !== undefined && !this.allow.has(name)) return false;
    return true;
  }

  get(name: string): RegisteredTool | undefined {
    if (!this.admits(name)) return undefined;
    const contract = this.catalog.getTool(name);
    if (contract === undefined) return undefined;
    return harnessToolAsRegisteredTool(contract, this.caller);
  }

  all(): readonly RegisteredTool[] {
    const result: RegisteredTool[] = [];
    for (const contract of this.catalog.listTools()) {
      if (!this.admits(contract.name)) continue;
      // Resolve again through the live catalog, matching the existing DSH view.
      const tool = this.get(contract.name);
      if (tool !== undefined) result.push(tool);
    }
    return result;
  }

  resolveId(name: string): string | undefined {
    if (this.get(name) !== undefined) return name;
    const alias = name.replace(/\./g, "_");
    if (alias !== name && this.get(alias) !== undefined) return alias;
    return undefined;
  }

  suggestIds(name: string, max = 2): readonly ToolIdSuggestion[] {
    const matches: { id: string; distance: number }[] = [];
    for (const tool of this.all()) {
      const distance = editDistance(name, tool.id);
      if (!withinThreshold(name, tool.id, distance)) continue;
      matches.push({ id: tool.id, distance });
    }
    matches.sort(
      (left, right) =>
        left.distance - right.distance ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    return matches
      .slice(0, max)
      .map(({ id }) => ({ alias: id, canonical: id }));
  }
}
