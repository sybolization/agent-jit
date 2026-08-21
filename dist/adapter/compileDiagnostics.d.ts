import type { ExecutionDslCompileError } from "../compiler/compile.js";
/** Exact legacy JIT compile-error projection, kept host-neutral. */
export declare function renderHarnessCompileFailure(error: ExecutionDslCompileError): string;
