import type { LiteralValue, ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolDefinition } from "../../tools/definition.js";
import { parseExpr, type ExprNode } from "../../language/expression.js";
import type { ExecutionNode } from "../ir.js";
import { applyPositionalArgs, refArg } from "../helpers.js";

/**
 * compute（R4e）：元素级字段计算。
 * `compute(<source>, <输出字段>=<表达式字符串>, ...)` — source 是位置参数（引用），
 * 其余命名参数为"输出字段 = 受限算术表达式"（白名单：字段引用 + 数字 + `+ - * /` + 括号），
 * 表达式在编译期预解析（错误 → 编译诊断，repair 可修）。
 */
export function buildComputeNode(
  statement: ParsedStatement,
  _options: { tools?: readonly ToolDefinition[] },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source"], diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);

  const args: Record<string, LiteralValue> = {};
  const exprs: Record<string, ExprNode> = {};
  for (const arg of effective.args) {
    if (arg.key === "source" || arg.key === undefined) continue;
    if (arg.value.kind !== "literal" || typeof arg.value.literal !== "string") {
      diagnostics.push({
        line: arg.line,
        code: "config_type_mismatch",
        message: `compute 的参数“${arg.key}”需要字符串表达式（如 ${arg.key}="forks / stars"）`,
        suggestion: `格式：compute(<源>, <输出字段>="<表达式>")`,
      });
      continue;
    }
    const parsed = parseExpr(arg.value.literal);
    if (!parsed.ok) {
      diagnostics.push({
        line: arg.line,
        code: "expression_invalid",
        message: `compute 表达式“${arg.value.literal}”无效：${parsed.error}`,
        suggestion: "支持：字段引用 + 数字字面量 + 四则运算（+ - * /）+ 括号",
      });
      continue;
    }
    args[arg.key] = arg.value.literal;
    exprs[arg.key] = parsed.node;
  }

  if (Object.keys(args).length === 0) {
    diagnostics.push({
      line: statement.line,
      code: "syntax",
      message: "compute 至少需要一个 <输出字段>=<表达式> 参数",
      suggestion: '如 compute(details, ratio="forks / stars")',
    });
  }
  if (!source || Object.keys(args).length === 0) return undefined;
  return { id: statement.name, kind: "compute", op: "compute", source, args, expr: exprs };
}
