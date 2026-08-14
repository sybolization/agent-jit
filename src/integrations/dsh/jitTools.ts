import { CallId } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ExecutionGraph } from "../../compiler/ir.js";
import { compileExecutionDsl, ExecutionDslCompileError } from "../../compiler/compile.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import { execute, type RuntimeRegistry } from "../../runtime/runtime.js";
import type { TraceEntry } from "../../runtime/trace.js";
import { renderCompileFailure } from "../pi/compileDiagnostics.js";
import {
  describeToolContracts,
  MAX_DESCRIBE_TOOLS,
} from "../../tools/jitTools.js";
import type { DslToolCaller } from "./toolAdapter.js";
import { HostToolView, unreachableHostCaller } from "./hostDiscovery.js";

/**
 * DSH 形态的 JIT 元工具（jit_describe_tools / jit_execute_program）。
 *
 * 与 Pi 集成（src/integrations/pi/jit.ts）的分工：
 * - Pi：createJitTools(registry) → AgentTool[]，由 Pi Agent 的工具调用循环调度；
 * - DSH：createDshJitTools(registry, tools) → ToolDefinition[]，注册进 ctx.tools，
 *   由 DSH agent loop 统一调度——harness 侧对 jit_* 不做特殊 dispatch。
 *
 * 执行语义与 Pi 完全一致：
 * - jit_describe_tools → describeToolContracts（确定性函数式契约渲染；
 *   首次调用附带 DSL 语言参考，patterns 模式附带组合 bindings）；
 * - jit_execute_program → compileExecutionDsl(source, { tools: 执行期 registry })
 *   → execute(graph, 同一个 registry) → JSON 文本结果。
 * 失败（未知工具 / 编译失败 / 执行失败）一律 throw，由 DSH 转成 isError
 * toolResult 回填模型——严格语义（不允许 partial success）天然成立。
 *
 * 执行期 registry = 插件自有工具（base）+ **DSH 宿主工具活视图**（hostDiscovery）：
 * 不依赖 apply 时快照，describe / execute 时实时查 ctx.tools（scope = 调用方
 * exec.agent），任何已注册的 DSH 工具（其他插件 / 动态注册）零配置即可
 * describe + 被 DSL 编排；宿主工具经 ctx.tools.execute 嵌套分发
 * （parent = 本次 jit 调用的 token），走完整策略管线（guard / pre-execute /
 * post-execute / 超时 / 沙箱）。jit_* 元工具自身被活视图排除，防递归。
 */

/** 执行期 registry：base（插件自有工具）之上叠加宿主工具活视图。 */
class ExecutionRegistry implements RuntimeRegistry {
  constructor(
    private readonly base: RuntimeRegistry,
    private readonly host: HostToolView | undefined,
  ) {}

  get(name: string) {
    return this.base.get(name) ?? this.host?.get(name);
  }

  all() {
    return [...this.base.all(), ...(this.host?.all() ?? [])];
  }

  resolveId(name: string): string | undefined {
    return this.base.resolveId(name) ?? this.host?.resolveId(name);
  }

  suggestIds(name: string, max?: number) {
    const base = this.base.suggestIds(name, max);
    const host = this.host?.suggestIds(name, max) ?? [];
    // 合并去重（canonical 唯一），保持 base 优先、host 补齐。
    const seen = new Set(base.map((item) => item.canonical));
    const merged = [...base];
    for (const item of host) {
      if (!seen.has(item.canonical)) {
        seen.add(item.canonical);
        merged.push(item);
      }
    }
    return merged.slice(0, max);
  }
}

/** 宿主工具开放配置：allow 白名单（undefined = 全部自动发现；[] = 关闭）；exclude 黑名单。 */
export interface DshHostToolsConfig {
  allow?: readonly string[];
  exclude?: readonly string[];
}

/** jit_describe_tools：tool_names → 确定性 DSL 函数式契约文本（production：纯契约 discovery，
 *  与 inline 签名同源；DSL 语言参考由 system prompt section 提供，不再随 describe 捆绑）。 */
export function createDshJitDescribeTool(
  registry: RuntimeRegistry,
  tools: ToolRuntime,
  options: {
    hostTools?: DshHostToolsConfig;
  } = {},
): ToolDefinition {
  return {
    name: "jit_describe_tools",
    description:
      "获取当前上下文中未提供或需要额外查询的工具 DSL 函数签名（输入参数 + 输出字段）。"
      + "仅用于动态工具发现或大型工具集合中的按需查询；已随 active tool 定义提供 DSL signature 时无需调用。",
    parameters: {
      type: "object",
      properties: {
        tool_names: { type: "array", items: { type: "string" }, description: "要获取 DSL 契约的工具 id 列表" },
      },
      required: ["tool_names"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute: async (args, exec) => {
      const toolNames = (args as { tool_names?: unknown }).tool_names;
      if (!Array.isArray(toolNames) || toolNames.length === 0 || toolNames.length > MAX_DESCRIBE_TOOLS) {
        throw new Error(
          `tool_names 必须是 1..${MAX_DESCRIBE_TOOLS} 个工具名的数组（严格语义：不允许 partial success）`,
        );
      }
      const names = toolNames.filter((item): item is string => typeof item === "string");
      // 活视图：scope = 调用方 agent（模型可见面一致），caller 不可达（只渲染契约）。
      const host = new HostToolView({
        tools,
        scope: exec?.agent,
        caller: unreachableHostCaller(),
        base: registry,
        allow: options.hostTools?.allow,
        exclude: options.hostTools?.exclude,
      });
      const executionRegistry = new ExecutionRegistry(registry, host);
      const text = describeToolContracts(executionRegistry, names, { header: "# Requested Tool Contracts" });
      // 严格语义：任一 id 未知 → 整体失败（UNKNOWN_TOOL 全列 + 建议），抛给 DSH 转 toolResult
      if (text.startsWith("错误")) throw new Error(text);
      return text;
    },
  };
}

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
export function createDshJitExecuteProgramTool(
  registry: RuntimeRegistry,
  tools: ToolRuntime,
  options: {
    hostTools?: DshHostToolsConfig;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
  } = {},
): ToolDefinition {
  return {
    name: "jit_execute_program",
    description:
      "提交一段 Agent Execution DSL 程序源码给 Harness 编译执行（把完整程序放在 source 参数里）。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Agent Execution DSL 程序源码（每条语句独占一行）" },
      },
      required: ["source"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute: async (args, exec) => {
      const source = (args as { source?: unknown }).source;
      if (typeof source !== "string" || source.trim().length === 0) {
        throw new Error("source 为空。请把完整 DSL 程序放在 source 参数里。");
      }
      // 执行期嵌套分发闭包：宿主工具经 ctx.tools.execute 走完整策略管线，
      // 以本次 jit 调用为 parent（调度/超时/沙箱都归属同一执行树）。
      let callSeq = 0;
      const caller: DslToolCaller = async (name, callArgs) => {
        const result = await tools.execute({
          callId: CallId(`${exec.callId}:dsl:${++callSeq}`),
          rootCallId: exec.rootCallId,
          name,
          arguments: callArgs,
          signal: exec.signal,
          agent: exec.agent,
          parent: exec.token,
        });
        if (result.isError) throw new Error(result.error.message);
        return result.value;
      };
      // 活视图：scope = 调用方 agent；任何已注册 DSH 工具零配置可编排。
      const host = new HostToolView({
        tools,
        scope: exec?.agent,
        caller,
        base: registry,
        allow: options.hostTools?.allow,
        exclude: options.hostTools?.exclude,
      });
      const executionRegistry = new ExecutionRegistry(registry, host);
      let graph: ExecutionGraph;
      try {
        ({ graph } = compileExecutionDsl(source, { tools: executionRegistry }));
      } catch (error) {
        if (error instanceof ExecutionDslCompileError) {
          options.onCompileFailure?.(error.diagnostics);
          throw new Error(renderCompileFailure(error));
        }
        throw error;
      }
      const execution = await execute(graph, executionRegistry);
      if (execution.status === "failed") {
        throw new Error(`执行失败：${execution.error}`);
      }
      return JSON.stringify(execution.result);
    },
  };
}

/** 创建 DSH 元工具集（jit_describe_tools / jit_execute_program；describeTools:false 时不挂 describe）。 */
export function createDshJitTools(
  registry: RuntimeRegistry,
  tools: ToolRuntime,
  options: {
    describeTools?: boolean;
    hostTools?: DshHostToolsConfig;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
  } = {},
): readonly ToolDefinition[] {
  return [
    ...(options.describeTools === false ? [] : [createDshJitDescribeTool(registry, tools, options)]),
    createDshJitExecuteProgramTool(registry, tools, options),
  ];
}
