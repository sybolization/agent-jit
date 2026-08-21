import type { ExecutionGraph } from "../compiler/ir.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import { type DescribeDslReferenceMode, type RoutingPromptVariant } from "../prompt/routingToolPrompts.js";
import { type RuntimeRegistry } from "../runtime/runtime.js";
import type { TraceEntry } from "../runtime/trace.js";
import { type HarnessHostToolsConfig } from "./toolView.js";
import type { HarnessAdapter, HarnessDisposer, HarnessToolDefinition } from "./types.js";
export interface HarnessJitDescribeOptions {
    hostTools?: HarnessHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    describeDslReference?: DescribeDslReferenceMode;
}
export interface HarnessJitExecuteOptions {
    hostTools?: HarnessHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}
export interface HarnessJitToolsOptions extends HarnessJitDescribeOptions, HarnessJitExecuteOptions {
    describeTools?: boolean;
}
export interface HarnessLegacyDslInstallOptions extends HarnessJitToolsOptions {
    /** DSL signature presentation for plugin-owned provider tools. */
    dslSignature?: "inline" | "none";
}
/**
 * Host-neutral `jit_describe_tools`: live catalog → deterministic DSL
 * contracts, with the exact strict-error and first-call reference semantics of
 * the existing integration.
 */
export declare function createHarnessJitDescribeTool<TContext>(registry: RuntimeRegistry, adapter: HarnessAdapter<TContext>, options?: HarnessJitDescribeOptions): HarnessToolDefinition<TContext>;
/** Successful execute details retained for observation/benchmark compatibility. */
export interface HarnessJitExecuteProgramDetails {
    source: string;
    status: "success";
    result: unknown;
    graph: ExecutionGraph;
    trace: readonly TraceEntry[];
    totalDurationMs: number;
}
/** Host-neutral compile-and-execute transport for the current legacy DSL. */
export declare function createHarnessJitExecuteProgramTool<TContext>(registry: RuntimeRegistry, adapter: HarnessAdapter<TContext>, options?: HarnessJitExecuteOptions): HarnessToolDefinition<TContext>;
/** Create the legacy DSL transport set; `describeTools:false` omits discovery. */
export declare function createHarnessJitTools<TContext>(registry: RuntimeRegistry, adapter: HarnessAdapter<TContext>, options?: HarnessJitToolsOptions): readonly HarnessToolDefinition<TContext>[];
/**
 * Convenience installation for plugin-owned provider tools plus the legacy DSL
 * transports. Returns one idempotent disposer and rolls back partial
 * registration if the harness rejects a later definition.
 */
export declare function installLegacyDslJit<TContext>(adapter: HarnessAdapter<TContext>, registry: RuntimeRegistry, options?: HarnessLegacyDslInstallOptions): HarnessDisposer;
