import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionGraph } from "../../compiler/ir.js";
import { compileExecutionDsl, ExecutionDslCompileError } from "../../compiler/compile.js";
import { execute, type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, describeToolContracts } from "../../tools/jitTools.js";

/**
 * Agent JIT 元工具（AgentTool 形态）：把 JIT 变成 Pi Agent 的普通可执行工具。
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

/** jit_execute_program 成功执行后的结构化记录（供 benchmark 测量，不进模型上下文）。 */
export interface JitExecuteProgramDetails {
  source: string;
  status: "success";
  result: unknown;
  graph: ExecutionGraph;
  trace: readonly TraceEntry[];
  totalDurationMs: number;
}

/**
 * 极简 DSL 参考：**按需加载**——不再常驻 system prompt，而是由 jit_describe_tools
 * **第一次**调用时随契约文本一并返回（与"工具 contract 可以 lazy load"同一设计原则）。
 * 内容只覆盖语法骨架，不内嵌任何业务工具契约。
 */
export const MINIMAL_DSL_REFERENCE = [
  "## Agent Execution DSL 极简参考（仅随首次 describe 返回一次）",
  "程序是 newline 分隔的语句序列：<变量> = <调用>(...)，最后一行必须是 return <变量>。",
  "- map(列表, 工具(参数=_.字段))：对列表每个元素执行一次绑定调用，_.字段 引用当前元素",
  "- take(列表, N)：截取前 N 条；sort(列表, key=\"字段\", desc=true)：按字段排序",
  "- filter(列表, 字段=值)：等值过滤；compute(列表, 字段=\"表达式\")：计算新字段",
  "- select(列表, \"谓词\")：按谓词过滤；join(列表1, 列表2, ..., key=\"字段\")：按键合并多个列表",
  "- 工具 id 两种写法等价：github.search_repositories 与 github_search_repositories",
  "",
  "示例（搜索 → 批量取详情 → 取前 3）：",
  'repos = github.search_repositories(query="agent framework", limit=10)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  "top = take(details, 3)",
  "return top",
].join("\n");

/** jit_describe_tools 工具：tool_names → 确定性 DSL 契约文本。 */
export function createJitDescribeTool(registry: RuntimeRegistry): AgentTool<typeof DESCRIBE_TOOLS_TOOL.parameters> {
  let describeCalls = 0;
  return {
    ...DESCRIBE_TOOLS_TOOL,
    label: "Describe DSL tool contracts",
    execute: async (_toolCallId, params) => {
      const toolNames = (params as { tool_names: string[] }).tool_names;
      let text = describeToolContracts(registry, toolNames);
      // 严格语义：任一 id 未知 → 整体失败（UNKNOWN_TOOL 全列 + 建议），抛给 Agent 转 toolResult
      if (text.startsWith("错误")) throw new Error(text);
      describeCalls += 1;
      // DSL manual 按需加载：第一次 describe 顺带返回极简语法参考，之后不再重复
      if (describeCalls === 1) text = `${MINIMAL_DSL_REFERENCE}\n\n${text}`;
      return {
        content: [{ type: "text", text }],
        details: { toolNames: (params as { tool_names: string[] }).tool_names },
      };
    },
  };
}

/** jit_execute_program 工具：source → 编译（同一 registry）→ 执行（同一 registry）→ 结果。 */
export function createJitExecuteProgramTool(registry: RuntimeRegistry): AgentTool<typeof EXECUTE_PROGRAM_TOOL.parameters> {
  return {
    ...EXECUTE_PROGRAM_TOOL,
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
        if (error instanceof ExecutionDslCompileError) throw new Error(compileErrorFeedback(error));
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

/** 编译失败的诊断反馈（与旧 harness 的 DSL 臂 feedback 同格式，模型据此修正重提）。 */
export function compileErrorFeedback(error: ExecutionDslCompileError): string {
  return [
    "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
    ...error.diagnostics.map((item) => {
      const suggestion = item.suggestion ? `（${item.suggestion}）` : "";
      return `L${item.line}: ${item.code}: ${item.message}${suggestion}`;
    }),
  ].join("\n");
}

/** 创建 JIT 元工具集（jit_describe_tools / jit_execute_program）。 */
export function createJitTools(registry: RuntimeRegistry): readonly AgentTool[] {
  return [createJitDescribeTool(registry), createJitExecuteProgramTool(registry)];
}
