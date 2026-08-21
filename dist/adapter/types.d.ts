/**
 * Host-neutral tool surface used by the legacy DSL integration.
 *
 * The adapter deliberately models only the capabilities the current JIT needs:
 * registration, a live catalog, and nested execution through the harness's
 * authoritative dispatch path. Prompt assembly, events, approvals, and code
 * runtimes remain harness-owned concerns.
 */
/** JSON Schema-shaped object exchanged at the harness boundary. */
export type HarnessJsonSchema = Readonly<Record<string, unknown>>;
/** Exact cleanup callback returned by a harness registration. */
export type HarnessDisposer = () => void;
/** Static, host-neutral contract for one tool visible to the DSL compiler. */
export interface HarnessToolContract {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: HarnessJsonSchema;
    readonly outputSchema: HarnessJsonSchema;
}
/**
 * A tool definition that a harness can register.
 *
 * `renderText` is explicit because the current surface has two distinct,
 * observable projections: provider tools render JSON while the `jit_*`
 * transports render their already-serialized string value verbatim.
 */
export interface HarnessToolDefinition<TContext = unknown> extends HarnessToolContract {
    execute(args: unknown, context: TContext): Promise<unknown>;
    renderText(args: unknown, value: unknown): string;
}
/** A live view of the tools visible for one bound harness context. */
export interface HarnessToolCatalog {
    getTool(name: string): HarnessToolContract | undefined;
    listTools(): readonly HarnessToolContract[];
}
/** A live catalog that may also perform authoritative nested dispatch. */
export interface HarnessToolExecution extends HarnessToolCatalog {
    callTool(name: string, args: unknown): Promise<unknown>;
}
/**
 * Minimal host seam for installing and executing the legacy DSL JIT.
 *
 * `catalog()` intentionally does not grant execution. `execution()` binds the
 * opaque host context needed for scope, cancellation, parentage, policy, and
 * logging without exposing those host-specific concepts to the DSL core.
 */
export interface HarnessAdapter<TContext = unknown> {
    registerTool(definition: HarnessToolDefinition<TContext>): HarnessDisposer;
    catalog(context: TContext): HarnessToolCatalog;
    execution(context: TContext): HarnessToolExecution;
}
