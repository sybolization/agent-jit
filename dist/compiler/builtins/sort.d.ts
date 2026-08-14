import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * sort：按字段排序（R4c closed operator）。
 * `sort(<source>, key=<字段名>, desc=<true|false>)` — source 位置参数（引用），
 * key 必填字符串字面量，desc 可选布尔字面量（默认 false 升序）。
 */
export declare function buildSortNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
