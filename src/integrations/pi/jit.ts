import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionGraph } from "../../compiler/ir.js";
import { compileExecutionDsl, ExecutionDslCompileError } from "../../compiler/compile.js";
import { execute, type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, describeToolContracts } from "../../tools/jitTools.js";
import { DEFAULT_DSL_GUIDANCE, renderDslReference, type DslGuidanceMode } from "./dslReference.js";
import { renderCompositionBindings } from "../../tools/compositionHints.js";

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
 * DSL manual 按需加载：不常驻 system prompt，由 jit_describe_tools **第一次**调用时
 * 随契约文本一并返回（与"工具 contract 可以 lazy load"同一设计原则）。
 * 内容由 dslReference.ts 的 renderDslReference(guidance) 按 guidance 模式渲染：
 * primitive → 核心三层参考（1. Tool calls / 2. Array dataflow operators / 3. Return）；
 * patterns → 核心参考 + 组合模式；full-example → 核心参考 + 端到端示例。
 * 组合模式只使用通用变量名与 service.* 通用服务名，不内嵌任何业务工具契约或任务常量。
 */

/** 与 describeToolContracts 一致的解析：tool_names（canonical / host alias）→ 去重后的 canonical id 列表。 */
function resolveCanonicalIds(catalog: RuntimeRegistry, toolNames: readonly string[]): string[] {
  const ids: string[] = [];
  for (const name of [...new Set(toolNames.map((name) => name.trim()).filter((name) => name.length > 0))]) {
    const canonical = catalog.resolveId(name);
    if (canonical !== undefined && !ids.includes(canonical)) ids.push(canonical);
  }
  return ids;
}

/** jit_describe_tools 工具：tool_names → 确定性 DSL 契约文本（四段式：DSL manual + 契约 + bindings）。 */
export function createJitDescribeTool(
  registry: RuntimeRegistry,
  options: { guidance?: DslGuidanceMode } = {},
): AgentTool<typeof DESCRIBE_TOOLS_TOOL.parameters> {
  let describeCalls = 0;
  const guidance = options.guidance ?? DEFAULT_DSL_GUIDANCE;
  return {
    ...DESCRIBE_TOOLS_TOOL,
    label: "Describe DSL tool contracts",
    execute: async (_toolCallId, params) => {
      const toolNames = (params as { tool_names: string[] }).tool_names;
      let text = describeToolContracts(registry, toolNames, { header: "# Requested Tool Contracts" });
      // 严格语义：任一 id 未知 → 整体失败（UNKNOWN_TOOL 全列 + 建议），抛给 Agent 转 toolResult
      if (text.startsWith("错误")) throw new Error(text);
      describeCalls += 1;
      // 本次请求工具集合的局部兼容连接（仅 patterns 模式；与 manual 的按需加载解耦，每次 describe 都返回）
      const canonicalIds = resolveCanonicalIds(registry, toolNames);
      const bindings = guidance === "patterns" ? renderCompositionBindings(registry, canonicalIds) : "";
      // DSL manual 按需加载：第一次 describe 顺带返回语法参考（按 guidance 模式渲染），之后不再重复
      if (describeCalls === 1) text = `${renderDslReference(guidance)}\n\n${text}`;
      if (bindings.length > 0) text = `${text}\n\n${bindings}`;
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

/** 常见诊断 code → "期望语义"提示（一次修复成功率的关键：明确指出错在哪、期望是什么）。 */
const FIX_HINTS: Record<string, string> = {
  unknown_tool: "期望：已注册业务工具 id，或语言关键字 map / take / filter / sort / compute / select / merge_by_key / concat / return",
  unknown_parameter: "期望：只使用该工具契约声明的参数名（见 jit_describe_tools 返回的契约），不得自创参数",
  UNKNOWN_FIELD: "期望：绑定字段 _.字段 必须来自上游工具输出 schema（见契约的输出字段）",
  MAP_BINDING_REF_INVALID: "期望：绑定值必须形如 _.字段（引用当前元素），不能是字面量或外部变量",
  undefined_reference: "期望：被引用的变量必须在该语句之前定义（不允许前向引用）",
  duplicate_name: "期望：变量名必须唯一，改名后重新定义",
  duplicate_argument: "期望：每个参数只能赋值一次",
  invalid_reference: "期望：该参数必须是先前定义的变量引用（或字面量，见具体说明）",
  config_type_mismatch: "期望：字面量类型/形状必须与契约声明的参数类型一致",
  expression_invalid: "期望：compute 表达式 = 字段引用 + 数字 + 四则运算 + 括号；select 谓词 = 顶层比较（> >= < <= == !=）",
  TOO_MANY_POSITIONAL_ARGS: "期望：位置参数数量不超过该关键字定义的槽位（顺序见提示）",
  syntax: "期望：语句形如 <变量> = <调用>(<参数>, ...)，检查标点、引号与参数形式",
};

/** 编译失败的诊断反馈（模型据此一次修复；每条附"期望语义"）。 */
export function compileErrorFeedback(error: ExecutionDslCompileError): string {
  return [
    "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
    ...error.diagnostics.map((item) => {
      const hint = FIX_HINTS[item.code];
      const parts = [`L${item.line}: ${item.code}: ${item.message}`];
      if (item.suggestion) parts.push(`（${item.suggestion}）`);
      if (hint) parts.push(`——${hint}`);
      return parts.join("");
    }),
  ].join("\n");
}

/** 创建 JIT 元工具集（jit_describe_tools / jit_execute_program）。 */
export function createJitTools(
  registry: RuntimeRegistry,
  options: { guidance?: DslGuidanceMode } = {},
): readonly AgentTool[] {
  return [createJitDescribeTool(registry, options), createJitExecuteProgramTool(registry)];
}
