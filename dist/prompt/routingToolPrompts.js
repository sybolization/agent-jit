/**
 * R7 路由提示词变体（tool-surface only discovery）。
 *
 * 背景：DSH 上如果 `dsl.systemPrompt: false`，模型几乎不会路由到
 * jit_execute_program。R5/R6 的 adoption 都建立在 system prompt 至少
 * 告知 JIT 能力 + DSL 语法的基础上；工具描述本身目前只有"提交一段
 * DSL 程序"，没有 when/why，也没有 how。
 *
 * 本模块提供**可切换、可审计、默认行为不变**的工具描述变体：
 * - baseline：当前生产文案（默认）；
 * - trigger：只补"何时使用 + 收益"（when/why）；
 * - tool-embedded：trigger + 完整中性 DSL 参考（how）塞进
 *   jit_execute_program 描述；
 * - tool-embedded-mini：trigger + 极简 DSL 参考（R7 候选，控制常驻成本）。
 *
 * 防 prompt overfit 约束（有 tests/routingToolPrompts.test.ts 强制）：
 * 1. 所有候选文案只使用 service.* 等通用占位符，不得出现 benchmark 的
 *    任务常量、工具 id、输出字段（github.* / full_name / stars / ratio /
 *    score / 阈值 0.15 / 100 / 查询词等）；
 * 2. 候选文案在实验跑批前冻结，改一个字都要新开变体并重跑；
 * 3. 默认 baseline 不因实验候选变化而改变。
 */
import { renderNeutralDslReference } from "../integrations/pi/dslReference.js";
/**
 * 防泄漏黑名单（单一事实源，测试与 R7 overfit audit 共用）。
 * 覆盖 development A/B 与 holdout H 的任务常量、工具 id、字段名。
 * 候选 routing prompt 一旦命中任一 token，该 variant 作废重跑。
 */
export const R7_FORBIDDEN_PROMPT_TOKENS = [
    // development A/B（R5/R6 GitHub 域）
    "agent framework",
    "adv/org-repo",
    "0.15",
    "github.search_repositories",
    "github.get_repository",
    "github_get_repository",
    "github.get_contributor_stats",
    "github.list_commits",
    "full_name",
    "stars",
    "forks",
    "ratio",
    "score",
    "contributor_count",
    "total_commits",
    "repo-score-pipeline",
    // holdout H（R7 shipment 域）
    "international",
    "shipment",
    "order_id",
    "order_no",
    "eta_days",
    "ORD-",
];
/** 当前生产文案（DSH 与 Pi 工具契约层共用同一句话）。 */
export const BASELINE_EXECUTE_DESCRIPTION = "提交一段 Agent Execution DSL 程序源码给 Harness 编译执行（把完整程序放在 source 参数里）。";
/** 当前 jit_describe_tools 文案。 */
export const BASELINE_DESCRIBE_DESCRIPTION = "获取当前上下文中未提供或需要额外查询的工具 DSL 函数签名（输入参数 + 输出字段）。"
    + "仅用于动态工具发现或大型工具集合中的按需查询；已随 active tool 定义提供 DSL signature 时无需调用。";
/**
 * 路由触发段（when/why）。只描述“什么样的剩余工作应当程序化”，
 * 不出现 DSL 语法、benchmark 工具名、字段名或阈值。
 */
export const ROUTING_TRIGGER = [
    "当剩余工作可以确定为多步数据流时使用本工具：",
    "1. 对列表中的每个元素执行相同的工具调用；",
    "2. 后续筛选 / 排序 / 合并 / 取前 N 的规则已经由任务确定，不需要在步骤之间检查中间结果；",
    "3. 一段程序可替代多次普通工具调用。",
    "一次提交可减少模型往返轮次，中间结果不会进入上下文。",
].join(" ");
/**
 * 极简 DSL 参考（how，下界候选）。
 * 只教“语句形状 + map/take 一条最小流水线 + 其他算子是存在的”，
 * 完整算子语义仍由工具定义中的 DSL: 行或 jit_describe_tools 按需提供。
 */
export const DSL_MINI_REFERENCE = [
    "## Agent Execution DSL（极简）",
    "程序为逐行语句：<名> = <调用>(...)，最后一行必须 return <名>。",
    "- map(列表, 工具(参数=_.字段))：对列表每个元素执行一次工具调用。",
    "- filter / sort / select / compute / take / concat / merge_by_key / collect 用于确定性筛选、排序、合并与截取。",
    "- 工具参数名与输出字段以工具定义中的 DSL: 行或 jit_describe_tools 返回的签名为准。",
    "例：",
    'items = service.search(query="example")',
    "details = map(items, service.get_detail(id=_.id))",
    "top = take(details, 3)",
    "return top",
].join("\n");
/** jit_execute_program 描述构造：baseline 保持逐字节不变。 */
export function executeProgramDescription(variant) {
    switch (variant) {
        case "baseline":
            return BASELINE_EXECUTE_DESCRIPTION;
        case "trigger":
            return `${BASELINE_EXECUTE_DESCRIPTION}\n\n${ROUTING_TRIGGER}`;
        case "tool-embedded":
            return `${BASELINE_EXECUTE_DESCRIPTION}\n\n${ROUTING_TRIGGER}\n\n${renderNeutralDslReference()}`;
        case "tool-embedded-mini":
            return `${BASELINE_EXECUTE_DESCRIPTION}\n\n${ROUTING_TRIGGER}\n\n${DSL_MINI_REFERENCE}`;
    }
}
/** jit_describe_tools 描述构造。trigger 臂需要告诉模型“多步程序先拿契约”。 */
export function describeProgramDescription(variant) {
    switch (variant) {
        case "baseline":
            return BASELINE_DESCRIBE_DESCRIPTION;
        case "trigger":
            return `${BASELINE_DESCRIBE_DESCRIPTION} 当 jit_execute_program 用于多步确定性数据流时，先调用本工具获取相关工具的 DSL 契约。`;
        case "tool-embedded":
        case "tool-embedded-mini":
            return BASELINE_DESCRIBE_DESCRIPTION;
    }
}
/**
 * 首次 describe 时附带的语言参考。固定使用中性参考（service.*），
 * 不随 historical guidance 复现，也不出现 benchmark 工具/字段。
 */
export function renderRoutingDslReference() {
    return renderNeutralDslReference();
}
