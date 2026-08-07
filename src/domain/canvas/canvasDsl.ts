import { Value } from "typebox/value";

import type { CanvasWorkflowTool } from "../../contracts/canvas.js";
import type {
  SemanticCanvasGraphV1,
  SemanticCanvasInput,
  SemanticCanvasInputPort,
  SemanticCanvasNode,
  SemanticCanvasOutput,
} from "../../contracts/semanticCanvas.js";
import { SemanticCanvasGraphV1Schema } from "../../contracts/semanticCanvas.js";

/**
 * Canvas DSL: a small, closed, deterministic authoring language for the
 * Workbench semantic canvas. The agent writes code-shaped text; the compiler
 * turns it into the exact `SemanticCanvasGraphV1` the Harness already runs.
 *
 * Design constraints (see todo/canvas-agent-code-dsl-plan.md):
 * - Pure DAG expressions only: assignment + function call + literal/reference
 *   arguments. No control flow sugar in this first version.
 * - Closed grammar, deterministic output (same source -> same graph).
 * - Runtime is untouched: the compiler is a new input path beside
 *   `semanticGraph.ts`, producing the same contract.
 *
 * Grammar (newline separated statements):
 *   <statement> := <name> "=" <callee> "(" <args>? ")"
 *   <args>      := <arg> ("," <arg>)*
 *   <arg>       := <key> "=" <value>
 *   <value>     := string | number | boolean | null | array | <name-reference>
 *
 * Callee is either a registered workflow id (from the workflow catalog) or a
 * builtin node kind (`text`, `asset`). A bare identifier in value position is
 * a reference to an earlier statement's name and becomes a `node_output`
 * binding on the target's `inputs`.
 */

export type CanvasDslDiagnosticCode =
  | "syntax"
  | "unknown_tool"
  | "undefined_reference"
  | "duplicate_name"
  | "duplicate_argument"
  | "invalid_reference"
  | "invalid_key"
  | "unsupported_literal"
  | "type_mismatch"
  | "schema_invalid"
  | "incomplete_input"
  | "unknown_parameter"
  | "config_type_mismatch";

export interface CanvasDslDiagnostic {
  line: number;
  code: CanvasDslDiagnosticCode;
  message: string;
  suggestion?: string;
}

export class CanvasDslCompileError extends Error {
  readonly diagnostics: readonly CanvasDslDiagnostic[];

  constructor(diagnostics: readonly CanvasDslDiagnostic[]) {
    super(diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`).join("\n"));
    this.name = "CanvasDslCompileError";
    this.diagnostics = diagnostics;
  }
}

export interface CompileCanvasDslOptions {
  workflowTools?: readonly CanvasWorkflowTool[];
  canvasVersion?: string | null;
}

export interface CompileCanvasDslResult {
  graph: SemanticCanvasGraphV1;
  diagnostics: readonly CanvasDslDiagnostic[];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "ident" | "number" | "string" | "symbol" | "newline" | "eof";

interface Token {
  type: TokenType;
  value: string;
  line: number;
}

interface TokenizeResult {
  tokens: Token[];
  diagnostics: CanvasDslDiagnostic[];
}

function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  const diagnostics: CanvasDslDiagnostic[] = [];
  let i = 0;
  let line = 1;

  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "\n") {
      tokens.push({ type: "newline", value: "\n", line });
      i += 1;
      line += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && (source[i] as string) !== "\n") i += 1;
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < source.length) {
        const current = source[j] as string;
        if (current === '"') {
          closed = true;
          break;
        }
        if (current === "\n") break;
        if (current === "\\") {
          const escaped = source[j + 1];
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else if (escaped === '"') value += '"';
          else if (escaped === "\\") value += "\\";
          else value += escaped ?? "";
          j += 2;
          continue;
        }
        value += current;
        j += 1;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          code: "syntax",
          message: `未闭合的字符串：${ch}${value}`.slice(0, 200),
          suggestion: "用双引号包裹字符串，并确保在换行前闭合",
        });
        i = j + 1;
        continue;
      }
      tokens.push({ type: "string", value, line: startLine });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const startLine = line;
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ type: "ident", value: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const startLine = line;
      let j = i;
      if ((source[j] as string) === "-") j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if ((source[j] as string) === "." && /[0-9]/.test(source[j + 1] ?? "")) {
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ type: "number", value: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if ("=(),[]".includes(ch)) {
      tokens.push({ type: "symbol", value: ch, line });
      i += 1;
      continue;
    }
    diagnostics.push({
      line,
      code: "syntax",
      message: `无法识别的字符：${ch}`,
      suggestion: "只允许标识符、数字、双引号字符串、注释（#）和符号 = ( ) , [ ]",
    });
    i += 1;
  }
  tokens.push({ type: "eof", value: "", line });
  return { tokens, diagnostics };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type LiteralValue = null | boolean | number | string | LiteralValue[];

interface ParsedValue {
  line: number;
  kind: "literal" | "ref";
  literal?: LiteralValue;
  name?: string;
}

interface ParsedArg {
  line: number;
  key: string;
  value: ParsedValue;
}

interface ParsedStatement {
  line: number;
  name: string;
  callee: string;
  args: ParsedArg[];
}

interface ParseResult {
  statements: ParsedStatement[];
  diagnostics: CanvasDslDiagnostic[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly definedNodes = new Set<string>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParseResult {
    const statements: ParsedStatement[] = [];
    const diagnostics: CanvasDslDiagnostic[] = [];
    while (this.peek()?.type !== "eof") {
      if (this.peek()?.type === "newline") {
        this.pos += 1;
        continue;
      }
      const statement = this.parseStatement(diagnostics);
      if (statement) {
        statements.push(statement);
        this.definedNodes.add(statement.name);
      }
    }
    return { statements, diagnostics };
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.pos];
    if (token?.type !== "eof") this.pos += 1;
    return token;
  }

  private skipToNewline(): void {
    while (this.peek()?.type !== "newline" && this.peek()?.type !== "eof") this.pos += 1;
  }

  private parseStatement(diagnostics: CanvasDslDiagnostic[]): ParsedStatement | undefined {
    const startLine = this.peek()?.line ?? 0;

    const nameToken = this.next();
    if (nameToken?.type !== "ident") {
      diagnostics.push({
        line: nameToken?.line ?? startLine,
        code: "syntax",
        message: "语句必须以节点名称开头",
        suggestion: "格式：<名称> = <工作流或内置节点>(<参数>=<值>)",
      });
      this.skipToNewline();
      return undefined;
    }

    const equals = this.next();
    if (equals?.type !== "symbol" || equals.value !== "=") {
      diagnostics.push({
        line: equals?.line ?? startLine,
        code: "syntax",
        message: `“${nameToken.value}”后缺少等号`,
        suggestion: "格式：<名称> = <工作流>(<参数>=<值>)",
      });
      this.skipToNewline();
      return undefined;
    }

    const calleeToken = this.next();
    if (calleeToken?.type !== "ident") {
      diagnostics.push({
        line: calleeToken?.line ?? startLine,
        code: "syntax",
        message: `“${nameToken.value} =”后缺少工作流或节点类型`,
        suggestion:
          calleeToken?.type === "string"
            ? "赋值右边必须是工作流 id 或内置节点（text、asset）。若该行是某工作流的参数，说明你用了逐行写参数的方式；DSL 要求单行：名称 = 工作流(参数=值, …)"
            : "使用已注册工作流 id 或内置节点（text、asset）",
      });
      this.skipToNewline();
      return undefined;
    }

    const open = this.next();
    if (open?.type !== "symbol" || open.value !== "(") {
      diagnostics.push({
        line: open?.line ?? startLine,
        code: "syntax",
        message: `“${calleeToken.value}”后缺少左括号`,
        suggestion: this.definedNodes.has(calleeToken.value)
          ? `“${calleeToken.value}”是先前定义的节点，不能作为工作流调用；引用它的输出请写成：名称 = 工作流(输入名 = ${calleeToken.value})`
          : "DSL 要求单行调用：名称 = 工作流(参数=值, …)，参数不要换行缩进",
      });
      this.skipToNewline();
      return undefined;
    }

    const args: ParsedArg[] = [];
    if (this.peek()?.type === "symbol" && this.peek()?.value === ")") {
      this.pos += 1;
    } else {
      for (;;) {
        const arg = this.parseArg(diagnostics);
        if (!arg) {
          this.skipToNewline();
          return undefined;
        }
        args.push(arg);
        const separator = this.next();
        if (separator?.type === "symbol" && separator.value === ")") break;
        if (separator?.type === "symbol" && separator.value === ",") continue;
        diagnostics.push({
          line: separator?.line ?? startLine,
          code: "syntax",
          message: "参数列表缺少逗号或右括号",
          suggestion: "格式：<key>=<value>，参数之间用逗号分隔",
        });
        this.skipToNewline();
        return undefined;
      }
    }

    const ending = this.peek();
    if (ending?.type === "newline" || ending?.type === "eof") {
      if (ending.type === "newline") this.pos += 1;
    } else {
      diagnostics.push({
        line: ending?.line ?? startLine,
        code: "syntax",
        message: "一条语句必须独占一行",
        suggestion: "每条 <名称> = <工作流>(...) 单独成行",
      });
      this.skipToNewline();
      return undefined;
    }

    return { line: startLine, name: nameToken.value, callee: calleeToken.value, args };
  }

  private parseArg(diagnostics: CanvasDslDiagnostic[]): ParsedArg | undefined {
    const startLine = this.peek()?.line ?? 0;
    const keyToken = this.next();
    if (keyToken?.type !== "ident") {
      diagnostics.push({
        line: startLine,
        code: "syntax",
        message: "参数必须以名称开头",
        suggestion: "格式：<key>=<value>。参数之间用逗号分隔，且全部写在同一行的括号内，不要用缩进块、换行或 { }",
      });
      this.skipToNewline();
      return undefined;
    }
    const equals = this.next();
    if (equals?.type !== "symbol" || equals.value !== "=") {
      diagnostics.push({
        line: equals?.line ?? startLine,
        code: "syntax",
        message: `参数“${keyToken.value}”后缺少等号`,
        suggestion: "格式：<key>=<value>",
      });
      this.skipToNewline();
      return undefined;
    }
    const value = this.parseValue(diagnostics);
    if (!value) return undefined;
    return { line: startLine, key: keyToken.value, value };
  }

  private parseValue(diagnostics: CanvasDslDiagnostic[]): ParsedValue | undefined {
    const token = this.peek();
    if (!token) return undefined;
    if (token.type === "string") {
      this.pos += 1;
      return { line: token.line, kind: "literal", literal: token.value };
    }
    if (token.type === "number") {
      this.pos += 1;
      return { line: token.line, kind: "literal", literal: Number(token.value) };
    }
    if (token.type === "ident") {
      this.pos += 1;
      if (token.value === "true") return { line: token.line, kind: "literal", literal: true };
      if (token.value === "false") return { line: token.line, kind: "literal", literal: false };
      if (token.value === "null") return { line: token.line, kind: "literal", literal: null };
      return { line: token.line, kind: "ref", name: token.value };
    }
    if (token.type === "symbol" && token.value === "[") {
      this.pos += 1;
      const items: LiteralValue[] = [];
      for (;;) {
        const itemToken = this.peek();
        if (!itemToken) break;
        if (itemToken.type === "symbol" && itemToken.value === "]") {
          this.pos += 1;
          break;
        }
        const item = this.parseValue(diagnostics);
        if (!item) break;
        if (item.kind === "ref") {
          diagnostics.push({
            line: item.line,
            code: "syntax",
            message: "数组内不能引用节点",
            suggestion: '数组只接受字面量：["a", "b"]',
          });
        } else {
          items.push(item.literal ?? null);
        }
        const separator = this.next();
        if (separator?.type === "symbol" && separator.value === "]") break;
        if (separator?.type === "symbol" && separator.value === ",") continue;
        diagnostics.push({
          line: separator?.line ?? token.line,
          code: "syntax",
          message: "数组缺少逗号或右括号",
          suggestion: '格式：["a", "b"]',
        });
        this.skipToNewline();
        return undefined;
      }
      return { line: token.line, kind: "literal", literal: items };
    }
    diagnostics.push({
      line: token.line,
      code: "syntax",
      message: "参数值必须是字符串、数字、布尔、null、数组或前面已定义节点的名称",
      suggestion: '引用节点：reference_image=img；字面量：prompt="一只猫"',
    });
    this.pos += 1;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Semantic compilation
// ---------------------------------------------------------------------------

const DATA_URI = /^data:[^,]+,/i;
const URL_PREFIX = /^(?:https?|blob|file):/i;
const FORBIDDEN_KEY =
  /(?:^|[_-])(?:position|viewport|edges?|handles?|source[_-]?handle|target[_-]?handle|links?|groups?)(?:$|[_-])|comfy|class[_-]?type|widgets?[_-]?values|workflow[_-]?json/i;
const VOLATILE_KEY =
  /^(?:status|state|job|job[_-]?id|runtime.*|running|loading|progress|queue|error.*|failure.*|exception.*|preview.*|thumbnail.*|cache.*|cached.*|generated.*|execution.*|prompt[_-]?id|callback.*|base64.*|data[_-]?uri.*|currentJobId|currentVersionId|outputAssetId|outputVideoId|outputId|output[_-]?(?:asset|video|id)|result(?:Id)?|result[_-]?id|agent.*|on[A-Z].*|errorStack|nodeVersionId|outputSignature|outputProvenance|startedAt|completedAt)$/i;

interface ArgSpec {
  reference: boolean;
  required?: boolean;
  hasDefault: boolean;
  kind?: string;
  options?: readonly unknown[];
}

function workflowArgSpecs(tool: CanvasWorkflowTool | undefined): Map<string, ArgSpec> {
  const specs = new Map<string, ArgSpec>();
  const defaults = tool?.defaults ?? {};
  for (const reference of tool?.references ?? []) {
    const key = reference.parameterKey;
    if (!key) continue;
    specs.set(key, {
      reference: true,
      required: reference.required === true,
      hasDefault: false,
      ...(reference.kind !== undefined ? { kind: reference.kind } : {}),
    });
  }
  for (const parameter of tool?.parameters ?? []) {
    const key = parameter.key;
    if (!key || specs.has(key)) continue;
    specs.set(key, {
      reference: false,
      required: parameter.required === true,
      hasDefault: parameter.default !== undefined || defaults[key] !== undefined,
      ...(parameter.kind !== undefined ? { kind: parameter.kind } : {}),
      ...(parameter.options !== undefined ? { options: parameter.options } : {}),
    });
  }
  return specs;
}

function isInvalidKey(key: string): "forbidden" | "volatile" | "ok" {
  if (FORBIDDEN_KEY.test(key) || /comfy/i.test(key)) return "forbidden";
  if (VOLATILE_KEY.test(key)) return "volatile";
  return "ok";
}

function sanitizeLiteral(
  value: LiteralValue,
  diagnostics: CanvasDslDiagnostic[],
  line: number,
): LiteralValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (DATA_URI.test(value) || URL_PREFIX.test(value)) {
      diagnostics.push({
        line,
        code: "unsupported_literal",
        message: "字符串参数不支持 data URI 或 URL",
        suggestion: "素材/URL 应通过素材引用或引用已定义节点传入",
      });
      return undefined;
    }
    return value;
  }
  const items: LiteralValue[] = [];
  for (const item of value) {
    const safe = sanitizeLiteral(item, diagnostics, line);
    if (safe !== undefined) items.push(safe);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Config literal validation — mirrors the Harness normalize/validate pipeline
// (semanticTransaction.ts normalizeWorkflowNode → normalizeParameterValue +
// validateParameterValue) so the compiler rejects exactly what the real
// apply_subgraph_transaction would reject.
// ---------------------------------------------------------------------------

const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function normalizeLiteralValue(value: LiteralValue, kind: string): LiteralValue {
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

function literalKindError(
  value: LiteralValue,
  parameterKey: string,
  kind: string,
  options: readonly unknown[] | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = kind.toLowerCase();
  if (normalized === "int" || normalized === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `参数“${parameterKey}”期望整数，得到 ${typeof value}`;
    }
  } else if (normalized === "float" || normalized === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `参数“${parameterKey}”期望数字，得到 ${typeof value}`;
    }
  } else if (normalized === "bool" || normalized === "boolean") {
    if (typeof value !== "boolean") return `参数“${parameterKey}”期望布尔值，得到 ${typeof value}`;
  } else if (normalized === "file") {
    if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) {
      return `参数“${parameterKey}”期望素材 ID（仅字母、数字、下划线、连字符）`;
    }
  } else if (normalized === "combo" || (options !== undefined && options.length > 0)) {
    const allowed = new Set(
      (options ?? []).map((option) =>
        option !== null && typeof option === "object" && "value" in option
          ? String((option as { value: unknown }).value)
          : String(option),
      ),
    );
    if (!allowed.has(String(value))) {
      return `参数“${parameterKey}”期望枚举 [${[...allowed].join(", ")}]，得到 “${String(value)}”`;
    }
  } else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return `参数“${parameterKey}”期望字符串/数字/布尔，得到 ${Array.isArray(value) ? "数组" : "对象"}`;
  }
  return null;
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

function compareNodes(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function completeReadiness() {
  return { status: "complete" as const, missing_inputs: [], invalid_inputs: [] };
}

function outputForKind(kind: string): SemanticCanvasOutput {
  return { name: kind, type: kind };
}

function buildNode(
  statement: ParsedStatement,
  options: CompileCanvasDslOptions,
  defined: ReadonlyMap<string, SemanticCanvasNode>,
  diagnostics: CanvasDslDiagnostic[],
): SemanticCanvasNode | undefined {
  const tools = new Map((options.workflowTools ?? []).map((tool) => [tool.id, tool]));
  const tool = tools.get(statement.callee);
  const line = statement.line;

  if (!tool && statement.callee !== "text" && statement.callee !== "asset") {
    diagnostics.push({
      line,
      code: "unknown_tool",
      message: `未注册的工作流或内置节点：${statement.callee}`,
      suggestion: "使用 read 到的已注册工作流 id，或内置节点 text / asset",
    });
    return undefined;
  }

  const specs = tool ? workflowArgSpecs(tool) : new Map<string, ArgSpec>();
  const inputs: Record<string, SemanticCanvasInput> = {};
  const config: Record<string, LiteralValue> = {};
  const seenArgs = new Set<string>();
  const unresolvedRefs: string[] = [];

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

    const invalid = isInvalidKey(arg.key);
    if (invalid !== "ok") {
      diagnostics.push({
        line: arg.line,
        code: "invalid_key",
        message: `参数名“${arg.key}”是${invalid === "forbidden" ? "兼容层/ComfyUI 字段" : "运行时易变字段"}，不能作为语义参数`,
        suggestion: "换一个业务参数名",
      });
      continue;
    }

    const spec = specs.get(arg.key);
    const textBuiltin = statement.callee === "text";
    if (spec?.reference) {
      if (arg.value.kind === "ref") {
        const sourceName = arg.value.name ?? "";
        const source = defined.get(sourceName);
        if (!source) {
          unresolvedRefs.push(arg.key);
          continue;
        }
        // M2: type compatibility — the bound node's output type must match the
        // reference port's expected kind (image/audio/video). Otherwise an
        // image node could silently feed a video port and only fail later in
        // the real harness validation chain.
        const expectedKind = spec.kind;
        const sourceKind = source.outputs[0]?.type;
        if (expectedKind && sourceKind && sourceKind !== expectedKind) {
          diagnostics.push({
            line: arg.line,
            code: "type_mismatch",
            message: `参数“${arg.key}”期望 ${expectedKind} 类型输入，但节点“${sourceName}”输出的是 ${sourceKind}`,
            suggestion: `引用输出类型为 ${expectedKind} 的节点（如 ${expectedKind} 类工作流或 asset 节点）`,
          });
          continue;
        }
        const output = source.outputs[0]?.name ?? "output";
        inputs[arg.key] = { kind: "node_output", node_id: source.id, output };
      } else {
        const literal = sanitizeLiteral(arg.value.literal ?? null, diagnostics, arg.line);
        if (literal !== undefined) inputs[arg.key] = { kind: "literal", value: literal };
      }
      continue;
    }

    if (arg.value.kind === "ref") {
      diagnostics.push({
        line: arg.line,
        code: "invalid_reference",
        message: `参数“${arg.key}”不是引用型输入（${statement.callee} 的参数），不能绑定节点`,
        suggestion: "该参数应传字面量；只有引用型输入（reference）可以绑定节点",
      });
      continue;
    }
    const literal = sanitizeLiteral(arg.value.literal ?? null, diagnostics, arg.line);
    if (literal === undefined) continue;
    if (textBuiltin) {
      inputs[arg.key] = { kind: "literal", value: literal };
      continue;
    }
    // M3: mirror the Harness config validation. text/asset builtins (tool ===
    // undefined) keep free-form config; workflow tools must only accept
    // declared parameters with kind-compatible literals, otherwise the real
    // apply_subgraph_transaction would reject the transaction.
    if (!tool) {
      config[arg.key] = literal;
      continue;
    }
    if (!spec) {
      diagnostics.push({
        line: arg.line,
        code: "unknown_parameter",
        message: `工作流“${statement.callee}”未声明参数“${arg.key}”`,
        suggestion: "使用 DSL 目录中该工作流声明的参数名（参数必须与目录完全一致，不得自创）",
      });
      continue;
    }
    const kind = spec.kind ?? "";
    const normalized = normalizeLiteralValue(literal, kind);
    const kindError = literalKindError(normalized, arg.key, kind, spec.options);
    if (kindError) {
      diagnostics.push({
        line: arg.line,
        code: "config_type_mismatch",
        message: kindError,
        suggestion: "检查字面量类型与该参数声明的 kind（number/boolean/select/file 等）是否匹配",
      });
      continue;
    }
    config[arg.key] = normalized;
  }

  if (unresolvedRefs.length > 0) {
    diagnostics.push({
      line,
      code: "undefined_reference",
      message: `节点“${statement.name}”引用未定义的${unresolvedRefs.length > 1 ? "节点" : "节点"}：${unresolvedRefs.join(", ")}`,
      suggestion: "被引用的节点必须在本语句之前定义",
    });
    return undefined;
  }

  if (statement.callee === "text") {
    const ports: SemanticCanvasInputPort[] = Object.keys(inputs).map((key) => ({
      name: key,
      type: "text",
      cardinality: "single",
      required: false,
    }));
    return {
      id: statement.name,
      kind: "text",
      title: statement.name,
      inputs: sortRecord(inputs),
      input_ports: ports,
      config: {},
      outputs: [outputForKind("text")],
      readiness: completeReadiness(),
    };
  }

  if (statement.callee === "asset") {
    const assetKind =
      typeof config.asset_kind === "string"
        ? config.asset_kind
        : typeof config.assetKind === "string"
          ? config.assetKind
          : "asset";
    return {
      id: statement.name,
      kind: "asset",
      title: statement.name,
      inputs: {},
      input_ports: [],
      config: sortRecord(config),
      outputs: [outputForKind(assetKind)],
      readiness: completeReadiness(),
    };
  }

  if (!tool) return undefined;

  const inputPorts: SemanticCanvasInputPort[] = [];
  for (const reference of tool.references ?? []) {
    if (!reference.parameterKey) continue;
    inputPorts.push({
      name: reference.parameterKey,
      type: reference.kind ?? "reference",
      cardinality: "single",
      required: reference.required === true,
    });
  }

  const missingInputs: string[] = [];
  for (const reference of tool.references ?? []) {
    const key = reference.parameterKey;
    if (!key) continue;
    const satisfied = inputs[key] !== undefined;
    if (reference.required === true && !satisfied) missingInputs.push(key);
  }
  // Required parameters without a default must also be provided as config
  // values, mirroring the Harness readiness rule (workflowRequirements).
  for (const [key, spec] of specs) {
    if (spec.reference || !spec.required || spec.hasDefault) continue;
    const value = config[key];
    const usable = value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
    if (!usable) missingInputs.push(key);
  }

  const outputKind = tool.outputKind ?? tool.output_kind ?? "output";
  const readiness =
    missingInputs.length === 0
      ? completeReadiness()
      : { status: "incomplete" as const, missing_inputs: missingInputs, invalid_inputs: [] };
  if (missingInputs.length > 0) {
    diagnostics.push({
      line,
      code: "incomplete_input",
      message: `节点“${statement.name}”缺少必需输入：${missingInputs.join(", ")}`,
      suggestion: `为 ${statement.callee} 补充：${missingInputs
        .map((key) => (specs.get(key)?.reference ? `${key}=<节点或素材ID>` : `${key}=<字面量>`))
        .join("，")}`,
    });
  }

  return {
    id: statement.name,
    kind: "workflow",
    title: statement.name,
    inputs: sortRecord(inputs),
    input_ports: inputPorts,
    config: sortRecord(config),
    workflow_id: tool.id,
    outputs: [outputForKind(outputKind)],
    readiness,
  };
}

/**
 * Compile Canvas DSL source text into a `SemanticCanvasGraphV1`.
 *
 * Hard errors (syntax, unknown tool, undefined reference, duplicate name)
 * throw a `CanvasDslCompileError` carrying every diagnostic at once, so the
 * agent can fix a whole batch instead of one mistake per round trip. Soft
 * issues (missing required inputs) still produce a graph and are reported in
 * the result diagnostics, mirroring the Harness `incomplete` semantics.
 */
export function compileCanvasDsl(source: string, options: CompileCanvasDslOptions = {}): CompileCanvasDslResult {
  const { tokens, diagnostics: tokenDiagnostics } = tokenize(source);
  const parsed = new Parser(tokens).parse();
  const diagnostics = [...tokenDiagnostics, ...parsed.diagnostics];

  const defined = new Map<string, SemanticCanvasNode>();
  const nodes: SemanticCanvasNode[] = [];

  for (const statement of parsed.statements) {
    if (defined.has(statement.name)) {
      diagnostics.push({
        line: statement.line,
        code: "duplicate_name",
        message: `节点名称“${statement.name}”重复定义`,
        suggestion: "节点名称必须唯一",
      });
      continue;
    }
    const node = buildNode(statement, options, defined, diagnostics);
    if (!node) continue;
    nodes.push(node);
    defined.set(statement.name, node);
  }

  const hardErrors = diagnostics.filter((item) => item.code !== "incomplete_input");
  if (hardErrors.length > 0) throw new CanvasDslCompileError(hardErrors);

  nodes.sort(compareNodes);
  const graph: SemanticCanvasGraphV1 = {
    schema_version: "1",
    canvas_version: options.canvasVersion ?? null,
    nodes,
  };

  // M2: the compiled graph must satisfy the same contract the JSON path's
  // graphs are validated against. A deterministic compiler should always
  // produce a valid graph; this is a defense-in-depth check so a compiler
  // regression surfaces as a hard diagnostic instead of a downstream failure.
  if (!Value.Check(SemanticCanvasGraphV1Schema, graph)) {
    const error = Value.Errors(SemanticCanvasGraphV1Schema, graph)[0];
    diagnostics.push({
      line: 0,
      code: "schema_invalid",
      message: error ? `编译产物未通过语义图 schema 校验：${error.message}` : "编译产物未通过语义图 schema 校验",
      suggestion: "这是编译器的内部校验失败；请重试或调整节点数量",
    });
    throw new CanvasDslCompileError(diagnostics.filter((item) => item.code !== "incomplete_input"));
  }

  return { graph, diagnostics };
}
