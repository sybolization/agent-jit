import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * compute（R4e）：元素级字段计算。
 * `compute(<source>, <输出字段>=<表达式字符串>, ...)` — source 是位置参数（引用），
 * 其余命名参数为"输出字段 = 受限算术表达式"（白名单：字段引用 + 数字 + `+ - * /` + 括号），
 * 表达式在编译期预解析（错误 → 编译诊断，repair 可修）。
 */
export declare function buildComputeNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
