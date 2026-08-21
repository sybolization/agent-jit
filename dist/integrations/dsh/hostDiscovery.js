import { HarnessToolView, unreachableHarnessCaller, } from "../../adapter/toolView.js";
import { createDshHarnessCatalog } from "./harnessAdapter.js";
/** Describe-only caller retaining the original deterministic error message. */
export function unreachableHostCaller() {
    return unreachableHarnessCaller();
}
/**
 * Historical DSH HostToolView backed by the neutral live-view implementation.
 * The class remains exported so downstream construction sites need no changes.
 */
export class HostToolView {
    view;
    constructor(options) {
        this.view = new HarnessToolView({
            catalog: createDshHarnessCatalog(options.tools, options.scope),
            caller: options.caller,
            base: options.base,
            allow: options.allow,
            exclude: options.exclude,
            metaNames: options.metaNames,
        });
    }
    get(name) {
        return this.view.get(name);
    }
    all() {
        return this.view.all();
    }
    resolveId(name) {
        return this.view.resolveId(name);
    }
    suggestIds(name, max) {
        return this.view.suggestIds(name, max);
    }
}
