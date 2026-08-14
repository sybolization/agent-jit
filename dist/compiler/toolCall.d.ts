import type { ParsedArg, ParsedStatement } from "../language/ast.js";
import type { DslDiagnostic } from "../language/diagnostics.js";
import type { ToolContract } from "../tools/definition.js";
import type { ToolCatalog } from "../tools/registry.js";
import type { ExecutionNode, MapNode } from "./ir.js";
import { type ElementSchema } from "./helpers.js";
/**
 * 工具调用构建（`buildToolNode`）与 map 绑定校验（`mapCallBindings` /
 * `validateMapBindings`）。canonical 语法中 map 只用调用绑定形态，
 * `toolArg`（字符串/裸标识符 tool 参数）已归入 legacy 编译器。
 */
/** 从 call 表达式的参数中提取 binding 映射（`_.field` / `<param>.field` → 元素字段）。 */
export declare function mapCallBindings(call: {
    callee?: string;
    args?: ParsedArg[];
}, prefix: string, tools: ToolCatalog, diagnostics: DslDiagnostic[]): Record<string, string> | undefined;
export declare function buildToolNode(statement: ParsedStatement, tool: ToolContract, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
/**
 * REQ-5：map 绑定字段校验——`_.<field>` 必须存在于 source 元素 schema
 * （不存在 → UNKNOWN_FIELD，suggestion 列出可用字段），且字段类型与绑定参数
 * 的 inputSchema 类型基础匹配（integer/number 互配，string 配 string，
 * boolean 配 boolean；union 任一成员匹配即可；unknown 跳过避免误报）。
 * source 元素形状未知（compute 产物 / 未注册工具）时跳过。
 * `line` 指向该 map 语句的行号，供诊断定位。
 */
export declare function validateMapBindings(node: MapNode, tools: ToolCatalog | undefined, symbols: ReadonlyMap<string, ElementSchema | undefined>, diagnostics: DslDiagnostic[], line: number): void;
