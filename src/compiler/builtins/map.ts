import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
import { applyPositionalArgs, literalArg, literalKindError, refArg, suggestToolNames } from "../helpers.js";
import { mapCallBindings } from "../toolCall.js";

/**
 * canonical map：调用绑定形态（REQ-7 冻结）。
 *
 *   map(<源>, <工具id>(<参数名>=_.<字段>), ...)
 *
 * 位置参数永远允许；tool 参数必须是嵌套调用（kind === "call"），
 * key= 元数据、字符串/裸标识符 tool、lambda 均被拒绝并报专用诊断码。
 */

export function buildMapNode(
  statement: ParsedStatement,
  options: { tools?: ToolCatalog },
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source", "tool"], diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);
  const bindingArg = effective.args.find((arg) => arg.key === "tool")?.value;

  // canonical：tool 参数必须是调用绑定形态（含字符串 tool= 写法一并拒绝）
  if (bindingArg?.kind !== "call") {
    diagnostics.push({
      line: statement.line,
      code: "MAP_BINDING_EXPECTED_CALL",
      message: "map 的第二个参数应是一个嵌套调用（如 github.get_repository(full_name=_.full_name)）",
      suggestion: "格式：map(<源>, <工具>(<参数>=_.<字段>), ...)",
    });
    return undefined;
  }

  // key= 元数据与调用形态互斥（canonical 用嵌套调用表达绑定）
  const keyArg = effective.args.find((arg) => arg.key === "key");
  if (keyArg) {
    diagnostics.push({
      line: keyArg.line,
      code: "MAP_BINDING_KEY_NOT_ALLOWED",
      message: "canonical 语法用嵌套调用表达绑定，不再接受 key= 元数据",
      suggestion: "把 key= 改为调用内的参数映射（<参数名>=_.<字段>）",
    });
    return undefined;
  }

  const tools = options.tools;
  const toolId = bindingArg.callee;
  const bindings = tools ? mapCallBindings(bindingArg, "_", tools, diagnostics) : undefined;

  let concurrency = 5;
  const concurrencyArg = literalArg(effective, "concurrency", diagnostics);
  if (concurrencyArg !== undefined) {
    const error = literalKindError(concurrencyArg, "concurrency", "int");
    if (error) {
      diagnostics.push({ line: statement.line, code: "config_type_mismatch", message: error, suggestion: "concurrency 应为正整数" });
      return undefined;
    }
    concurrency = Number(concurrencyArg);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      diagnostics.push({
        line: statement.line,
        code: "config_type_mismatch",
        message: "map 的 concurrency 应为正整数",
        suggestion: "如 concurrency=5",
      });
      return undefined;
    }
  }

  for (const arg of effective.args) {
    if (!["source", "tool", "concurrency"].includes(arg.key ?? "")) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `map 不支持参数“${arg.key}”`,
        suggestion: "map 仅支持 source / concurrency 与嵌套调用绑定",
      });
    }
  }

  const tool = typeof toolId === "string" && tools ? tools.get(toolId) : undefined;
  if (!tool) {
    diagnostics.push({
      line: statement.line,
      code: "unknown_tool",
      message: `map 引用了未注册的工具：${String(toolId)}`,
      suggestion: suggestToolNames(tools, String(toolId)) ?? "使用 registry 中已注册的工具 id（如 github.get_repository）",
    });
    return undefined;
  }
  if (!bindings || Object.keys(bindings).length === 0) return undefined;
  if (!source) return undefined;

  // IR 永远保存 canonical id（模型写 host alias 也无感，resolver 已解析）
  return { id: statement.name, kind: "map", source, tool: tool.id, bindings, concurrency };
}
