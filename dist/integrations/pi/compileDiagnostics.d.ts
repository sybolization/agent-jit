import { ExecutionDslCompileError } from "../../compiler/compile.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
/**
 * R6.1：error-directed disclosure 的 JIT 层诊断形态——编译诊断（DslDiagnostic）
 * 中可被机器利用的结构化字段映射为大写 code 的紧凑诊断（供模型一次修复）。
 */
export type JitDiagnosticCode = "UNKNOWN_TOOL" | "UNKNOWN_ARGUMENT" | "UNKNOWN_OUTPUT_FIELD" | "TYPE_MISMATCH";
export interface JitDiagnostic {
    code: JitDiagnosticCode;
    line: number;
    tool?: string;
    argument?: string;
    field?: string;
    availableFields?: readonly string[];
    legalArguments?: readonly string[];
    suggestions?: readonly string[];
    expected?: string;
    actual?: string;
}
export interface JitCompileFailure {
    status: "compile_error";
    diagnostics: readonly JitDiagnostic[];
}
/**
 * R6.1：把编译诊断拆为可结构化渲染的 mapped 与需 prose 回退的 unmapped。
 * mapped 携带 line + 编译器确定的结构化字段（tool/argument/field/...），
 * unmapped 原样保留（编译器拿不出结构化字段的 code）。
 */
export declare function toJitDiagnostics(diagnostics: readonly DslDiagnostic[]): {
    mapped: JitDiagnostic[];
    unmapped: readonly DslDiagnostic[];
};
/** 供测试/调用方直接构造 JitCompileFailure（只含可结构化渲染的诊断）。 */
export declare function toJitCompileFailure(diagnostics: readonly DslDiagnostic[]): JitCompileFailure;
/** 编译失败的诊断反馈（模型据此一次修复；每条附"期望语义"）。 */
export declare function compileErrorFeedback(error: ExecutionDslCompileError): string;
/**
 * R6.1：编译失败的紧凑反馈——mapped 诊断输出结构化行，unmapped 保留 prose；
 * 头部固定以“编译失败”开头（测试依赖此前缀），尾部给出一行修复指令。
 */
export declare function renderCompileFailure(error: ExecutionDslCompileError): string;
