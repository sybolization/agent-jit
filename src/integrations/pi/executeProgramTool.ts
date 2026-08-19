import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionGraph } from "../../compiler/ir.js";
import { compileExecutionDsl, ExecutionDslCompileError } from "../../compiler/compile.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import { execute, type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { EXECUTE_PROGRAM_TOOL } from "../../tools/jitTools.js";
import {
  executeProgramDescription,
  type RoutingPromptVariant,
} from "../../prompt/routingToolPrompts.js";
import { renderCompileFailure } from "./compileDiagnostics.js";

/** jit_execute_program 成功执行后的结构化记录（供 benchmark 测量，不进模型上下文）。 */
export interface JitExecuteProgramDetails {
  source: string;
  status: "success";
  result: unknown;
  graph: ExecutionGraph;
  trace: readonly TraceEntry[];
  totalDurationMs: number;
}

/** jit_execute_program 工具：source → 编译（同一 registry）→ 执行（同一 registry）→ 结果。
 *
 * R7 路由实验：`routingPrompt` 显式传入时使用对应工具描述变体；
 * 缺省保持 `EXECUTE_PROGRAM_TOOL` 契约层描述（历史行为不变）。
 */
export function createJitExecuteProgramTool(
  registry: RuntimeRegistry,
  options: {
    routingPrompt?: RoutingPromptVariant;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
  } = {},
): AgentTool<typeof EXECUTE_PROGRAM_TOOL.parameters> {
  return {
    ...EXECUTE_PROGRAM_TOOL,
    ...(options.routingPrompt === undefined
      ? {}
      : { description: executeProgramDescription(options.routingPrompt) }),
    label: "Compile and execute a DSL program",
    execute: async (_toolCallId, params) => {
      const source = (params as { source: string }).source.trim();
      if (!source) {
        throw new Error("source 为空。请把完整 DSL 程序放在 source 参数里。");
      }
      let graph: ExecutionGraph;
      try {
        ({ graph } = compileExecutionDsl(source, { tools: registry }));
      } catch (error) {
        if (error instanceof ExecutionDslCompileError) {
          options.onCompileFailure?.(error.diagnostics);
          throw new Error(renderCompileFailure(error));
        }
        throw error;
      }
      const execution = await execute(graph, registry);
      if (execution.status === "failed") {
        throw new Error(`执行失败：${execution.error}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(execution.result) }],
        details: {
          source,
          status: "success",
          result: execution.result,
          graph,
          trace: execution.trace,
          totalDurationMs: execution.totalDurationMs,
        } satisfies JitExecuteProgramDetails,
      };
    },
  };
}
