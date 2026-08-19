import { createUserMessage } from "@deepseek-ai/dsh-llm";
/** 注入消息的 source 标签。无 label 的 context 会被派生历史当 user prompt 渲染，必须显式标注。 */
const PLUGIN_SOURCE = { kind: "plugin", plugin: "agent-jit-dsl" };
/** 中性文案：只出现 jit_* 元工具名，不出现任何业务工具 / 字段 / 阈值（防 overfit）。 */
export const LIST_ROUTING_REMINDER = [
    "（Agent JIT 提醒）刚返回了一个列表结果。若接下来的操作是对该列表的确定性批量处理——",
    "对每项执行相同工具调用，或筛选 / 排序 / 合并 / 截取，且无需在步骤之间检查中间结果——",
    "可考虑用 jit_execute_program 一次提交：减少往返轮次，中间结果不进上下文。",
    "工具契约可用 jit_describe_tools 查询。若不适用，忽略本提醒即可。",
].join("\n");
/** 判断工具结果是否"含列表"：顶层数组，或对象里至少一个数组字段（长度 >= minLength）。 */
export function containsList(value, minLength) {
    if (Array.isArray(value))
        return value.length >= minLength;
    if (value !== null && typeof value === "object") {
        return Object.values(value).some((item) => Array.isArray(item) && item.length >= minLength);
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
/**
 * 缺省排除名单：内容读取类工具。`read` 的规范值是 `{path, offset, lines[],
 * totalLines}`，`lines` 是数组但属于"单实体内容细节"，不是可被后续逐个
 * fan-out 的实体列表——若不排除，每次 read 都会误触发提醒。
 */
export const DEFAULT_REMINDER_EXCLUDE = ["read", "read_image"];
/** `*` 通配符 → 锚定正则（其余正则元字符按字面匹配；与 repeat-tool-reminder 同规则）。 */
function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}
/**
 * once-per-turn 状态机（可单测）。`installRoutingReminder` 把它的两个方法
 * 接到 `tools/post-execute`（判定 + 登记）与 `agent/pre-step`（重置）上。
 */
export class RoutingReminderGate {
    options;
    reminded = new WeakSet();
    exclude;
    constructor(options) {
        this.options = options;
        this.exclude = options.exclude.map(wildcardToRegExp);
    }
    /** 返回本次顶层工具结果是否应触发提醒；命中时登记 once-per-turn 标记。 */
    shouldRemind(exec, result) {
        if (result.isError)
            return false;
        if (exec.parent !== undefined)
            return false;
        const toolName = exec.name;
        if (toolName !== undefined && this.exclude.some((re) => re.test(toolName)))
            return false;
        if (!containsList(result.value, this.options.minListLength))
            return false;
        if (!this.options.oncePerTurn)
            return true;
        // 程序化调用（无 agent）没有"回合"概念，不参与去重。
        if (exec.agent === undefined)
            return true;
        if (this.reminded.has(exec.agent))
            return false;
        this.reminded.add(exec.agent);
        return true;
    }
    /** agent/pre-step：当 claim 到真正的用户消息时，清除该 agent 的 once-per-turn 标记。 */
    onPreStep(agent, messages) {
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
export function installRoutingReminder(ctx, options = {}) {
    const oncePerTurn = options.oncePerTurn ?? true;
    const gate = new RoutingReminderGate({
        minListLength: options.minListLength ?? 2,
        oncePerTurn,
        exclude: options.exclude ?? DEFAULT_REMINDER_EXCLUDE,
    });
    ctx.on("tools/post-execute", async (exec, result, next) => {
        const downstream = await next();
        if (!gate.shouldRemind(exec, result))
            return downstream;
        const reminder = buildListReminder();
        return {
            ...downstream,
            additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])],
        };
    });
    if (oncePerTurn) {
        ctx.on("agent/pre-step", ({ agent, messages }, next) => {
            gate.onPreStep(agent, messages);
            return next();
        });
    }
}
