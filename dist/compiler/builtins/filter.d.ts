import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * filter：等值条件筛选（R4c closed operator）。
 * `filter(<source>, <字段>=<字面量>, ...)` — source 是位置参数（引用），
 * 其余命名参数为"字段 == 字面量"条件，元素需满足全部条件才保留。
 * 所有命名参数都是条件，无额外参数概念。
 */
export declare function buildFilterNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
