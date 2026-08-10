import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";

/**
 * concat（R5 review 新增）：真正的列表拼接。
 * `concat(<source1>, <source2>, ...≥2)` — 位置参数全部是源数组（数量不定），
 * 按顺序拼接成一个大数组，元素原样保留，不做任何字段合并。
 *
 * 与 merge_by_key（join 节点）的分工：concat 用于"把两段列表接在一起"，
 * merge_by_key 用于"给每条记录附加另一批数据的字段"——两者语义完全不同，
 * 各自有明确的关键字，模型不再需要把列表拼接硬塞进 join。
 */
export function buildConcatNode(
  statement: ParsedStatement,
  _options: { tools?: ToolCatalog },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const sources: string[] = [];
  for (const arg of statement.args) {
    if (arg.key === undefined) {
      if (arg.value.kind !== "ref") {
        diagnostics.push({
          line: arg.line,
          code: "invalid_reference",
          message: "concat 的 source 参数必须是先前定义的变量引用",
          suggestion: "如 concat(high, low)",
        });
        continue;
      }
      const name = arg.value.name ?? "";
      if (!defined.has(name)) {
        diagnostics.push({
          line: arg.line,
          code: "undefined_reference",
          message: `concat 引用了未定义的变量“${name}”`,
          suggestion: `“${name}”必须在 concat 之前定义`,
        });
        continue;
      }
      sources.push(name);
      continue;
    }
    diagnostics.push({
      line: arg.line,
      code: "unknown_parameter",
      message: `concat 不支持参数“${arg.key}”`,
      suggestion: "concat 仅支持位置参数 source（≥2 个），无 key",
    });
  }
  if (sources.length < 2) {
    diagnostics.push({
      line: statement.line,
      code: "syntax",
      message: "concat 至少需要 2 个源数组（按顺序拼接）",
      suggestion: "如 concat(high, low)",
    });
    return undefined;
  }
  return { id: statement.name, kind: "concat", sources };
}
