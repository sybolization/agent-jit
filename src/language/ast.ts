/**
 * DSL 前端的 AST 数据结构（中性，不含任何语义域概念）。
 *
 * 语法（newline 分隔语句）：
 *   <statement> := <name> "=" <callee> "(" <args>? ")"
 *   <args>      := <arg> ("," <arg>)*
 *   <arg>       := <key> "=" <value>
 *   <value>     := string | number | boolean | null | array | <name-reference>
 *
 * 裸标识符在值位置即对先前语句的引用（`kind: "ref"`），引用本身定义
 * 数据流边，由编译后端负责展开。
 */
import type { DslDiagnostic } from "./diagnostics.js";

export type TokenType = "ident" | "number" | "string" | "symbol" | "newline" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
}

export interface TokenizeResult {
  tokens: Token[];
  diagnostics: DslDiagnostic[];
}

export type LiteralValue = null | boolean | number | string | LiteralValue[];

export interface ParsedValue {
  line: number;
  kind: "literal" | "ref";
  literal?: LiteralValue;
  name?: string;
}

export interface ParsedArg {
  line: number;
  /** 命名参数名；位置参数（如 `map(repos, ...)` 的第一个参数）为 undefined */
  key?: string;
  value: ParsedValue;
}

export interface ParsedStatement {
  line: number;
  name: string;
  callee: string;
  args: ParsedArg[];
}

export interface ParseResult {
  statements: ParsedStatement[];
  diagnostics: DslDiagnostic[];
}
