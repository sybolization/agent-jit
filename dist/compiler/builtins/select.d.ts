import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * select（R4e）：谓词过滤（filter 的推广，支持比较）。
 * `select(<source>, "<比较谓词>")` — pred 是位置参数（字符串），顶层必须是比较表达式
 * （`> >= < <= == !=`），元素满足谓词才保留。
 */
export declare function buildSelectNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
