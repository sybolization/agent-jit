import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ExecutionGraph } from "../../compiler/ir.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import { type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { type DslGuidanceMode } from "../pi/dslReference.js";
/** 宿主工具开放配置：allow 白名单（undefined = 全部自动发现；[] = 关闭）；exclude 黑名单。 */
export interface DshHostToolsConfig {
    allow?: readonly string[];
    exclude?: readonly string[];
}
/** jit_describe_tools：tool_names → 确定性 DSL 函数式契约文本（production：signature 渲染，与 inline 签名同源）。 */
export declare function createDshJitDescribeTool(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    guidance?: DslGuidanceMode;
    hostTools?: DshHostToolsConfig;
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
    hostTools?: DshHostToolsConfig;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): ToolDefinition;
/** 创建 DSH 元工具集（jit_describe_tools / jit_execute_program；describeTools:false 时不挂 describe）。 */
export declare function createDshJitTools(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    guidance?: DslGuidanceMode;
    describeTools?: boolean;
    hostTools?: DshHostToolsConfig;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): readonly ToolDefinition[];
