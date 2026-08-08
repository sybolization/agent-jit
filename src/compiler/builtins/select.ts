import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import { isComparisonExpr, parseExpr, type ExprNode } from "../../language/expression.js";
import type { ExecutionNode } from "../ir.js";
import { applyPositionalArgs, literalArg, refArg } from "../helpers.js";

/**
 * select（R4e）：谓词过滤（filter 的推广，支持比较）。
 * `select(<source>, "<比较谓词>")` — pred 是位置参数（字符串），顶层必须是比较表达式
 * （`> >= < <= == !=`），元素满足谓词才保留。
 */
export function buildSelectNode(
  statement: ParsedStatement,
  _options: { tools?: ToolCatalog },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source", "pred"], diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);
  const pred = literalArg(effective, "pred", diagnostics, { required: true });
  const exprs: Record<string, ExprNode> = {};
  if (typeof pred === "string") {
    const parsed = parseExpr(pred);
    if (!parsed.ok) {
      diagnostics.push({
        line: statement.line,
        code: "expression_invalid",
        message: `select 谓词“${pred}”无效：${parsed.error}`,
        suggestion: '如 "ratio > 0.15"（比较运算符：> >= < <= == !=）',
      });
    } else if (!isComparisonExpr(parsed.node)) {
      diagnostics.push({
        line: statement.line,
        code: "expression_invalid",
        message: `select 谓词“${pred}”必须是比较表达式（结果应为布尔）`,
        suggestion: '如 "ratio > 0.15" 或 "score >= 100"',
      });
    } else {
      exprs.pred = parsed.node;
    }
  } else if (pred !== undefined) {
    diagnostics.push({
      line: statement.line,
      code: "config_type_mismatch",
      message: "select 的 pred 需要字符串表达式",
      suggestion: '如 select(<源>, "ratio > 0.15")',
    });
  }
  for (const arg of effective.args) {
    if (!["source", "pred"].includes(arg.key ?? "")) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `select 不支持参数“${arg.key}”`,
        suggestion: "select 仅支持 source / pred",
      });
    }
  }
  if (!source || typeof pred !== "string") return undefined;
  return { id: statement.name, kind: "compute", op: "select", source, args: { pred }, expr: exprs };
}
