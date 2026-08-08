import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
import { applyPositionalArgs, refArg } from "../helpers.js";

export function buildReturnNode(
  statement: ParsedStatement,
  _options: { tools?: ToolCatalog },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["value"], diagnostics);
  if (!effective) return undefined;
  const value = refArg(effective, "value", defined, diagnostics);
  for (const arg of effective.args) {
    if (arg.key !== "value") {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `return 不支持参数“${arg.key}”`,
        suggestion: "return 仅支持 value",
      });
    }
  }
  if (!value) return undefined;

  return { id: statement.name, kind: "return", value };
}
