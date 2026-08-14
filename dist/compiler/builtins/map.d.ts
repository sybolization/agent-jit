import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * canonical map：调用绑定形态（REQ-7 冻结）。
 *
 *   map(<源>, <工具id>(<参数名>=_.<字段>), ...)
 *
 * 位置参数永远允许；tool 参数必须是嵌套调用（kind === "call"），
 * key= 元数据、字符串/裸标识符 tool、lambda 均被拒绝并报专用诊断码。
 */
export declare function buildMapNode(statement: ParsedStatement, options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
