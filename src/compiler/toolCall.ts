import type { ParsedArg, ParsedStatement } from "../language/ast.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import type { ToolDefinition } from "../tools/definition.js";
import type { ExecutionNode, MapNode, ValueExpr } from "./ir.js";
import {
  literalKindError,
  normalizeLiteral,
  pushMissing,
  toolParams,
  type ElementSchema,
} from "./helpers.js";

/**
 * 工具调用构建（`buildToolNode`）与 map 绑定校验（`mapCallBindings` /
 * `validateMapBindings`）。canonical 语法中 map 只用调用绑定形态，
 * `toolArg`（字符串/裸标识符 tool 参数）已归入 legacy 编译器。
 */

/** 从 call 表达式的参数中提取 binding 映射（`_.field` / `<param>.field` → 元素字段）。 */
export function mapCallBindings(
  call: { callee?: string; args?: ParsedArg[] },
  prefix: string,
  tools: readonly ToolDefinition[],
  diagnostics: DslDiagnostic[],
): Record<string, string> | undefined {
  const tool = tools.find((item) => item.id === call.callee);
  if (!tool) return undefined; // unknown_tool 由调用方统一处理
  const parameterKeys = new Set(toolParams(tool).map((parameter) => parameter.key));
  const bindings: Record<string, string> = {};
  let ok = true;
  for (const arg of call.args ?? []) {
    if (arg.key === undefined) {
      diagnostics.push({
        line: arg.line,
        code: "syntax",
        message: `map 的绑定调用内参数必须写成 <参数名>=<值>（位置参数无法表达绑定）`,
        suggestion: `格式：${call.callee}(<参数名>=${prefix}.<字段>)`,
      });
      ok = false;
      continue;
    }
    if (!parameterKeys.has(arg.key)) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `工具“${call.callee}”未声明参数“${arg.key}”`,
        suggestion: `使用该工具声明的参数名：${[...parameterKeys].join(" / ")}`,
      });
      ok = false;
      continue;
    }
    if (arg.value.kind !== "ref" || !arg.value.name?.startsWith(`${prefix}.`)) {
      diagnostics.push({
        line: arg.line,
        code: "MAP_BINDING_REF_INVALID",
        message: `绑定引用必须形如 ${prefix}.<字段>（引用当前元素），得到 ${arg.value.kind === "ref" ? `“${arg.value.name}”` : "字面量"}`,
        suggestion: `把参数“${arg.key}”的值写成 ${prefix}.<元素字段名>`,
      });
      ok = false;
      continue;
    }
    const field = arg.value.name.slice(prefix.length + 1);
    if (!field) {
      diagnostics.push({
        line: arg.line,
        code: "MAP_BINDING_REF_INVALID",
        message: `${prefix}. 后缺少字段名`,
        suggestion: `如 ${prefix}.full_name`,
      });
      ok = false;
      continue;
    }
    bindings[arg.key] = field;
  }
  return ok ? bindings : undefined;
}

export function buildToolNode(
  statement: ParsedStatement,
  tool: ToolDefinition,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const parameterByKey = new Map(toolParams(tool).map((parameter) => [parameter.key, parameter]));
  const args: Record<string, ValueExpr> = {};
  const seenArgs = new Set<string>();

  for (const arg of statement.args) {
    const key = arg.key ?? "";
    if (seenArgs.has(key)) {
      diagnostics.push({
        line: arg.line,
        code: "duplicate_argument",
        message: `参数“${arg.key}”重复赋值`,
        suggestion: "每个参数只能赋值一次",
      });
      continue;
    }
    seenArgs.add(key);

    const parameter = parameterByKey.get(key);
    if (!parameter) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `工具“${tool.id}”未声明参数“${arg.key}”`,
        suggestion: `使用该工具声明的参数名：${[...parameterByKey.keys()].join(" / ")}`,
      });
      continue;
    }

    if (arg.value.kind === "ref") {
      const name = arg.value.name ?? "";
      if (!defined.has(name)) {
        diagnostics.push({
          line: arg.line,
          code: "undefined_reference",
          message: `参数“${arg.key}”引用了未定义的变量“${name}”`,
          suggestion: `“${name}”必须在 ${statement.callee} 之前定义`,
        });
        continue;
      }
      args[key] = { kind: "ref", name };
      continue;
    }

    const literal = arg.value.literal ?? null;
    const normalized = normalizeLiteral(literal, parameter.kind);
    const error = literalKindError(normalized, key, parameter.kind);
    if (error) {
      diagnostics.push({
        line: arg.line,
        code: "config_type_mismatch",
        message: error,
        suggestion: `检查字面量类型与声明 kind（${parameter.kind}）是否匹配`,
      });
      continue;
    }
    args[key] = { kind: "literal", value: normalized };
  }

  // REQ-3：inputSchema 声明的 required 参数必须提供（key 出现过但值非法时只报类型错误，不再叠加"缺失"）
  for (const parameter of parameterByKey.values()) {
    if (parameter.required && !seenArgs.has(parameter.key)) {
      pushMissing(diagnostics, statement.line, statement.callee, parameter.key);
    }
  }

  return { id: statement.name, kind: "tool", tool: tool.id, args };
}

/**
 * REQ-5：map 绑定字段校验——`_.<field>` 必须存在于 source 元素 schema
 * （不存在 → UNKNOWN_FIELD，suggestion 列出可用字段），且字段类型与绑定参数
 * 的 inputSchema 类型基础匹配（integer/number 互配，string 配 string，
 * boolean 配 boolean；其余组合 → config_type_mismatch；prop.type 缺失则跳过）。
 * source 元素形状未知（compute 产物 / 未注册工具）时跳过，避免误报。
 * `line` 指向该 map 语句的行号，供诊断定位。
 */
export function validateMapBindings(
  node: MapNode,
  tools: readonly ToolDefinition[],
  symbols: ReadonlyMap<string, ElementSchema | undefined>,
  diagnostics: DslDiagnostic[],
  line: number,
): void {
  const elementSchema = symbols.get(node.source);
  if (!elementSchema) return; // 未知元素形状 → 跳过（不误报）
  const tool = tools.find((item) => item.id === node.tool);
  if (!tool) return; // unknown_tool 已另行报错
  const paramByKey = new Map(toolParams(tool).map((parameter) => [parameter.key, parameter]));
  const numeric = new Set(["integer", "number"]);
  for (const [param, field] of Object.entries(node.bindings)) {
    const prop = elementSchema.properties[field];
    if (!prop) {
      const available = Object.keys(elementSchema.properties).sort().join(", ");
      diagnostics.push({
        line,
        code: "UNKNOWN_FIELD",
        message: `map 绑定引用了元素上不存在的字段“${field}”（参数 ${param}）`,
        suggestion: `可用字段：${available}`,
      });
      continue;
    }
    const paramSpec = paramByKey.get(param);
    if (!paramSpec) continue; // unknown_parameter 已另行报错
    const propType = prop.type ?? "";
    if (!propType) continue; // 类型缺失（如 union）→ 跳过类型检查
    const paramNumeric = paramSpec.kind === "int" || paramSpec.kind === "number";
    const compatible = paramNumeric ? numeric.has(propType) : paramSpec.kind === propType;
    if (!compatible) {
      diagnostics.push({
        line,
        code: "config_type_mismatch",
        message: `map 绑定字段 _.${field}（类型 ${propType}）与参数 ${param}（期望 ${paramSpec.kind}）类型不匹配`,
        suggestion: `改绑一个 ${paramSpec.kind} 类型的字段`,
      });
    }
  }
}
