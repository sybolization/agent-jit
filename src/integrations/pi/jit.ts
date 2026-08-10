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
 * 内容只覆盖语法骨架 + 每个 primitive 一句精确语义与最小示例，不内嵌任何业务工具契约。
 * R5 review：join 改名为 merge_by_key（明确 base+overlay 语义），新增 concat（真正的列表拼接）。
 */
export const MINIMAL_DSL_REFERENCE = [
  "## Agent Execution DSL 极简参考（仅随首次 describe 返回一次）",
  "程序是 newline 分隔的语句序列：<变量> = <调用>(...)，最后一行必须是 return <变量>。",
  "每个 primitive 的输入都必须是先前定义的数组变量；每个 <变量> 输出一个数组。",
  "",
  "- map(列表, 工具(参数=_.字段))：对列表每个元素执行一次工具调用，返回结果数组。_.字段 引用当前元素字段。",
  "  例：details = map(repos, github.get_repository(full_name=_.full_name))",
  "- take(列表, N)：截取前 N 条。例：top = take(details, 5)",
  '- sort(列表, key="字段", desc=true)：按字段排序（默认升序）。例：ranked = sort(scores, key="score", desc=true)',
  '- filter(列表, 字段=值)：保留"字段 等于 值"的元素（等值过滤）。例：ts = filter(details, language="TypeScript")',
  '- compute(列表, 新字段="表达式")：给每个元素计算新字段（表达式 = 字段引用 + 数字 + 四则运算 + 括号）。例：r = compute(details, ratio="forks / stars")',
  '- select(列表, "谓词")：按比较谓词（> >= < <= == !=）过滤。例：hot = select(r, "ratio > 0.3")',
  '- merge_by_key(基准列表, 附加列表..., key="字段")：把每条附加列表里 key 匹配的记录字段合并进基准记录（基准已有字段不覆盖）。',
  "  语义：给每条基准记录附加另一批数据的字段——不是对称合并，要真正拼接列表时用 concat。",
  '  例：merged = merge_by_key(details, contrib_scores, commit_scores, key="full_name")',
  "- concat(列表1, 列表2, ...)：按顺序把多个列表拼成一个大列表，元素原样保留（真正的列表拼接）。",
  "  例：both = concat(high, low)",
  "- 工具 id 两种写法等价：github.search_repositories 与 github_search_repositories",
  "",
  "示例（搜索 → 批量取详情 → compute 比值 → 互补分支 → 按 key 合并 → 过滤 → 排序 → 截取）：",
  "注意：示例的查询词 / 截取数 / 阈值只是演示语法，**不代表任何任务的真实参数**。",
  'repos = github.search_repositories(query="rss reader", limit=20)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  'ratio = compute(details, ratio="forks / stars")',
  'hot = select(ratio, "ratio > 0.3")',
  'cold = select(ratio, "ratio <= 0.3")',
  "hotScores = map(hot, github.get_contributor_stats(full_name=_.full_name))",
  "coldScores = map(cold, github.list_commits(full_name=_.full_name))",
  'merged = merge_by_key(details, hotScores, coldScores, key="full_name")',
  'kept = select(merged, "score >= 50")',
  'ranked = sort(kept, key="score", desc=true)',
  "top = take(ranked, 4)",
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
export function createJitTools(registry: RuntimeRegistry): readonly AgentTool[] {
  return [createJitDescribeTool(registry), createJitExecuteProgramTool(registry)];
}
