import { compileExecutionDsl, ExecutionDslCompileError, } from "../compiler/compile.js";
import { describeProgramDescription, executeProgramDescription, renderRoutingDslReference, } from "../prompt/routingToolPrompts.js";
import { execute } from "../runtime/runtime.js";
import { describeToolContracts, MAX_DESCRIBE_TOOLS, } from "../tools/jitTools.js";
import { renderHarnessCompileFailure } from "./compileDiagnostics.js";
import { registeredToolAsHarnessTool } from "./toolAdapter.js";
import { HarnessToolView, unreachableHarnessCaller, } from "./toolView.js";
/** Runtime registry with plugin-owned tools taking precedence over host tools. */
class ExecutionRegistry {
    base;
    host;
    constructor(base, host) {
        this.base = base;
        this.host = host;
    }
    get(name) {
        return this.base.get(name) ?? this.host?.get(name);
    }
    all() {
        return [...this.base.all(), ...(this.host?.all() ?? [])];
    }
    resolveId(name) {
        return this.base.resolveId(name) ?? this.host?.resolveId(name);
    }
    suggestIds(name, max) {
        const limit = max ?? 2;
        const base = this.base.suggestIds(name, limit);
        const host = this.host?.suggestIds(name, limit) ?? [];
        const seen = new Set(base.map((item) => item.canonical));
        const merged = [...base];
        for (const item of host) {
            if (seen.has(item.canonical))
                continue;
            seen.add(item.canonical);
            merged.push(item);
        }
        return merged.slice(0, limit);
    }
}
function cleanupInReverse(disposers) {
    const errors = [];
    for (const dispose of [...disposers].reverse()) {
        try {
            dispose();
        }
        catch (error) {
            errors.push(error);
        }
    }
    return errors;
}
function throwCleanupErrors(errors, message) {
    if (errors.length === 0)
        return;
    if (errors.length === 1)
        throw errors[0];
    throw new AggregateError(errors, message);
}
/**
 * Host-neutral `jit_describe_tools`: live catalog → deterministic DSL
 * contracts, with the exact strict-error and first-call reference semantics of
 * the existing integration.
 */
export function createHarnessJitDescribeTool(registry, adapter, options = {}) {
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
            const toolNames = args.tool_names;
            if (!Array.isArray(toolNames) ||
                toolNames.length === 0 ||
                toolNames.length > MAX_DESCRIBE_TOOLS) {
                throw new Error(`tool_names 必须是 1..${MAX_DESCRIBE_TOOLS} 个工具名的数组（严格语义：不允许 partial success）`);
            }
            const names = toolNames.filter((item) => typeof item === "string");
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
            if (contracts.startsWith("错误"))
                throw new Error(contracts);
            if (options.describeDslReference === "first-call" && !referenceReturned) {
                referenceReturned = true;
                return `${renderRoutingDslReference()}\n\n${contracts}`;
            }
            return contracts;
        },
    };
}
/** Host-neutral compile-and-execute transport for the current legacy DSL. */
export function createHarnessJitExecuteProgramTool(registry, adapter, options = {}) {
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
            const source = args.source;
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
            let graph;
            try {
                ({ graph } = compileExecutionDsl(source, { tools: executionRegistry }));
            }
            catch (error) {
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
export function createHarnessJitTools(registry, adapter, options = {}) {
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
export function installLegacyDslJit(adapter, registry, options = {}) {
    const disposers = [];
    try {
        for (const tool of registry.all()) {
            disposers.push(adapter.registerTool(registeredToolAsHarnessTool(tool, {
                dslSignature: options.dslSignature ?? "inline",
            })));
        }
        for (const tool of createHarnessJitTools(registry, adapter, options)) {
            disposers.push(adapter.registerTool(tool));
        }
    }
    catch (error) {
        const cleanupErrors = cleanupInReverse(disposers);
        if (cleanupErrors.length > 0) {
            const message = error instanceof Error
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
        if (pending.length === 0)
            return;
        const failed = [];
        const errors = [];
        for (const dispose of pending) {
            try {
                dispose();
            }
            catch (error) {
                failed.push(dispose);
                errors.push(error);
            }
        }
        pending = failed;
        throwCleanupErrors(errors, "Multiple legacy DSL JIT disposers failed");
    };
}
