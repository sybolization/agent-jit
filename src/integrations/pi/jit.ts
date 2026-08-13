import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { RuntimeRegistry } from "../../runtime/runtime.js";
import type { DslGuidanceMode } from "./dslReference.js";
import { createJitDescribeTool } from "./describeToolsTool.js";
import { createJitExecuteProgramTool } from "./executeProgramTool.js";

/**
 * Agent JIT 元工具（AgentTool 形态）：把 JIT 变成 Pi Agent 的普通可执行工具。
 *
 * 本文件是「编排 + 兼容重导出」层：具体实现按职责拆分到同目录三个文件——
 * - compileDiagnostics.ts：编译诊断（DslDiagnostic）→ 结构化紧凑反馈的渲染；
 * - describeToolsTool.ts：jit_describe_tools（tool_names → 确定性 DSL 契约文本）；
 * - executeProgramTool.ts：jit_execute_program（source → 编译 + 同一 registry 执行）。
 *
 * 与 src/tools/jitTools.ts 的分工：
 * - jitTools.ts 是**契约层**（pi-ai `Tool`：name/description/parameters）——
 *   gateway 直连的 DSL 臂把 describe/execute 当 transport 工具手动 dispatch；
 * - 这里是**执行层**（pi-agent-core `AgentTool`：parameters + execute）——
 *   普通工具与 jit_* 工具都是 `createPiTools(registry)` 注册给 `Agent` 的可执行工具，
 *   Agent/agent loop 统一负责工具调用循环，实验 harness **不再对 JIT 工具做特殊 dispatch**。
 *
 * 执行语义（与旧 harness 的 dispatch 完全一致）：
 * - jit_describe_tools.execute → describeToolContracts(registry, tool_names)（确定性渲染）；
 * - jit_execute_program.execute → compileExecutionDsl(source, { tools: registry })
 *   → execute(graph, **同一个 registry**) → 文本结果 + 结构化 details。
 * 失败（未知工具 / 编译失败 / 执行失败）一律 **throw**，由 Agent 转成 isError toolResult
 * 回填给模型——严格语义（不允许 partial success）因此天然成立。
 */

export * from "./compileDiagnostics.js";
export * from "./executeProgramTool.js";
export * from "./describeToolsTool.js";

/** 创建 JIT 元工具集（jit_describe_tools / jit_execute_program；describeTools:false 时不挂 describe 工具）。 */
export function createJitTools(
  registry: RuntimeRegistry,
  options: { guidance?: DslGuidanceMode; describeTools?: boolean; onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void } = {},
): readonly AgentTool[] {
  return [
    ...(options.describeTools === false ? [] : [createJitDescribeTool(registry, options)]),
    createJitExecuteProgramTool(registry, options),
  ];
}
