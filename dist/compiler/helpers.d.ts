import type { LiteralValue, ParsedStatement } from "../language/ast.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import type { ToolContract } from "../tools/definition.js";
import type { ToolCatalog } from "../tools/registry.js";
import { type SchemaView } from "../tools/schemaView.js";
import type { ExecutionNode } from "./ir.js";
/**
 * Execution DSL 编译器共享 helper（Task 5 拆分自 compiler.ts）。
 *
 * 本文件只放无副作用、无派发职责的纯工具：字面量归一化 / 参数取值 /
 * 位置参数映射 / tool 参数契约 / 元素 schema 视图。构造 builder 见
 * `toolCall.ts` 与 `builtins/`，入口见 `compile.ts`。
 */
/** 节点排序：按 id 字典序（保证编译产物确定性）。 */
export declare function compareNodes(left: {
    id: string;
}, right: {
    id: string;
}): number;
/**
 * unknown_tool 诊断的确定性近似建议文本：经 ToolIdResolver 的近似匹配，
 * 同时展示 host alias 与 canonical（如 "github_get_repository"（github.get_repository））；
 * 相似度太低 / 无工具目录时返回 undefined（诊断回退到通用提示）。
 */
export declare function suggestToolNames(tools: ToolCatalog | undefined, name: string): string | undefined;
/** 编译器看到的工具参数（从 inputSchema 经 SchemaView 提取）。 */
export interface ToolParamSpec {
    key: string;
    /** "unknown" 表示非原始类型（union/array/object/null/record）——编译器跳过字面量类型检查，不误报也不当 string 放行。 */
    kind: "string" | "int" | "number" | "boolean" | "unknown";
    required: boolean;
}
export declare function toolParams(tool: ToolContract): ToolParamSpec[];
/**
 * REQ-5：编译期"元素 schema"——map 绑定校验所需的字段形状视图
 * （从 outputSchema 的 SchemaView 提取，字段值为 SchemaView）。
 */
export interface ElementSchema {
    properties: Record<string, SchemaView>;
}
/** 从工具 outputSchema 提取元素 schema：array 取 items 的 object，object 取自身。 */
export declare function elementSchemaOf(definition: ToolContract | undefined): ElementSchema | undefined;
/** 节点输出 → 元素 schema（编译循环随符号表维护）；compute 形状动态未知，join/concat 取第一个 source。 */
export declare function nodeElementSchema(node: ExecutionNode, tools: ToolCatalog | undefined, symbols: ReadonlyMap<string, ElementSchema | undefined>): ElementSchema | undefined;
export declare function normalizeLiteral(value: LiteralValue, kind: string): LiteralValue;
export declare function literalKindError(value: LiteralValue, parameterKey: string, kind: string): string | null;
export declare function pushMissing(diagnostics: DslDiagnostic[], line: number, callee: string, key: string): void;
/** 取字面量参数；ref 或缺失时报错，返回 undefined。 */
export declare function literalArg(statement: ParsedStatement, key: string, diagnostics: DslDiagnostic[], options?: {
    required?: boolean;
}): LiteralValue | undefined;
/** 取变量引用参数；literal、缺失或未定义时报错，返回引用名。 */
export declare function refArg(statement: ParsedStatement, key: string, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): string | undefined;
/**
 * 位置参数 → 命名参数映射（canonical：位置参数永远允许）。
 *
 * parser 中性支持位置参数（key 为 undefined）；canonical 语法冻结后
 * 位置参数是语言一部分（如 `map(repos, ...)`、`take(details, 3)`）。
 * 按 `slots` 顺序映射为命名参数；越界报 `TOO_MANY_POSITIONAL_ARGS`，
 * 与同名命名参数冲突报 `duplicate_argument`。
 */
export declare function applyPositionalArgs(statement: ParsedStatement, slots: readonly string[], diagnostics: DslDiagnostic[]): ParsedStatement | undefined;
