import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { type HarnessHostToolsConfig, type HarnessJitExecuteProgramDetails } from "../../adapter/index.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { DescribeDslReferenceMode, RoutingPromptVariant } from "../../prompt/routingToolPrompts.js";
import type { RuntimeRegistry } from "../../runtime/runtime.js";
/** Historical DSH host-filter name retained for source compatibility. */
export interface DshHostToolsConfig extends HarnessHostToolsConfig {
}
/** Historical details name retained for benchmark consumers. */
export interface JitExecuteProgramDetails extends HarnessJitExecuteProgramDetails {
}
/** Compatibility facade over the host-neutral describe-tool factory. */
export declare function createDshJitDescribeTool(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    hostTools?: DshHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    describeDslReference?: DescribeDslReferenceMode;
}): ToolDefinition;
/** Compatibility facade over the host-neutral execute-tool factory. */
export declare function createDshJitExecuteProgramTool(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    hostTools?: DshHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): ToolDefinition;
/**
 * Create the historical DSH `jit_*` set through the neutral factories.
 * `describeTools:false` continues to omit only the discovery transport.
 */
export declare function createDshJitTools(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    describeTools?: boolean;
    hostTools?: DshHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    describeDslReference?: DescribeDslReferenceMode;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): readonly ToolDefinition[];
