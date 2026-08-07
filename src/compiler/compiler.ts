import { Value } from "typebox/value";

import type { LiteralValue, ParsedStatement } from "../language/ast.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import { Parser } from "../language/parser.js";
import { tokenize } from "../language/tokenizer.js";
import { isComparisonExpr, parseExpr } from "../runtime/expr.js";
import { ExecutionGraphSchema, type ExecutionGraph, type ExecutionNode, type ValueExpr } from "./ir.js";
import type { ToolSpec } from "./registry.js";

/**
 * Agent Execution DSL 编译器（第一版）：把 DSL 编译为通用 ExecutionIR。
 *
 * 语言前端复用 `src/language/`（tokenizer / parser），本文件实现语义层：
 * - tool callee（registry 中的工具）→ `ToolNode`，参数校验沿用 canvas 经验
 *   （unknown_parameter / config_type_mismatch，LLM 幻觉参数名在编译期拒绝）；
 * - `map` / `take` / `return` → 语言级 construct（`MapNode` / `ComputeNode` /
 *   `ReturnNode`），`source` / `value` 必须是变量引用（引用即数据流边）；
 * - 未注册 callee（含 filter / sort / agent）→ `unknown_tool`，留待后续阶段。
 *
 * 输出确定性：同一段 DSL 永远编译出同一张图，并做 schema 自校验。
 */

export interface CompileExecutionDslOptions {
  tools?: readonly ToolSpec[];

  /**
   * 语言实验开关：允许 map 的 tool 参数以裸标识符（callable reference）书写，
   * 如 `tool=github.get_repository`。默认 false（要求双引号字符串）。
   * 关闭时模型若写出裸标识符，编译器报 `EXPECTED_STRING_GOT_CALLABLE_REF`
   * （模型摩擦探针，用于统计模型自发的语法倾向）。
   */
  allowCallableRef?: boolean;

  /**
   * 语言实验开关：允许 map / take / return 的位置参数（如 `map(repos, "x")`、
   * `take(details, 3)`、`return top`）。默认 false。
   * 关闭时编译器报 `POSITIONAL_ARG_NOT_ALLOWED`（模型摩擦探针）。
   */
  allowPositionalArgs?: boolean;

  /**
   * 语言实验开关（R3）：map 的 element→argument 绑定表达方式。
   * - "key"（默认）：`map(repos, tool="...", key="full_name")` 元数据式绑定；
   * - "call"：`map(repos, github.get_repository(full_name=_.full_name))` 占位符调用；
   * - "lambda"：`map(repos, lambda repo: github.get_repository(full_name=repo.full_name))`。
   * 不匹配形态报专用诊断码（模型摩擦探针）。
   */
  allowMapBinding?: "key" | "call" | "lambda";
}

export interface CompileExecutionDslResult {
  graph: ExecutionGraph;
  diagnostics: readonly DslDiagnostic[];
}

export class ExecutionDslCompileError extends Error {
  readonly diagnostics: readonly DslDiagnostic[];

  constructor(diagnostics: readonly DslDiagnostic[]) {
    super(diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`).join("\n"));
    this.name = "ExecutionDslCompileError";
    this.diagnostics = diagnostics;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareNodes(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function normalizeLiteral(value: LiteralValue, kind: string): LiteralValue {
  if (typeof value !== "string") return value;
  const text = value.trim();
  const normalized = kind.toLowerCase();
  if ((normalized === "int" || normalized === "integer") && /^[-+]?\d+$/.test(text)) return Number(text);
  if ((normalized === "float" || normalized === "number") && text !== "" && Number.isFinite(Number(text))) {
    return Number(text);
  }
  if (normalized === "bool" || normalized === "boolean") {
    if (/^(true|1)$/i.test(text)) return true;
    if (/^(false|0)$/i.test(text)) return false;
  }
  return value;
}

function literalKindError(value: LiteralValue, parameterKey: string, kind: string): string | null {
  if (value === null || value === undefined) return null;
  const normalized = kind.toLowerCase();
  if (normalized === "int" || normalized === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `参数“${parameterKey}”期望整数，得到 ${typeof value === "number" ? "非整数" : typeof value}`;
    }
  } else if (normalized === "float" || normalized === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `参数“${parameterKey}”期望数字，得到 ${typeof value}`;
    }
  } else if (normalized === "bool" || normalized === "boolean") {
    if (typeof value !== "boolean") return `参数“${parameterKey}”期望布尔值，得到 ${typeof value}`;
  } else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return `参数“${parameterKey}”期望字符串/数字/布尔，得到 ${Array.isArray(value) ? "数组" : "对象"}`;
  }
  return null;
}

function pushMissing(
  diagnostics: DslDiagnostic[],
  line: number,
  callee: string,
  key: string,
): void {
  diagnostics.push({
    line,
    code: "syntax",
    message: `${callee} 缺少必填参数“${key}”`,
    suggestion: `为 ${callee} 补充 ${key}=<值>`,
  });
}

// ---------------------------------------------------------------------------
// Construct builders
// ---------------------------------------------------------------------------

/** 取字面量参数；ref 或缺失时报错，返回 undefined。 */
function literalArg(
  statement: ParsedStatement,
  key: string,
  diagnostics: DslDiagnostic[],
  options: { required?: boolean } = {},
): LiteralValue | undefined {
  const arg = statement.args.find((item) => item.key === key);
  if (!arg) {
    if (options.required) pushMissing(diagnostics, statement.line, statement.callee, key);
    return undefined;
  }
  if (arg.value.kind === "ref") {
    diagnostics.push({
      line: arg.line,
      code: "invalid_reference",
      message: `${statement.callee} 的参数“${key}”需要字面量，不能引用节点`,
      suggestion: `把 ${key} 写成字面量（如 ${key}="..."）`,
    });
    return undefined;
  }
  return arg.value.literal ?? null;
}

/** 取变量引用参数；literal、缺失或未定义时报错，返回引用名。 */
function refArg(
  statement: ParsedStatement,
  key: string,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): string | undefined {
  const arg = statement.args.find((item) => item.key === key);
  if (!arg) {
    pushMissing(diagnostics, statement.line, statement.callee, key);
    return undefined;
  }
  if (arg.value.kind === "literal") {
    diagnostics.push({
      line: arg.line,
      code: "invalid_reference",
      message: `${statement.callee} 的参数“${key}”必须引用先前定义的变量`,
      suggestion: `把 ${key} 写成变量名（如 ${key}=<某条语句的变量名>）`,
    });
    return undefined;
  }
  const name = arg.value.name ?? "";
  if (!defined.has(name)) {
    diagnostics.push({
      line: arg.line,
      code: "undefined_reference",
      message: `${statement.callee} 引用了未定义的变量“${name}”`,
      suggestion: `“${name}”必须在 ${statement.callee} 之前定义`,
    });
    return undefined;
  }
  return name;
}

/**
 * 取 map 的 tool 参数：接受双引号字符串字面量；
 * 若 allowCallableRef 开启，也接受裸标识符（callable reference，如 github.get_repository）。
 * 关闭时裸标识符报 EXPECTED_STRING_GOT_CALLABLE_REF（模型摩擦探针）。
 */
function toolArg(
  statement: ParsedStatement,
  diagnostics: DslDiagnostic[],
  allowCallableRef: boolean,
): string | undefined {
  const arg = statement.args.find((item) => item.key === "tool");
  if (!arg) {
    pushMissing(diagnostics, statement.line, statement.callee, "tool");
    return undefined;
  }
  if (arg.value.kind === "literal") {
    return String(arg.value.literal ?? "");
  }
  // kind === "ref"：裸标识符即 callable reference
  if (allowCallableRef) return arg.value.name ?? "";
  diagnostics.push({
    line: arg.line,
    code: "EXPECTED_STRING_GOT_CALLABLE_REF",
    message: `${statement.callee} 的 tool 参数要求双引号字符串（如 tool="github.get_repository"），但你写的是裸标识符“${arg.value.name}”`,
    suggestion: "给工具 id 加双引号：tool=\"github.get_repository\"",
  });
  return undefined;
}

/**
 * 位置参数 → 命名参数映射（实验开关控制）。
 *
 * parser 中性支持位置参数（key 为 undefined）；是否接受由编译后端决定：
 * - 无位置参数：原样返回 statement
 * - allowPositional=false：报 `POSITIONAL_ARG_NOT_ALLOWED`（模型摩擦探针）并返回 undefined
 * - allowPositional=true：按 `slots` 顺序映射为命名参数；越界报 `TOO_MANY_POSITIONAL_ARGS`，
 *   与同名命名参数冲突报 `duplicate_argument`
 */
function applyPositionalArgs(
  statement: ParsedStatement,
  slots: readonly string[],
  allowPositional: boolean,
  diagnostics: DslDiagnostic[],
): ParsedStatement | undefined {
  const positionalArgs = statement.args.filter((arg) => arg.key === undefined);
  if (positionalArgs.length === 0) return statement;

  if (!allowPositional) {
    diagnostics.push({
      line: positionalArgs[0]!.line,
      code: "POSITIONAL_ARG_NOT_ALLOWED",
      message: `${statement.callee} 不支持位置参数（语言要求 <key>=<value>）`,
      suggestion: `改写为：${slots.map((slot) => `${slot}=<值>`).join(", ")}`,
    });
    return undefined;
  }

  const args = [...statement.args];
  positionalArgs.forEach((arg, index) => {
    const slot = slots[index];
    if (!slot) {
      diagnostics.push({
        line: arg.line,
        code: "TOO_MANY_POSITIONAL_ARGS",
        message: `${statement.callee} 的位置参数过多（最多 ${slots.length} 个）`,
        suggestion: `位置参数顺序：${slots.join(", ")}`,
      });
      return;
    }
    if (args.some((existing) => existing.key === slot)) {
      diagnostics.push({
        line: arg.line,
        code: "duplicate_argument",
        message: `参数“${slot}”被位置参数与命名参数同时提供`,
        suggestion: "只保留一种写法",
      });
      return;
    }
    args.push({ line: arg.line, key: slot, value: arg.value });
  });
  // 越界/冲突的位置参数已报错，丢弃避免后续 unknown_parameter 重复报
  return { ...statement, args: args.filter((arg) => arg.key !== undefined) };
}

/** 从 call 表达式的参数中提取 binding 映射（`_.field` / `<param>.field` → 元素字段）。 */
function mapCallBindings(
  call: { callee?: string; args?: ParsedArg[] },
  prefix: string,
  tools: readonly ToolSpec[],
  diagnostics: DslDiagnostic[],
): Record<string, string> | undefined {
  const tool = tools.find((item) => item.id === call.callee);
  if (!tool) return undefined; // unknown_tool 由调用方统一处理
  const parameterKeys = new Set(tool.parameters.map((parameter) => parameter.key));
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

function buildMapNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source", "tool"], options.allowPositionalArgs ?? false, diagnostics);
  if (!effective) return undefined;
  const allow = options.allowMapBinding ?? "key";
  const source = refArg(effective, "source", defined, diagnostics);
  const bindingArg = effective.args.find((arg) => arg.key === "tool")?.value;

  // 形态探针（摩擦测量）：模型在当前臂写了其他绑定形态 → 专用诊断码，不自动 normalize
  if (bindingArg?.kind === "call" && allow !== "call") {
    diagnostics.push({
      line: statement.line,
      code: "MAP_BINDING_CALL_NOT_ALLOWED",
      message: `当前 map 绑定语法是 ${allow}，但你写了嵌套调用（${bindingArg.callee}(...)）`,
      suggestion: `把绑定改为当前语法要求的形态（见语法指南）`,
    });
    return undefined;
  }
  if (bindingArg?.kind === "lambda" && allow !== "lambda") {
    diagnostics.push({
      line: statement.line,
      code: "MAP_BINDING_LAMBDA_NOT_ALLOWED",
      message: `当前 map 绑定语法是 ${allow}，但你写了 lambda`,
      suggestion: `把绑定改为当前语法要求的形态（见语法指南）`,
    });
    return undefined;
  }
  if (allow === "call" && bindingArg?.kind !== "call") {
    diagnostics.push({
      line: statement.line,
      code: "MAP_BINDING_EXPECTED_CALL",
      message: "map 的第二个参数应是一个嵌套调用（如 github.get_repository(full_name=_.full_name)）",
      suggestion: "格式：map(<源>, <工具>(<参数>=_.<字段>), ...)",
    });
    return undefined;
  }
  if (allow === "lambda" && bindingArg?.kind !== "lambda") {
    diagnostics.push({
      line: statement.line,
      code: "MAP_BINDING_EXPECTED_LAMBDA",
      message: "map 的第二个参数应是一个 lambda（如 lambda repo: github.get_repository(full_name=repo.full_name)）",
      suggestion: "格式：map(<源>, lambda <参数名>: <工具>(<参数>=<参数名>.<字段>))",
    });
    return undefined;
  }

  // key= 元数据与 call/lambda 臂互斥（探针：模型在 B/C 臂仍写 key=）
  const keyArg = effective.args.find((arg) => arg.key === "key");
  if (keyArg && allow !== "key") {
    diagnostics.push({
      line: keyArg.line,
      code: "MAP_BINDING_KEY_NOT_ALLOWED",
      message: `当前语法用调用/lambda 表达绑定，不再接受 key= 元数据`,
      suggestion: "把 key= 改为调用内的参数映射（<参数名>=_.<字段>）",
    });
    return undefined;
  }

  // tool 与 bindings 解析
  const tools = options.tools ?? [];
  let toolId: string | undefined;
  let bindings: Record<string, string> | undefined;

  if (allow === "call" && bindingArg?.kind === "call") {
    toolId = bindingArg.callee;
    bindings = mapCallBindings(bindingArg, "_", tools, diagnostics);
  } else if (allow === "lambda" && bindingArg?.kind === "lambda") {
    const body = bindingArg.body;
    if (body?.kind !== "call") {
      diagnostics.push({
        line: statement.line,
        code: "syntax",
        message: "lambda 体必须是工具调用（如 github.get_repository(...)）",
        suggestion: "格式：lambda <参数名>: <工具>(<参数>=<参数名>.<字段>)",
      });
      return undefined;
    }
    toolId = body.callee;
    bindings = mapCallBindings(body, bindingArg.param ?? "_", tools, diagnostics);
  } else {
    // A 臂：字符串 tool + key= 字面量 → 单字段同名绑定
    toolId = toolArg(effective, diagnostics, options.allowCallableRef ?? false);
    const key = literalArg(effective, "key", diagnostics, { required: true });
    if (typeof key === "string") bindings = { [key]: key };
  }

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
    if (!["source", "tool", "key", "concurrency"].includes(arg.key)) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `map 不支持参数“${arg.key}”`,
        suggestion: "map 仅支持 source / tool / key / concurrency",
      });
    }
  }

  const toolRegistered = typeof toolId === "string" && tools.some((tool) => tool.id === toolId);
  if (!toolRegistered) {
    // tool 参数本身已报错（如裸标识符被拒绝）时，不叠加误导性的 unknown_tool
    if (typeof toolId === "string" || !diagnostics.some((item) => item.code === "EXPECTED_STRING_GOT_CALLABLE_REF")) {
      diagnostics.push({
        line: statement.line,
        code: "unknown_tool",
        message: `map 引用了未注册的工具：${String(toolId)}`,
        suggestion: "使用 registry 中已注册的工具 id（如 github.get_repository）",
      });
    }
    return undefined;
  }
  if (!bindings || Object.keys(bindings).length === 0) return undefined;
  if (!source) return undefined;

  return { id: statement.name, kind: "map", source, tool: toolId, bindings, concurrency };
}

function buildTakeNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source", "count"], options.allowPositionalArgs ?? false, diagnostics);
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

/**
 * filter：等值条件筛选（R4c closed operator）。
 * `filter(<source>, <字段>=<字面量>, ...)` — source 是位置参数（引用），
 * 其余命名参数为"字段 == 字面量"条件，元素需满足全部条件才保留。
 * 所有命名参数都是条件，无额外参数概念。
 */
function buildFilterNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source"], options.allowPositionalArgs ?? false, diagnostics);
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

/**
 * sort：按字段排序（R4c closed operator）。
 * `sort(<source>, key=<字段名>, desc=<true|false>)` — source 位置参数（引用），
 * key 必填字符串字面量，desc 可选布尔字面量（默认 false 升序）。
 */
function buildSortNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source"], options.allowPositionalArgs ?? false, diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);

  const key = literalArg(effective, "key", diagnostics, { required: true });
  let descValue = false;
  const desc = literalArg(effective, "desc", diagnostics);
  if (desc !== undefined && typeof desc !== "boolean") {
    diagnostics.push({
      line: statement.line,
      code: "config_type_mismatch",
      message: "sort 的参数“desc”期望布尔值",
      suggestion: "如 desc=true 或 desc=false",
    });
  } else if (desc !== undefined) {
    descValue = desc;
  }

  for (const arg of effective.args) {
    if (!["source", "key", "desc"].includes(arg.key ?? "")) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `sort 不支持参数“${arg.key}”`,
        suggestion: "sort 仅支持 source / key / desc",
      });
    }
  }
  if (key !== undefined && typeof key !== "string") {
    diagnostics.push({
      line: statement.line,
      code: "config_type_mismatch",
      message: "sort 的参数“key”应为字符串字段名",
      suggestion: '如 key="forks"',
    });
  }

  if (!source || typeof key !== "string") return undefined;
  return { id: statement.name, kind: "compute", op: "sort", source, args: { key, desc: descValue } };
}

function buildReturnNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["value"], options.allowPositionalArgs ?? false, diagnostics);
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

/**
 * compute（R4e）：元素级字段计算。
 * `compute(<source>, <输出字段>=<表达式字符串>, ...)` — source 是位置参数（引用），
 * 其余命名参数为"输出字段 = 受限算术表达式"（白名单：字段引用 + 数字 + `+ - * /` + 括号），
 * 表达式在编译期预解析（错误 → 编译诊断，repair 可修）。
 */
function buildComputeNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source"], options.allowPositionalArgs ?? false, diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);

  const args: Record<string, LiteralValue> = {};
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
  return { id: statement.name, kind: "compute", op: "compute", source, args };
}

/**
 * select（R4e）：谓词过滤（filter 的推广，支持比较）。
 * `select(<source>, "<比较谓词>")` — pred 是位置参数（字符串），顶层必须是比较表达式
 * （`> >= < <= == !=`），元素满足谓词才保留。
 */
function buildSelectNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = applyPositionalArgs(statement, ["source", "pred"], options.allowPositionalArgs ?? false, diagnostics);
  if (!effective) return undefined;
  const source = refArg(effective, "source", defined, diagnostics);
  const pred = literalArg(effective, "pred", diagnostics, { required: true });
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
  return { id: statement.name, kind: "compute", op: "select", source, args: { pred } };
}

/**
 * join（R4e）：多输入按 key 合并字段。
 * `join(<source1>, <source2>, ...≥2, key="<字段>")` — 位置参数全部是 source（数量不定），
 * sources[0] 为基准，其余按 key 匹配后附加字段（基准已有字段不覆盖）。
 */
function buildJoinNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
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

function buildToolNode(
  statement: ParsedStatement,
  tool: ToolSpec,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const parameterByKey = new Map(tool.parameters.map((parameter) => [parameter.key, parameter]));
  const args: Record<string, ValueExpr> = {};
  const seenArgs = new Set<string>();

  for (const arg of statement.args) {
    if (seenArgs.has(arg.key)) {
      diagnostics.push({
        line: arg.line,
        code: "duplicate_argument",
        message: `参数“${arg.key}”重复赋值`,
        suggestion: "每个参数只能赋值一次",
      });
      continue;
    }
    seenArgs.add(arg.key);

    const parameter = parameterByKey.get(arg.key);
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
      args[arg.key] = { kind: "ref", name };
      continue;
    }

    const literal = arg.value.literal ?? null;
    const normalized = normalizeLiteral(literal, parameter.kind);
    const error = literalKindError(normalized, arg.key, parameter.kind);
    if (error) {
      diagnostics.push({
        line: arg.line,
        code: "config_type_mismatch",
        message: error,
        suggestion: `检查字面量类型与声明 kind（${parameter.kind}）是否匹配`,
      });
      continue;
    }
    args[arg.key] = { kind: "literal", value: normalized };
  }

  return { id: statement.name, kind: "tool", tool: tool.id, args };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function buildNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  if (statement.callee === "map") return buildMapNode(statement, options, defined, diagnostics);
  if (statement.callee === "take") return buildTakeNode(statement, options, defined, diagnostics);
  if (statement.callee === "filter") return buildFilterNode(statement, options, defined, diagnostics);
  if (statement.callee === "sort") return buildSortNode(statement, options, defined, diagnostics);
  if (statement.callee === "compute") return buildComputeNode(statement, options, defined, diagnostics);
  if (statement.callee === "select") return buildSelectNode(statement, options, defined, diagnostics);
  if (statement.callee === "join") return buildJoinNode(statement, options, defined, diagnostics);
  if (statement.callee === "return") return buildReturnNode(statement, options, defined, diagnostics);

  const tool = (options.tools ?? []).find((item) => item.id === statement.callee);
  if (!tool) {
    diagnostics.push({
      line: statement.line,
      code: "unknown_tool",
      message: `未注册的工具或语言关键字：${statement.callee}`,
      suggestion: "使用已注册工具 id，或语言关键字 map / take / filter / sort / compute / select / join / return",
    });
    return undefined;
  }
  return buildToolNode(statement, tool, defined, diagnostics);
}

/**
 * Compile Agent Execution DSL source into an `ExecutionGraph`.
 *
 * 与 `compileCanvasDsl` 同构：硬错误（语法 / 未知工具 / 未定义引用 /
 * 重名 / 参数幻觉）一次性抛出，soft 语义留待后续阶段。产物通过
 * `ExecutionGraphSchema` 自校验后返回。
 */
export function compileExecutionDsl(
  source: string,
  options: CompileExecutionDslOptions = {},
): CompileExecutionDslResult {
  const { tokens, diagnostics: tokenDiagnostics } = tokenize(source);
  const parsed = new Parser(tokens).parse();
  const diagnostics = [...tokenDiagnostics, ...parsed.diagnostics];

  const defined = new Set<string>();
  const nodes: ExecutionNode[] = [];

  for (const statement of parsed.statements) {
    if (defined.has(statement.name)) {
      diagnostics.push({
        line: statement.line,
        code: "duplicate_name",
        message: `变量名“${statement.name}”重复定义`,
        suggestion: "变量名必须唯一",
      });
      continue;
    }
    const node = buildNode(statement, options, defined, diagnostics);
    if (!node) continue;
    nodes.push(node);
    defined.add(statement.name);
  }

  if (diagnostics.length > 0) throw new ExecutionDslCompileError(diagnostics);

  nodes.sort(compareNodes);
  const graph: ExecutionGraph = { schema_version: "1", nodes };

  if (!Value.Check(ExecutionGraphSchema, graph)) {
    const error = Value.Errors(ExecutionGraphSchema, graph)[0];
    diagnostics.push({
      line: 0,
      code: "schema_invalid",
      message: error ? `编译产物未通过 ExecutionIR schema 校验：${error.message}` : "编译产物未通过 ExecutionIR schema 校验",
      suggestion: "这是编译器的内部校验失败；请重试或调整节点数量",
    });
    throw new ExecutionDslCompileError(diagnostics);
  }

  return { graph, diagnostics };
}
