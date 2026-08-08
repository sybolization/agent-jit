import { Value } from "typebox/value";

import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import { Parser } from "../../language/parser.js";
import { tokenize } from "../../language/tokenizer.js";
import type { ToolDefinition } from "../../tools/definition.js";
import { ExecutionGraphSchema, type ExecutionGraph, type ExecutionNode } from "../../compiler/ir.js";
import { compareNodes, literalArg, literalKindError, pushMissing, refArg } from "../../compiler/helpers.js";
import { buildToolNode, mapCallBindings } from "../../compiler/toolCall.js";
import { buildComputeNode } from "../../compiler/builtins/compute.js";
import { buildFilterNode } from "../../compiler/builtins/filter.js";
import { buildJoinNode } from "../../compiler/builtins/join.js";
import { buildReturnNode } from "../../compiler/builtins/return.js";
import { buildSelectNode } from "../../compiler/builtins/select.js";
import { buildSortNode } from "../../compiler/builtins/sort.js";
import { buildTakeNode } from "../../compiler/builtins/take.js";
import { ExecutionDslCompileError, type CompileExecutionDslResult } from "../../compiler/compile.js";

/**
 * Legacy Execution DSL 编译器（REQ-7：R1–R3 变体）。
 *
 * canonical 语法冻结后，三个语言实验变体移入本文件：
 * - key= 元数据绑定（A 臂）；
 * - callable-ref 裸标识符 tool 参数（allowCallableRef）；
 * - map 绑定三臂（allowMapBinding: "key" | "call" | "lambda"）。
 *
 * 保留原编译器全部诊断码与 IR 行为（三臂探针 MAP_BINDING_CALL_NOT_ALLOWED /
 * MAP_BINDING_LAMBDA_NOT_ALLOWED / MAP_BINDING_EXPECTED_CALL /
 * MAP_BINDING_EXPECTED_LAMBDA / MAP_BINDING_KEY_NOT_ALLOWED /
 * MAP_BINDING_REF_INVALID，A 臂 toolArg 的 EXPECTED_STRING_GOT_CALLABLE_REF）。
 * 非 map 构造复用 canonical builtins 与 toolCall（位置参数在原实验中恒开启，
 * canonical builtins 的行为与之完全一致）；legacy 循环不做符号表/字段校验
 * （与原实现行为一致）。
 *
 * 仅由 `src/experiments/dslGenerationExperiment.ts` 与 R3 变体测试使用。
 */

export interface LegacyCompileOptions {
  tools?: readonly ToolDefinition[];

  /** R2 实验：允许 map 的 tool 参数以裸标识符（callable reference）书写。默认 false。 */
  allowCallableRef?: boolean;

  /** R3 实验：map 的 element→argument 绑定表达方式。默认 "key"。 */
  allowMapBinding?: "key" | "call" | "lambda";
}

/**
 * 位置参数 → 命名参数映射（legacy 原样：实验开关控制）。
 *
 * parser 中性支持位置参数（key 为 undefined）；是否接受由编译后端决定：
 * - 无位置参数：原样返回 statement
 * - allowPositional=false：报 `POSITIONAL_ARG_NOT_ALLOWED`（模型摩擦探针）并返回 undefined
 * - allowPositional=true：按 `slots` 顺序映射为命名参数；越界报 `TOO_MANY_POSITIONAL_ARGS`，
 *   与同名命名参数冲突报 `duplicate_argument`
 */
function legacyApplyPositionalArgs(
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

/**
 * 取 map 的 tool 参数：接受双引号字符串字面量；
 * 若 allowCallableRef 开启，也接受裸标识符（callable reference，如 github.get_repository）。
 * 关闭时裸标识符报 EXPECTED_STRING_GOT_CALLABLE_REF（模型摩擦探针）。
 */
function legacyToolArg(
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

/** legacy 三臂 map（key= / 调用 / lambda）——逐字保留原 buildMapNode 逻辑与诊断码。 */
function legacyBuildMapNode(
  statement: ParsedStatement,
  options: LegacyCompileOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  const effective = legacyApplyPositionalArgs(statement, ["source", "tool"], true, diagnostics);
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
    toolId = legacyToolArg(effective, diagnostics, options.allowCallableRef ?? false);
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
    if (!["source", "tool", "key", "concurrency"].includes(arg.key ?? "")) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `map 不支持参数“${arg.key}”`,
        suggestion: "map 仅支持 source / tool / key / concurrency",
      });
    }
  }

  if (typeof toolId !== "string") {
    // tool 参数本身已报错（如裸标识符被拒绝）时，不叠加误导性的 unknown_tool
    if (!diagnostics.some((item) => item.code === "EXPECTED_STRING_GOT_CALLABLE_REF")) {
      diagnostics.push({
        line: statement.line,
        code: "unknown_tool",
        message: `map 引用了未注册的工具：${String(toolId)}`,
        suggestion: "使用 registry 中已注册的工具 id（如 github.get_repository）",
      });
    }
    return undefined;
  }
  const toolRegistered = tools.some((tool) => tool.id === toolId);
  if (!toolRegistered) {
    diagnostics.push({
      line: statement.line,
      code: "unknown_tool",
      message: `map 引用了未注册的工具：${toolId}`,
      suggestion: "使用 registry 中已注册的工具 id（如 github.get_repository）",
    });
    return undefined;
  }
  if (!bindings || Object.keys(bindings).length === 0) return undefined;
  if (!source) return undefined;

  return { id: statement.name, kind: "map", source, tool: toolId, bindings, concurrency };
}

function legacyBuildNode(
  statement: ParsedStatement,
  options: LegacyCompileOptions,
  defined: ReadonlySet<string>,
  diagnostics: DslDiagnostic[],
): ExecutionNode | undefined {
  if (statement.callee === "map") return legacyBuildMapNode(statement, options, defined, diagnostics);
  if (statement.callee === "take") return buildTakeNode(statement, { tools: options.tools }, defined, diagnostics);
  if (statement.callee === "filter") return buildFilterNode(statement, { tools: options.tools }, defined, diagnostics);
  if (statement.callee === "sort") return buildSortNode(statement, { tools: options.tools }, defined, diagnostics);
  if (statement.callee === "compute") return buildComputeNode(statement, { tools: options.tools }, defined, diagnostics);
  if (statement.callee === "select") return buildSelectNode(statement, { tools: options.tools }, defined, diagnostics);
  if (statement.callee === "join") return buildJoinNode(statement, { tools: options.tools }, defined, diagnostics);
  if (statement.callee === "return") return buildReturnNode(statement, { tools: options.tools }, defined, diagnostics);

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
 * Compile Agent Execution DSL source（legacy 三臂变体）into an `ExecutionGraph`。
 * 编译错误抛 `ExecutionDslCompileError`；行为与原 compiler.ts 一致。
 */
export function compileExecutionDslLegacy(
  source: string,
  options: LegacyCompileOptions = {},
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
    const node = legacyBuildNode(statement, options, defined, diagnostics);
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
