/**
 * Host-neutral tool surface used by the legacy DSL integration.
 *
 * The adapter deliberately models only the capabilities the current JIT needs:
 * registration, a live catalog, and nested execution through the harness's
 * authoritative dispatch path. Prompt assembly, events, approvals, and code
 * runtimes remain harness-owned concerns.
 */
export {};
