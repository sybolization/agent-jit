import type { DslDiagnostic } from "../language/diagnostics.js";
import type { ToolCatalog } from "../tools/registry.js";
import { type ExecutionGraph } from "./ir.js";
/**
 * Agent Execution DSL 编译器（canonical 入口，REQ-7 冻结语法）。
 *
 * 语言前端复用 `src/language/`（tokenizer / parser），本文件实现语义层：
 * - tool callee（registry 中的工具）→ `ToolNode`，参数校验
 *   （unknown_parameter / config_type_mismatch，LLM 幻觉参数名在编译期拒绝）；
 * - `map` / `take` / `filter` / `sort` / `compute` / `select` / `merge_by_key` / `concat` / `return`
 *   → 语言级 construct（`MapNode` / `ComputeNode` / `JoinNode` / `ConcatNode` / `ReturnNode`），
 *   `source` / `value` 必须是变量引用（引用即数据流边）；
 *   `join` 是 `merge_by_key` 的遗留别名（R1–R4 冻结产物兼容，编译产物同一节点）；
 * - 未注册 callee → `unknown_tool`。
 *
 * canonical 语法冻结：map 的第二个参数必须是嵌套工具调用绑定形态
 * （`map(xs, tool(field=_.field))`，字符串 id 会被拒绝）、
 * 位置参数永远允许。R1–R3 变体（key= 元数据 / lambda /
 * callable-ref 裸标识符）见 `src/experiments/languageVariants/legacyCompile.ts`。
 *
 * 输出确定性：同一段 DSL 永远编译出同一张图，并做 schema 自校验。
 */
export interface CompileExecutionDslOptions {
    tools?: ToolCatalog;
}
export interface CompileExecutionDslResult {
    graph: ExecutionGraph;
    diagnostics: readonly DslDiagnostic[];
}
export declare class ExecutionDslCompileError extends Error {
    readonly diagnostics: readonly DslDiagnostic[];
    constructor(diagnostics: readonly DslDiagnostic[]);
}
/**
 * Compile Agent Execution DSL source into an `ExecutionGraph`.
 *
 * 硬错误（语法 / 未知工具 / 未定义引用 / 重名 / 参数幻觉）一次性抛出，
 * soft 语义留待后续阶段。产物通过 `ExecutionGraphSchema` 自校验后返回。
 */
export declare function compileExecutionDsl(source: string, options?: CompileExecutionDslOptions): CompileExecutionDslResult;
