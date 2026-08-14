import type { TokenizeResult } from "./ast.js";
/**
 * DSL 词法分析：把源码切成 token 流。纯函数、无副作用，语法诊断以
 * `DslDiagnostic` 批量返回（不抛出）。
 */
export declare function tokenize(source: string): TokenizeResult;
