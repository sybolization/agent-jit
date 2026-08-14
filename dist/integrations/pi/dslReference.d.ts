/**
 * Agent Execution DSL 参考（model-facing language specification）。
 *
 * 职责：只描述"语言本身"——三层语言模型（Tool calls / Array dataflow operators / Return）、
 * 核心算子语义、正交组合模式（可选）与端到端示例（仅实验用）。
 * 具体业务工具的契约不在这里（jit_describe_tools 时动态渲染），任务常量绝不出现。
 *
 * 三种 guidance 模式（Z/P/F ablation，见 r5OffloadingBenchmark.ts 的 --dsl-guidance）：
 * - primitive：只给核心语言参考（下界，R5 primitive-only）；
 * - patterns：核心参考 + 正交组合模式（产品候选；同时启用 composition bindings）；
 * - full-example：核心参考 + 一条端到端示例（上界，旧 9/9 语义）。
 *
 * 防泄漏约束：组合模式只使用通用变量名与 service.* 通用服务名，绝不出现 benchmark 分支工具
 * （github.get_contributor_stats / github.list_commits）与任务常量
 * （query="agent framework" / limit=30 / ratio 阈值 0.15 / score 阈值 100 / take 3）。
 */
export type DslGuidanceMode = "primitive" | "patterns" | "full-example";
/** 生产默认 guidance（Z = 核心语言参考）：最少信息已达 100% offload precision，不默认给模型更多信息。
 *  primitive → production default；patterns → experimental / fallback guidance；full-example → benchmark upper bound only。 */
export declare const DEFAULT_DSL_GUIDANCE: DslGuidanceMode;
/**
 * 核心语言参考：三层语言模型——1. Tool calls（普通工具遵循 Tool Contract）；
 * 2. Array dataflow operators（map/filter/select/compute/sort/take/concat/merge_by_key
 * 消费先前数组变量、生成新数组变量，变量引用同时定义数据依赖）；
 * 3. Return。所有示例只到语句级、互不串联成完整流水线。
 */
export declare const DSL_CORE_REFERENCE: string;
/**
 * R6.2：字段名中立的核心语言参考（compile-only / manifest 臂专用）。
 *
 * 与 DSL_CORE_REFERENCE 的区别：示例里的输出字段名（_.full_name / key="stars" /
 * language="TypeScript" / "stars / forks"）会泄露具体工具的 output 字段映射，
 * 而 R6.2 的 opaque 条件要求"compile-only 组不能看到任何 output mapping"。
 * 这里把示例改成通用变量名与 service.* 通用服务名，只教语法、不泄露任何字段名。
 * 结构与标题段保持不变（测试依赖 "## Agent Execution DSL 参考" / "## 1. Tool calls"）。
 */
export declare const DSL_CORE_REFERENCE_NEUTRAL: string;
/** 返回字段名中立的核心语言参考（compile-only / manifest 臂；不泄露任何 output 字段映射）。 */
export declare function renderNeutralDslReference(): string;
/**
 * 正交组合模式：每个模式只教一种组合概念（绑定 / 分支重组 / 补字段），
 * 互相之间无法拼成 benchmark 的完整答案。只使用通用变量名与 service.* 通用服务名。
 */
export declare const DSL_MICRO_PATTERNS: string;
/**
 * 端到端示例（仅 full-example 模式，ablation 上界）：演示算子如何组合成一条完整流水线。
 * 拓扑与 R5-B 同构（search → map → compute → split → 两路 map → concat → 阈值 select → sort → take → return），
 * 但所有常量与 B 不同（query / limit / ratio 阈值 / score 阈值 / take 数），避免答案直接可复制。
 */
export declare const DSL_FULL_EXAMPLE: string;
/** 按 guidance 模式渲染 DSL 参考（primitive = 核心；patterns = 核心 + 组合模式；full-example = 核心 + 端到端示例）。 */
export declare function renderDslReference(mode: DslGuidanceMode): string;
/**
 * Tool calls 段的两种变体：DSL signature 已 eager 注入到每个 active tool 的 description，
 * 核心参考的 Tool calls 段不再引用 jit_describe_tools（该工具在缺省/compile-only/manifest
 * 臂都不注册）。此选项把该行替换为强调"工具定义中的 DSL signature"的变体，
 * renderDslReference 缺省行为（describe 变体）不变。
 */
export type DslToolContractSource = "describe" | "definitions";
export declare function renderDslReferenceWithSource(mode: DslGuidanceMode, options?: {
    toolContractSource?: DslToolContractSource;
}): string;
