import type { Context } from "@deepseek-ai/cordis";
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
 * - 不在排除名单内：缺省排除内容读取类工具（read/read_image），其数组字段
 *   是内容细节而非可 fan-out 的实体列表（见 DEFAULT_REMINDER_EXCLUDE）。
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
/** 中性文案：只出现 jit_* 元工具名，不出现任何业务工具 / 字段 / 阈值（防 overfit）。 */
export declare const LIST_ROUTING_REMINDER: string;
/** 判断工具结果是否"含列表"：顶层数组，或对象里至少一个数组字段（长度 >= minLength）。 */
export declare function containsList(value: unknown, minLength: number): boolean;
/** 构造一条路由提醒消息（user 角色、plugin 来源、notice 形态）。 */
export declare function buildListReminder(): {
    content: {
        type: "text";
        text: string;
    }[];
    source: {
        kind: "plugin";
        plugin: "agent-jit-dsl";
        form: "notice";
        summary: string;
    };
} & Pick<import("@deepseek-ai/dsh-llm").UserMessage, "id" | "role">;
export interface RoutingReminderOptions {
    /** 触发提醒的最小列表长度（缺省 2：单元素列表不值得程序化）。 */
    minListLength?: number;
    /** 每个 agent 每个用户回合最多提醒一次（缺省 true）。 */
    oncePerTurn?: boolean;
    /**
     * 排除不触发提醒的工具名（支持 `*` 通配符）。缺省排除"内容读取"类工具
     * （read / read_image）——它们的数组字段是内容细节（read.lines），不是
     * 可 fan-out 的实体列表；传空数组 `[]` 可关闭排除。
     */
    exclude?: readonly string[];
}
/**
 * 缺省排除名单：内容读取类工具。`read` 的规范值是 `{path, offset, lines[],
 * totalLines}`，`lines` 是数组但属于"单实体内容细节"，不是可被后续逐个
 * fan-out 的实体列表——若不排除，每次 read 都会误触发提醒。
 */
export declare const DEFAULT_REMINDER_EXCLUDE: readonly string[];
/** gate 判定所需的最小 exec 视图（可单测，无需构造完整 ToolExecution）。 */
export interface ReminderExecView {
    name?: string;
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
export declare class RoutingReminderGate {
    private readonly options;
    private readonly reminded;
    private readonly exclude;
    constructor(options: Required<RoutingReminderOptions>);
    /** 返回本次顶层工具结果是否应触发提醒；命中时登记 once-per-turn 标记。 */
    shouldRemind(exec: ReminderExecView, result: ReminderResultView): boolean;
    /** agent/pre-step：当 claim 到真正的用户消息时，清除该 agent 的 once-per-turn 标记。 */
    onPreStep(agent: object, messages: readonly {
        source?: {
            kind?: string;
        };
    }[]): void;
}
/** agent/pre-step 事件由 @deepseek-ai/dsh-agent 声明（见 runtime-types.d.ts），无需本地 augmentation。 */
/**
 * 安装路由提醒 hook。注册的监听器随插件 fiber 卸载自动清理（cordis effect 化）。
 * 在 apply 里调用一次即可。
 */
export declare function installRoutingReminder(ctx: Context, options?: RoutingReminderOptions): void;
