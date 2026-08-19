import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";

/**
 * jit 路由提醒（soft hook，advisory）。
 *
 * 机制与 DSH 自带的 @deepseek-ai/dsh-repeat-tool-reminder 同源：
 * 在 `tools/post-execute` 上返回 `additionalContexts`，agent loop 会把这些
 * 上下文拼进下一步的 inbox（next-step），从而**必然**成为下一次 LLM 请求的
 * 输入——结构上强制"曝光"，但不强制"服从"：模型完全可以忽略。
 *
 * 触发条件（只在"工具返回列表"之后，其余回合零开销）：
 * - 顶层（model-direct）调用：`exec.parent === undefined`。嵌套执行（jit
 *   程序内部经 hostDiscovery 分发的宿主工具）带 parent，绝不注入——否则
 *   提醒会漏进正在确定性执行的程序中间，而不是漏给模型。
 * - 成功结果：`result.isError === false`。
 * - 结果含列表：顶层数组，或对象里至少一个数组字段，长度 >= minListLength。
 *
 * 去重（oncePerTurn，缺省开启）：每个 agent 每个用户回合最多提醒一次。
 * 在 `agent/pre-step` 上监听，当 claim 到一条真正的用户消息（source.kind
 * === "user"）时清除该 agent 的标记——与 repeat-tool-reminder 的回合边界
 * 语义一致；注入的提醒本身 source.kind === "plugin"，不会误触重置。
 *
 * 文案是触发层（policy 已常驻在 jit_execute_program 的 tool-embedded 描述里）：
 * 只负责在"列表刚出现"这一刻把 policy 唤醒，不重复内嵌 DSL manual。
 */
export type RoutingReminderMode = "none" | "on-list";

/** 注入消息的 source 标签。无 label 的 context 会被派生历史当 user prompt 渲染，必须显式标注。 */
const PLUGIN_SOURCE = { kind: "plugin", plugin: "agent-jit-dsl" } as const;

/** 中性文案：只出现 jit_* 元工具名，不出现任何业务工具 / 字段 / 阈值（防 overfit）。 */
export const LIST_ROUTING_REMINDER = [
  "（Agent JIT 提醒）刚返回了一个列表结果。若接下来的操作是对该列表的确定性批量处理——",
  "对每项执行相同工具调用，或筛选 / 排序 / 合并 / 截取，且无需在步骤之间检查中间结果——",
  "可考虑用 jit_execute_program 一次提交：减少往返轮次，中间结果不进上下文。",
  "工具契约可用 jit_describe_tools 查询。若不适用，忽略本提醒即可。",
].join("\n");

/** 判断工具结果是否"含列表"：顶层数组，或对象里至少一个数组字段（长度 >= minLength）。 */
export function containsList(value: unknown, minLength: number): boolean {
  if (Array.isArray(value)) return value.length >= minLength;
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(
      (item) => Array.isArray(item) && item.length >= minLength,
    );
  }
  return false;
}

/** 构造一条路由提醒消息（user 角色、plugin 来源、notice 形态）。 */
export function buildListReminder() {
  return createUserMessage({
    content: [{ type: "text", text: LIST_ROUTING_REMINDER }],
    source: {
      ...PLUGIN_SOURCE,
      form: "notice",
      summary: "list-result → consider jit_execute_program",
    },
  });
}

export interface RoutingReminderOptions {
  /** 触发提醒的最小列表长度（缺省 2：单元素列表不值得程序化）。 */
  minListLength?: number;
  /** 每个 agent 每个用户回合最多提醒一次（缺省 true）。 */
  oncePerTurn?: boolean;
}

/** gate 判定所需的最小 exec 视图（可单测，无需构造完整 ToolExecution）。 */
export interface ReminderExecView {
  parent?: unknown;
  agent?: object;
}

/** gate 判定所需的最小 result 视图。 */
export interface ReminderResultView {
  isError: boolean;
  value?: unknown;
}

/**
 * once-per-turn 状态机（可单测）。`installRoutingReminder` 把它的两个方法
 * 接到 `tools/post-execute`（判定 + 登记）与 `agent/pre-step`（重置）上。
 */
export class RoutingReminderGate {
  private readonly reminded = new WeakSet<object>();

  constructor(private readonly options: Required<RoutingReminderOptions>) {}

  /** 返回本次顶层工具结果是否应触发提醒；命中时登记 once-per-turn 标记。 */
  shouldRemind(exec: ReminderExecView, result: ReminderResultView): boolean {
    if (result.isError) return false;
    if (exec.parent !== undefined) return false;
    if (!containsList(result.value, this.options.minListLength)) return false;
    if (!this.options.oncePerTurn) return true;
    // 程序化调用（无 agent）没有"回合"概念，不参与去重。
    if (exec.agent === undefined) return true;
    if (this.reminded.has(exec.agent)) return false;
    this.reminded.add(exec.agent);
    return true;
  }

  /** agent/pre-step：当 claim 到真正的用户消息时，清除该 agent 的 once-per-turn 标记。 */
  onPreStep(agent: object, messages: readonly { source?: { kind?: string } }[]): void {
    if (messages.some((message) => message.source?.kind === "user")) {
      this.reminded.delete(agent);
    }
  }
}

/** agent/pre-step 事件由 @deepseek-ai/dsh-agent 声明（见 runtime-types.d.ts），无需本地 augmentation。 */

/**
 * 安装路由提醒 hook。注册的监听器随插件 fiber 卸载自动清理（cordis effect 化）。
 * 在 apply 里调用一次即可。
 */
export function installRoutingReminder(
  ctx: Context,
  options: RoutingReminderOptions = {},
): void {
  const oncePerTurn = options.oncePerTurn ?? true;
  const gate = new RoutingReminderGate({
    minListLength: options.minListLength ?? 2,
    oncePerTurn,
  });

  ctx.on(
    "tools/post-execute",
    async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ) => {
      const downstream = await next();
      if (!gate.shouldRemind(exec, result)) return downstream;
      const reminder = buildListReminder();
      return {
        ...downstream,
        additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])],
      };
    },
  );

  if (oncePerTurn) {
    ctx.on("agent/pre-step", ({ agent, messages }, next) => {
      gate.onPreStep(agent, messages);
      return next();
    });
  }
}
