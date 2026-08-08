import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolDefinition } from "../../tools/definition.js";
import type { ExecutionNode } from "../ir.js";
import { pushMissing } from "../helpers.js";

/**
 * join（R4e）：多输入按 key 合并字段。
 * `join(<source1>, <source2>, ...≥2, key="<字段>")` — 位置参数全部是 source（数量不定），
 * sources[0] 为基准，其余按 key 匹配后附加字段（基准已有字段不覆盖）。
 */
export function buildJoinNode(
  statement: ParsedStatement,
  _options: { tools?: readonly ToolDefinition[] },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const sources: string[] = [];
  let key: string | undefined;
  for (const arg of statement.args) {
    if (arg.key === undefined) {
      if (arg.value.kind !== "ref") {
        diagnostics.push({
          line: arg.line,
          code: "invalid_reference",
          message: "join 的 source 参数必须是先前定义的变量引用",
          suggestion: '如 join(details, contrib, commit, key="full_name")',
        });
        continue;
      }
      const name = arg.value.name ?? "";
      if (!defined.has(name)) {
        diagnostics.push({
          line: arg.line,
          code: "undefined_reference",
          message: `join 引用了未定义的变量“${name}”`,
          suggestion: `“${name}”必须在 join 之前定义`,
        });
        continue;
      }
      sources.push(name);
      continue;
    }
    if (arg.key === "key") {
      if (arg.value.kind !== "literal" || typeof arg.value.literal !== "string") {
        diagnostics.push({
          line: arg.line,
          code: "config_type_mismatch",
          message: "join 的参数“key”需要字符串字面量",
          suggestion: '如 key="full_name"',
        });
      } else {
        key = arg.value.literal;
      }
      continue;
    }
    diagnostics.push({
      line: arg.line,
      code: "unknown_parameter",
      message: `join 不支持参数“${arg.key}”`,
      suggestion: 'join 仅支持位置参数 source（≥2 个）与 key',
    });
  }
  if (!key) pushMissing(diagnostics, statement.line, "join", "key");
  if (sources.length < 2) {
    diagnostics.push({
      line: statement.line,
      code: "syntax",
      message: "join 至少需要 2 个 source（基准 + 至少一个附加）",
      suggestion: '如 join(details, contrib, commit, key="full_name")',
    });
  }
  if (sources.length < 2 || !key) return undefined;
  return { id: statement.name, kind: "join", sources, key };
}
