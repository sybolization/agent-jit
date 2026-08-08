import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolDefinition } from "../../tools/definition.js";
import type { ExecutionNode } from "../ir.js";
import { applyPositionalArgs, literalArg, literalKindError, refArg } from "../helpers.js";

export function buildTakeNode(
  statement: ParsedStatement,
  _options: { tools?: readonly ToolDefinition[] },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source", "count"], diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);
  const count = literalArg(effective, "count", diagnostics, { required: true });
  if (count !== undefined) {
    const error = literalKindError(count, "count", "int");
    if (error) {
      diagnostics.push({ line: statement.line, code: "config_type_mismatch", message: error, suggestion: "count 应为整数" });
      return undefined;
    }
  }
  for (const arg of effective.args) {
    if (!["source", "count"].includes(arg.key)) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `take 不支持参数“${arg.key}”`,
        suggestion: "take 仅支持 source / count",
      });
    }
  }
  if (!source || count === undefined) return undefined;

  return { id: statement.name, kind: "compute", op: "take", source, args: { count } };
}
