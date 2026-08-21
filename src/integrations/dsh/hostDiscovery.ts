import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  HarnessToolView,
  unreachableHarnessCaller,
} from "../../adapter/toolView.js";
import type { ToolCatalog, ToolIdSuggestion } from "../../tools/registry.js";
import { createDshHarnessCatalog } from "./harnessAdapter.js";
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
export function unreachableHostCaller(): DslToolCaller {
  return unreachableHarnessCaller();
}

/**
 * Historical DSH HostToolView backed by the neutral live-view implementation.
 * The class remains exported so downstream construction sites need no changes.
 */
export class HostToolView implements ToolCatalog {
  private readonly view: HarnessToolView;

  constructor(options: HostToolViewOptions) {
    this.view = new HarnessToolView({
      catalog: createDshHarnessCatalog(options.tools, options.scope),
      caller: options.caller,
      base: options.base,
      allow: options.allow,
      exclude: options.exclude,
      metaNames: options.metaNames,
    });
  }

  get(name: string) {
    return this.view.get(name);
  }

  all() {
    return this.view.all();
  }

  resolveId(name: string): string | undefined {
    return this.view.resolveId(name);
  }

  suggestIds(name: string, max?: number): readonly ToolIdSuggestion[] {
    return this.view.suggestIds(name, max);
  }
}
