/**
 * 编译诊断分类：把一批 DslDiagnostic 按 code 归入 R6.2 的三类计数。
 * CompileErrorBreakdown 接口定义见 ./types.js（收口到类型叶子模块以打破 import 环）。
 */

import type { CompileErrorBreakdown } from "./types.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";

/** 编译诊断 code → R6.2 三类（syntaxOrCompleteness / outputContractRelated / other）。 */
export function classifyCompileErrorCode(code: string): keyof CompileErrorBreakdown {
  if (code === "syntax" || code === "duplicate_name" || code === "missing_return" || code === "duplicate_return") {
    return "syntaxOrCompleteness";
  }
  if (
    code === "UNKNOWN_FIELD" ||
    code === "config_type_mismatch" ||
    code === "unknown_parameter" ||
    code === "MAP_BINDING_REF_INVALID"
  ) {
    return "outputContractRelated";
  }
  return "other";
}

/** 把一批编译诊断汇总为三类计数（供 run 级 compileErrorBreakdown 与格内聚合使用）。 */
export function compileErrorBreakdown(diagnostics: readonly DslDiagnostic[]): CompileErrorBreakdown {
  const breakdown: CompileErrorBreakdown = { syntaxOrCompleteness: 0, outputContractRelated: 0, other: 0 };
  for (const item of diagnostics) breakdown[classifyCompileErrorCode(item.code)] += 1;
  return breakdown;
}
