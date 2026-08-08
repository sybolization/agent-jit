import type { LiteralValue, ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
import { applyPositionalArgs, refArg } from "../helpers.js";

/**
 * filter：等值条件筛选（R4c closed operator）。
 * `filter(<source>, <字段>=<字面量>, ...)` — source 是位置参数（引用），
 * 其余命名参数为"字段 == 字面量"条件，元素需满足全部条件才保留。
 * 所有命名参数都是条件，无额外参数概念。
 */
export function buildFilterNode(
  statement: ParsedStatement,
  _options: { tools?: ToolCatalog },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source"], diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);

  const args: Record<string, LiteralValue> = {};
  for (const arg of effective.args) {
    if (arg.key === "source" || arg.key === undefined) continue;
    if (arg.value.kind !== "literal") {
      diagnostics.push({
        line: arg.line,
        code: "invalid_reference",
        message: `filter 的条件“${arg.key}”需要字面量（等值比较），不能引用节点`,
        suggestion: `把 ${arg.key} 写成字面量（如 ${arg.key}=false 或 ${arg.key}="TypeScript"）`,
      });
      continue;
    }
    args[arg.key] = arg.value.literal ?? null;
  }

  if (!source) return undefined;
  return { id: statement.name, kind: "compute", op: "filter", source, args };
}
