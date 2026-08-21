import type { ExecutionGraph } from "../compiler/ir.js";
import {
  compileExecutionDsl,
  ExecutionDslCompileError,
} from "../compiler/compile.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import {
  describeProgramDescription,
  executeProgramDescription,
  renderRoutingDslReference,
  type DescribeDslReferenceMode,
  type RoutingPromptVariant,
} from "../prompt/routingToolPrompts.js";
import { execute, type RuntimeRegistry } from "../runtime/runtime.js";
import type { TraceEntry } from "../runtime/trace.js";
import {
  describeToolContracts,
  MAX_DESCRIBE_TOOLS,
} from "../tools/jitTools.js";
import { renderHarnessCompileFailure } from "./compileDiagnostics.js";
import { registeredToolAsHarnessTool } from "./toolAdapter.js";
import {
  HarnessToolView,
  type HarnessHostToolsConfig,
  unreachableHarnessCaller,
} from "./toolView.js";
import type {
  HarnessAdapter,
  HarnessDisposer,
  HarnessToolDefinition,
} from "./types.js";

/** Runtime registry with plugin-owned tools taking precedence over host tools. */
class ExecutionRegistry implements RuntimeRegistry {
  constructor(
    private readonly base: RuntimeRegistry,
    private readonly host: HarnessToolView | undefined,
  ) {}

  get(name: string) {
    return this.base.get(name) ?? this.host?.get(name);
  }

  all() {
    return [...this.base.all(), ...(this.host?.all() ?? [])];
  }

  resolveId(name: string): string | undefined {
    return this.base.resolveId(name) ?? this.host?.resolveId(name);
  }

  suggestIds(name: string, max?: number) {
    const limit = max ?? 2;
    const base = this.base.suggestIds(name, limit);
    const host = this.host?.suggestIds(name, limit) ?? [];
    const seen = new Set(base.map((item) => item.canonical));
    const merged = [...base];
    for (const item of host) {
      if (seen.has(item.canonical)) continue;
      seen.add(item.canonical);
      merged.push(item);
    }
    return merged.slice(0, limit);
  }
}

function cleanupInReverse(
  disposers: readonly HarnessDisposer[],
): readonly unknown[] {
  const errors: unknown[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

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

export interface HarnessJitToolsOptions
  extends HarnessJitDescribeOptions,
    HarnessJitExecuteOptions {
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
export function createHarnessJitDescribeTool<TContext>(
  registry: RuntimeRegistry,
  adapter: HarnessAdapter<TContext>,
  options: HarnessJitDescribeOptions = {},
): HarnessToolDefinition<TContext> {
  const routingPrompt = options.routingPrompt ?? "baseline";
  let referenceReturned = false;

  return {
    name: "jit_describe_tools",
    description: describeProgramDescription(routingPrompt),
    inputSchema: {
      type: "object",
      properties: {
        tool_names: {
          type: "array",
          items: { type: "string" },
          description: "要获取 DSL 契约的工具 id 列表",
        },
      },
      required: ["tool_names"],
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
    renderText: (_args, value) => String(value),
    execute: async (args, context) => {
      const toolNames = (args as { tool_names?: unknown }).tool_names;
      if (
        !Array.isArray(toolNames) ||
        toolNames.length === 0 ||
        toolNames.length > MAX_DESCRIBE_TOOLS
      ) {
        throw new Error(
          `tool_names 必须是 1..${MAX_DESCRIBE_TOOLS} 个工具名的数组（严格语义：不允许 partial success）`,
        );
      }

      const names = toolNames.filter(
        (item): item is string => typeof item === "string",
      );
      const hostCatalog = adapter.catalog(context);
      const host = new HarnessToolView({
        catalog: hostCatalog,
        caller: unreachableHarnessCaller(),
        base: registry,
        allow: options.hostTools?.allow,
        exclude: options.hostTools?.exclude,
      });
      const executionRegistry = new ExecutionRegistry(registry, host);
      const contracts = describeToolContracts(executionRegistry, names, {
        header: "# Requested Tool Contracts",
      });
      if (contracts.startsWith("错误")) throw new Error(contracts);

      if (options.describeDslReference === "first-call" && !referenceReturned) {
        referenceReturned = true;
        return `${renderRoutingDslReference()}\n\n${contracts}`;
      }
      return contracts;
    },
  };
}

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
export function createHarnessJitExecuteProgramTool<TContext>(
  registry: RuntimeRegistry,
  adapter: HarnessAdapter<TContext>,
  options: HarnessJitExecuteOptions = {},
): HarnessToolDefinition<TContext> {
  return {
    name: "jit_execute_program",
    description: executeProgramDescription(options.routingPrompt ?? "baseline"),
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Agent Execution DSL 程序源码（每条语句独占一行）",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
    renderText: (_args, value) => String(value),
    execute: async (args, context) => {
      const source = (args as { source?: unknown }).source;
      if (typeof source !== "string" || source.trim().length === 0) {
        throw new Error("source 为空。请把完整 DSL 程序放在 source 参数里。");
      }

      const hostExecution = adapter.execution(context);
      const host = new HarnessToolView({
        catalog: hostExecution,
        caller: (name, callArgs) => hostExecution.callTool(name, callArgs),
        base: registry,
        allow: options.hostTools?.allow,
        exclude: options.hostTools?.exclude,
      });
      const executionRegistry = new ExecutionRegistry(registry, host);

      let graph: ExecutionGraph;
      try {
        ({ graph } = compileExecutionDsl(source, { tools: executionRegistry }));
      } catch (error) {
        if (error instanceof ExecutionDslCompileError) {
          options.onCompileFailure?.(error.diagnostics);
          throw new Error(renderHarnessCompileFailure(error));
        }
        throw error;
      }

      const execution = await execute(graph, executionRegistry);
      if (execution.status === "failed") {
        throw new Error(`执行失败：${execution.error}`);
      }
      return JSON.stringify(execution.result);
    },
  };
}

/** Create the legacy DSL transport set; `describeTools:false` omits discovery. */
export function createHarnessJitTools<TContext>(
  registry: RuntimeRegistry,
  adapter: HarnessAdapter<TContext>,
  options: HarnessJitToolsOptions = {},
): readonly HarnessToolDefinition<TContext>[] {
  return [
    ...(options.describeTools === false
      ? []
      : [createHarnessJitDescribeTool(registry, adapter, options)]),
    createHarnessJitExecuteProgramTool(registry, adapter, options),
  ];
}

/**
 * Convenience installation for plugin-owned provider tools plus the legacy DSL
 * transports. Returns one idempotent disposer and rolls back partial
 * registration if the harness rejects a later definition.
 */
export function installLegacyDslJit<TContext>(
  adapter: HarnessAdapter<TContext>,
  registry: RuntimeRegistry,
  options: HarnessLegacyDslInstallOptions = {},
): HarnessDisposer {
  const disposers: HarnessDisposer[] = [];
  try {
    for (const tool of registry.all()) {
      disposers.push(
        adapter.registerTool(
          registeredToolAsHarnessTool<TContext>(tool, {
            dslSignature: options.dslSignature ?? "inline",
          }),
        ),
      );
    }
    for (const tool of createHarnessJitTools(registry, adapter, options)) {
      disposers.push(adapter.registerTool(tool));
    }
  } catch (error) {
    const cleanupErrors = cleanupInReverse(disposers);
    if (cleanupErrors.length > 0) {
      const message =
        error instanceof Error
          ? error.message
          : "Legacy DSL JIT registration failed and rollback also failed";
      throw new AggregateError([error, ...cleanupErrors], message, {
        cause: error,
      });
    }
    throw error;
  }

  // Keep only failed cleanup callbacks between attempts. Successful callbacks
  // are never invoked twice, while a transiently failing host disposer remains
  // retryable instead of permanently leaking the registration.
  let pending = [...disposers].reverse();
  return () => {
    if (pending.length === 0) return;
    const failed: HarnessDisposer[] = [];
    const errors: unknown[] = [];
    for (const dispose of pending) {
      try {
        dispose();
      } catch (error) {
        failed.push(dispose);
        errors.push(error);
      }
    }
    pending = failed;
    throwCleanupErrors(errors, "Multiple legacy DSL JIT disposers failed");
  };
}
