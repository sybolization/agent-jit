import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
export declare function buildTakeNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
