import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ExecutionGraph } from "../../compiler/ir.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import { type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { type DescribeDslReferenceMode, type RoutingPromptVariant } from "../../prompt/routingToolPrompts.js";
/** 宿主工具开放配置：allow 白名单（undefined = 全部自动发现；[] = 关闭）；exclude 黑名单。 */
export interface DshHostToolsConfig {
    allow?: readonly string[];
    exclude?: readonly string[];
}
/** jit_describe_tools：tool_names → 确定性 DSL 函数式契约文本。
 *
 * 默认（production）仍是纯契约 discovery；R7 的 lazy-manual 臂可配置
 * `describeDslReference: "first-call"`，让首次成功 describe 顺带返回
 * **中性** DSL 语言参考（service.*，不含 benchmark 工具/字段）。
 */
export declare function createDshJitDescribeTool(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    hostTools?: DshHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    describeDslReference?: DescribeDslReferenceMode;
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
/** jit_execute_program：source → 编译（执行期 registry）→ 执行（同一 registry）→ 结果。
 *
 * R7 路由优化入口：`routingPrompt` 切换工具描述文案（缺省 baseline =
 * 当前生产文案，行为逐字节不变），用于 no-system-prompt 的 discovery 实验。
 */
export declare function createDshJitExecuteProgramTool(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    hostTools?: DshHostToolsConfig;
    routingPrompt?: RoutingPromptVariant;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): ToolDefinition;
/** 创建 DSH 元工具集（jit_describe_tools / jit_execute_program；describeTools:false 时不挂 describe）。 */
export declare function createDshJitTools(registry: RuntimeRegistry, tools: ToolRuntime, options?: {
    describeTools?: boolean;
    hostTools?: DshHostToolsConfig;
    /** R7 routing prompt variant（缺省 baseline = 当前生产文案）。 */
    routingPrompt?: RoutingPromptVariant;
    /** R7 lazy-manual 臂：首次 describe 附带中性 DSL 参考（缺省 none）。 */
    describeDslReference?: DescribeDslReferenceMode;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
}): readonly ToolDefinition[];
