import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ExecutionGraph } from "../../compiler/ir.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import { type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { type DslGuidanceMode } from "../pi/dslReference.js";
/** jit_describe_tools：tool_names → 确定性 DSL 函数式契约文本（同 Pi 四段式）。 */
export declare function createDshJitDescribeTool(registry: RuntimeRegistry, options?: {
    guidance?: DslGuidanceMode;
}): ToolDefinition;
/** jit_execute_program 成功执行后的结构化记录（不进模型上下文，供观测/benchmark）。 */
export interface JitExecuteProgramDetails {
    source: string;
    status: "success";
    result: unknown;
    graph: ExecutionGraph;
    trace: readonly TraceEntry[];
    totalDurationMs: number;
}
/** jit_execute_program：source → 编译（执行期 registry）→ 执行（同一 registry）→ 结果。 */
export declare function createDshJitExecuteProgramTool(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    hostTools?: readonly ToolDefinition[];
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): ToolDefinition;
/** 创建 DSH 元工具集（jit_describe_tools / jit_execute_program；describeTools:false 时不挂 describe）。 */
export declare function createDshJitTools(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    guidance?: DslGuidanceMode;
    describeTools?: boolean;
    hostTools?: readonly ToolDefinition[];
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): readonly ToolDefinition[];
