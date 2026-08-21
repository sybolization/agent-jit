import { editDistance, } from "../tools/registry.js";
import { harnessToolAsRegisteredTool, } from "./toolAdapter.js";
/** Legacy JIT transports must never recursively call themselves. */
export const DEFAULT_HARNESS_META_NAMES = [
    "jit_describe_tools",
    "jit_execute_program",
];
/** Describe-only dispatcher with the same deterministic failure as the DSH path. */
export function unreachableHarnessCaller() {
    return async () => {
        throw new Error("jit_describe_tools 只渲染契约，不执行宿主工具");
    };
}
function withinThreshold(name, candidate, distance) {
    const maxLength = Math.max(name.length, candidate.length);
    return distance <= 2 && distance <= Math.max(1, Math.floor(maxLength / 3));
}
/**
 * Live host catalog projected into the ToolCatalog/RegisteredTool vocabulary
 * used by the current DSL compiler and runtime.
 */
export class HarnessToolView {
    catalog;
    caller;
    base;
    allow;
    exclude;
    meta;
    constructor(options) {
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
    admits(name) {
        if (this.exclude.has(name) || this.meta.has(name))
            return false;
        if (this.base !== undefined && this.base.resolveId(name) !== undefined)
            return false;
        if (this.allow !== undefined && !this.allow.has(name))
            return false;
        return true;
    }
    get(name) {
        if (!this.admits(name))
            return undefined;
        const contract = this.catalog.getTool(name);
        if (contract === undefined)
            return undefined;
        return harnessToolAsRegisteredTool(contract, this.caller);
    }
    all() {
        const result = [];
        for (const contract of this.catalog.listTools()) {
            if (!this.admits(contract.name))
                continue;
            // Resolve again through the live catalog, matching the existing DSH view.
            const tool = this.get(contract.name);
            if (tool !== undefined)
                result.push(tool);
        }
        return result;
    }
    resolveId(name) {
        if (this.get(name) !== undefined)
            return name;
        const alias = name.replace(/\./g, "_");
        if (alias !== name && this.get(alias) !== undefined)
            return alias;
        return undefined;
    }
    suggestIds(name, max = 2) {
        const matches = [];
        for (const tool of this.all()) {
            const distance = editDistance(name, tool.id);
            if (!withinThreshold(name, tool.id, distance))
                continue;
            matches.push({ id: tool.id, distance });
        }
        matches.sort((left, right) => left.distance - right.distance ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        return matches
            .slice(0, max)
            .map(({ id }) => ({ alias: id, canonical: id }));
    }
}
