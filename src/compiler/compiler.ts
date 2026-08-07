import { Value } from "typebox/value";

import type { LiteralValue, ParsedStatement } from "../language/ast.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import { Parser } from "../language/parser.js";
import { tokenize } from "../language/tokenizer.js";
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

function buildMapNode(
  statement: ParsedStatement,
  options: CompileExecutionDslOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const source = refArg(statement, "source", defined, diagnostics);
  const toolId = toolArg(statement, diagnostics, options.allowCallableRef ?? false);
  const key = literalArg(statement, "key", diagnostics, { required: true });

  let concurrency = 5;
  const concurrencyArg = literalArg(statement, "concurrency", diagnostics);
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

  for (const arg of statement.args) {
    if (!["source", "tool", "key", "concurrency"].includes(arg.key)) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `map 不支持参数“${arg.key}”`,
        suggestion: "map 仅支持 source / tool / key / concurrency",
      });
    }
  }

  const toolRegistered = typeof toolId === "string" && (options.tools?.some((tool) => tool.id === toolId) ?? false);
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
  if (typeof key !== "string") return undefined;
  if (!source) return undefined;

  return { id: statement.name, kind: "map", source, tool: toolId, key, concurrency };
}

function buildTakeNode(
  statement: ParsedStatement,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const source = refArg(statement, "source", defined, diagnostics);
  const count = literalArg(statement, "count", diagnostics, { required: true });
  if (count !== undefined) {
    const error = literalKindError(count, "count", "int");
    if (error) {
      diagnostics.push({ line: statement.line, code: "config_type_mismatch", message: error, suggestion: "count 应为整数" });
      return undefined;
    }
  }
  for (const arg of statement.args) {
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

function buildReturnNode(
  statement: ParsedStatement,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const value = refArg(statement, "value", defined, diagnostics);
  for (const arg of statement.args) {
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
  if (statement.callee === "take") return buildTakeNode(statement, defined, diagnostics);
  if (statement.callee === "return") return buildReturnNode(statement, defined, diagnostics);

  const tool = (options.tools ?? []).find((item) => item.id === statement.callee);
  if (!tool) {
    diagnostics.push({
      line: statement.line,
      code: "unknown_tool",
      message: `未注册的工具或语言关键字：${statement.callee}`,
      suggestion: "使用已注册工具 id，或语言关键字 map / take / return",
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
