import { Value } from "typebox/value";

import type { ParsedStatement } from "../language/ast.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import { Parser } from "../language/parser.js";
import { tokenize } from "../language/tokenizer.js";
import type { ToolCatalog } from "../tools/registry.js";
import {
  ExecutionGraphSchema,
  type ExecutionGraph,
  type ExecutionNode,
} from "./ir.js";
import { compareNodes, nodeElementSchema, suggestToolNames, type ElementSchema } from "./helpers.js";
import { buildToolNode, validateMapBindings } from "./toolCall.js";
import { buildComputeNode } from "./builtins/compute.js";
import { buildConcatNode } from "./builtins/concat.js";
import { buildFilterNode } from "./builtins/filter.js";
import { buildJoinNode } from "./builtins/join.js";
import { buildMapNode } from "./builtins/map.js";
import { buildReturnNode } from "./builtins/return.js";
import { buildSelectNode } from "./builtins/select.js";
import { buildSortNode } from "./builtins/sort.js";
import { buildTakeNode } from "./builtins/take.js";

/**
 * Agent Execution DSL 编译器（canonical 入口，REQ-7 冻结语法）。
 *
 * 语言前端复用 `src/language/`（tokenizer / parser），本文件实现语义层：
 * - tool callee（registry 中的工具）→ `ToolNode`，参数校验
 *   （unknown_parameter / config_type_mismatch，LLM 幻觉参数名在编译期拒绝）；
 * - `map` / `take` / `filter` / `sort` / `compute` / `select` / `merge_by_key` / `concat` / `return`
 *   → 语言级 construct（`MapNode` / `ComputeNode` / `JoinNode` / `ConcatNode` / `ReturnNode`），
 *   `source` / `value` 必须是变量引用（引用即数据流边）；
 *   `join` 是 `merge_by_key` 的遗留别名（R1–R4 冻结产物兼容，编译产物同一节点）；
 * - 未注册 callee → `unknown_tool`。
 *
 * canonical 语法冻结：map 的第二个参数必须是嵌套工具调用绑定形态
 * （`map(xs, tool(field=_.field))`，字符串 id 会被拒绝）、
 * 位置参数永远允许。R1–R3 变体（key= 元数据 / lambda /
 * callable-ref 裸标识符）见 `src/experiments/languageVariants/legacyCompile.ts`。
 *
 * 输出确定性：同一段 DSL 永远编译出同一张图，并做 schema 自校验。
 */

export interface CompileExecutionDslOptions {
  tools?: ToolCatalog;
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
  if (statement.callee === "merge_by_key" || statement.callee === "join") {
    return buildJoinNode(statement, options, defined, diagnostics);
  }
  if (statement.callee === "concat") return buildConcatNode(statement, options, defined, diagnostics);
  if (statement.callee === "return") return buildReturnNode(statement, options, defined, diagnostics);

  const tool = options.tools?.get(statement.callee);
  if (!tool) {
    const suggestion = suggestToolNames(options.tools, statement.callee);
    diagnostics.push({
      line: statement.line,
      code: "unknown_tool",
      message: `未注册的工具或语言关键字：${statement.callee}`,
      suggestion:
        suggestion ??
        "使用已注册工具 id，或语言关键字 map / take / filter / sort / compute / select / merge_by_key / concat / return",
      tool: statement.callee,
      suggestions: suggestion ? [suggestion] : [],
    });
    return undefined;
  }
  return buildToolNode(statement, tool, defined, diagnostics);
}

/**
 * Compile Agent Execution DSL source into an `ExecutionGraph`.
 *
 * 硬错误（语法 / 未知工具 / 未定义引用 / 重名 / 参数幻觉）一次性抛出，
 * soft 语义留待后续阶段。产物通过 `ExecutionGraphSchema` 自校验后返回。
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
  // REQ-5：语句名 → 元素 schema 的符号表（map 绑定字段校验的事实源）
  const symbols = new Map<string, ElementSchema | undefined>();

  for (const statement of parsed.statements) {
    if (defined.has(statement.name)) {
      // return 是语言关键字（parser 中 name 占位为 "return"），第二条 return 命中重名检查时
      // 报专门诊断，而不是含糊的 duplicate_name。
      if (statement.callee === "return") {
        diagnostics.push({
          line: statement.line,
          code: "duplicate_return",
          message: "程序包含多条 return 语句，只允许一条 terminal return",
          suggestion: "删除多余的 return，保留最终输出那一条",
        });
      } else {
        diagnostics.push({
          line: statement.line,
          code: "duplicate_name",
          message: `变量名“${statement.name}”重复定义`,
          suggestion: "变量名必须唯一",
        });
      }
      continue;
    }
    const node = buildNode(statement, options, defined, diagnostics);
    if (!node) continue;
    if (node.kind === "map") {
      validateMapBindings(node, options.tools, symbols, diagnostics, statement.line);
    }
    nodes.push(node);
    defined.add(statement.name);
    symbols.set(statement.name, nodeElementSchema(node, options.tools, symbols));
  }

  // 完整性校验：JIT 程序必须以恰好一条 terminal return 结束。
  // 统计已构建成节点的 return 数（为 0 含空程序）；仅在无其它编译错误时补报
  // missing_return——unknown_tool 等已 throw 时不再叠加噪声。
  const returnCount = nodes.filter((node) => node.kind === "return").length;
  if (returnCount === 0 && diagnostics.length === 0) {
    const lastStatement = parsed.statements[parsed.statements.length - 1];
    diagnostics.push({
      line: lastStatement?.line ?? 0,
      code: "missing_return",
      message: "程序缺少 return 语句：JIT 程序必须以一条 terminal return 结束",
      suggestion: "在最后追加一行：return <最终结果变量>",
    });
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
