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
export type RoutingPromptVariant = "baseline" | "trigger" | "tool-embedded" | "tool-embedded-mini";
/** jit_describe_tools 首次调用是否附带中性 DSL 语言参考。 */
export type DescribeDslReferenceMode = "none" | "first-call";
/**
 * 防泄漏黑名单（单一事实源，测试与 R7 overfit audit 共用）。
 * 覆盖 development A/B 与 holdout H 的任务常量、工具 id、字段名。
 * 候选 routing prompt 一旦命中任一 token，该 variant 作废重跑。
 */
export declare const R7_FORBIDDEN_PROMPT_TOKENS: readonly ["agent framework", "adv/org-repo", "0.15", "github.search_repositories", "github.get_repository", "github_get_repository", "github.get_contributor_stats", "github.list_commits", "full_name", "stars", "forks", "ratio", "score", "contributor_count", "total_commits", "repo-score-pipeline", "international", "shipment", "order_id", "order_no", "eta_days", "ORD-"];
/** 当前生产文案（DSH 与 Pi 工具契约层共用同一句话）。 */
export declare const BASELINE_EXECUTE_DESCRIPTION = "\u63D0\u4EA4\u4E00\u6BB5 Agent Execution DSL \u7A0B\u5E8F\u6E90\u7801\u7ED9 Harness \u7F16\u8BD1\u6267\u884C\uFF08\u628A\u5B8C\u6574\u7A0B\u5E8F\u653E\u5728 source \u53C2\u6570\u91CC\uFF09\u3002";
/** 当前 jit_describe_tools 文案。 */
export declare const BASELINE_DESCRIBE_DESCRIPTION: string;
/**
 * 路由触发段（when/why）。只描述“什么样的剩余工作应当程序化”，
 * 不出现 DSL 语法、benchmark 工具名、字段名或阈值。
 */
export declare const ROUTING_TRIGGER: string;
/**
 * 极简 DSL 参考（how，下界候选）。
 * 只教“语句形状 + map/take 一条最小流水线 + 其他算子是存在的”，
 * 完整算子语义仍由工具定义中的 DSL: 行或 jit_describe_tools 按需提供。
 */
export declare const DSL_MINI_REFERENCE: string;
/** jit_execute_program 描述构造：baseline 保持逐字节不变。 */
export declare function executeProgramDescription(variant: RoutingPromptVariant): string;
/** jit_describe_tools 描述构造。trigger 臂需要告诉模型“多步程序先拿契约”。 */
export declare function describeProgramDescription(variant: RoutingPromptVariant): string;
/**
 * 首次 describe 时附带的语言参考。固定使用中性参考（service.*），
 * 不随 historical guidance 复现，也不出现 benchmark 工具/字段。
 */
export declare function renderRoutingDslReference(): string;
