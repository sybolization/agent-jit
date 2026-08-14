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
/** 生产默认 guidance（Z = 核心语言参考）：最少信息已达 100% offload precision，不默认给模型更多信息。
 *  primitive → production default；patterns → experimental / fallback guidance；full-example → benchmark upper bound only。 */
export const DEFAULT_DSL_GUIDANCE = "primitive";
/**
 * 核心语言参考：三层语言模型——1. Tool calls（普通工具遵循 Tool Contract）；
 * 2. Array dataflow operators（map/filter/select/compute/sort/take/concat/merge_by_key
 * 消费先前数组变量、生成新数组变量，变量引用同时定义数据依赖）；
 * 3. Return。所有示例只到语句级、互不串联成完整流水线。
 */
export const DSL_CORE_REFERENCE = [
    "## Agent Execution DSL 参考（仅随首次 describe 返回一次）",
    "程序是 newline 分隔的语句序列：<变量> = <调用>(...)，最后一行必须是 return <变量>。",
    "",
    "## 1. Tool calls",
    "普通工具调用遵循随 active tool 提供的 DSL signature：参数名、参数类型与返回类型由签名决定，不得自创参数。",
    "函数式签名示例：service.lookup(key: str) -> {id: str, score: int}",
    "",
    "例：",
    "repos = github.search_repositories(",
    "    query=\"example\",",
    "    limit=10",
    ")",
    "",
    "工具 id 两种写法等价：github.search_repositories 与 github_search_repositories。",
    "",
    "## 2. Array dataflow operators",
    "map / filter / select / compute / sort / take / concat / merge_by_key / collect",
    "",
    "这些操作消费先前产生的数组变量，并生成新的数组变量；变量引用同时定义数据依赖。",
    "",
    "- map(列表, 工具(参数=_.字段))：对列表每个元素执行一次工具调用，返回结果数组。_.字段 引用当前元素字段。",
    "  例：details = map(repos, github.get_repository(full_name=_.full_name))",
    "- take(列表, N)：截取前 N 条。例：top = take(details, 5)",
    '- sort(列表, key="字段", desc=true)：按字段排序（默认升序）。例：ranked = sort(details, key="stars", desc=true)',
    '- filter(列表, 字段=值)：保留"字段 等于 值"的元素（等值过滤）。例：ts = filter(details, language="TypeScript")',
    '- compute(列表, 新字段="表达式")：给每个元素计算新字段（表达式 = 字段引用 + 数字 + 四则运算 + 括号）。例：r = compute(details, density="stars / forks")',
    '- select(列表, "谓词")：按比较谓词（> >= < <= == !=）过滤。例：hot = select(r, "density > 0.3")',
    '- merge_by_key(基准列表, 附加列表..., key="字段")：给每条基准记录附加另一批数据的字段（基准已有字段不覆盖），不是对称合并。',
    "  例：enriched = merge_by_key(users, ratings, key=\"user_id\")",
    "- concat(列表1, 列表2, ...)：按顺序把多个列表拼成一个大列表（真正的列表拼接）。例：both = concat(left, right)",
    "- collect(值1, 值2, ...)：把任意值（对象 / 数组 / 标量）按顺序包成一个新数组。例：both = collect(a, b)",
    "- 字段投影：引用处写 变量.字段 取出对象的一个字段（多级 a.b.c；数组字段可直接接 take / filter / map；若存在同名含点变量则精确变量名优先）。例：top = take(files.paths, 3)",
    "",
    "## 3. Return",
    "程序最后使用：",
    "return variable",
    "",
    "注意：上面示例中的查询词 / 截取数 / 阈值只是演示语法，不代表任何任务的真实参数。",
].join("\n");
/**
 * R6.2：字段名中立的核心语言参考（compile-only / manifest 臂专用）。
 *
 * 与 DSL_CORE_REFERENCE 的区别：示例里的输出字段名（_.full_name / key="stars" /
 * language="TypeScript" / "stars / forks"）会泄露具体工具的 output 字段映射，
 * 而 R6.2 的 opaque 条件要求"compile-only 组不能看到任何 output mapping"。
 * 这里把示例改成通用变量名与 service.* 通用服务名，只教语法、不泄露任何字段名。
 * 结构与标题段保持不变（测试依赖 "## Agent Execution DSL 参考" / "## 1. Tool calls"）。
 */
export const DSL_CORE_REFERENCE_NEUTRAL = [
    "## Agent Execution DSL 参考（核心语言语义）",
    "程序是 newline 分隔的语句序列：<变量> = <调用>(...)，最后一行必须是 return <变量>。",
    "",
    "## 1. Tool calls",
    "普通工具调用遵循随 active tool 提供的 DSL signature：参数名、参数类型与返回类型由签名决定，不得自创参数。",
    "函数式签名示例：service.lookup(key: str) -> {id: str, count: int}",
    "",
    "例：",
    "items = service.search(",
    "    query=\"example\",",
    "    limit=10",
    ")",
    "",
    "工具 id 两种写法等价：service.search 与 service_search。",
    "",
    "## 2. Array dataflow operators",
    "map / filter / select / compute / sort / take / concat / merge_by_key / collect",
    "",
    "这些操作消费先前产生的数组变量，并生成新的数组变量；变量引用同时定义数据依赖。",
    "",
    "- map(列表, 工具(参数=_.字段))：对列表每个元素执行一次工具调用，返回结果数组。_.字段 引用当前元素字段。",
    "  例：details = map(items, service.get_detail(id=_.id))",
    "- take(列表, N)：截取前 N 条。例：top = take(details, 5)",
    '- sort(列表, key="字段", desc=true)：按字段排序（默认升序）。例：ranked = sort(details, key="field", desc=true)',
    '- filter(列表, 字段=值)：保留"字段 等于 值"的元素（等值过滤）。例：ts = filter(details, field="value")',
    '- compute(列表, 新字段="表达式")：给每个元素计算新字段（表达式 = 字段引用 + 数字 + 四则运算 + 括号）。例：r = compute(details, density="field_a / field_b")',
    '- select(列表, "谓词")：按比较谓词（> >= < <= == !=）过滤。例：hot = select(r, "density > 0.3")',
    '- merge_by_key(基准列表, 附加列表..., key="字段")：给每条基准记录附加另一批数据的字段（基准已有字段不覆盖），不是对称合并。',
    "  例：enriched = merge_by_key(users, ratings, key=\"user_id\")",
    "- concat(列表1, 列表2, ...)：按顺序把多个列表拼成一个大列表（真正的列表拼接）。例：both = concat(left, right)",
    "- collect(值1, 值2, ...)：把任意值（对象 / 数组 / 标量）按顺序包成一个新数组。例：both = collect(a, b)",
    "- 字段投影：引用处写 变量.字段 取出对象的一个字段（多级 a.b.c；数组字段可直接接 take / filter / map；若存在同名含点变量则精确变量名优先）。例：top = take(files.paths, 3)",
    "",
    "## 3. Return",
    "程序最后使用：",
    "return variable",
    "",
    "注意：上面示例中的查询词 / 截取数 / 阈值只是演示语法，不代表任何任务的真实参数。",
].join("\n");
/** 返回字段名中立的核心语言参考（compile-only / manifest 臂；不泄露任何 output 字段映射）。 */
export function renderNeutralDslReference() {
    return DSL_CORE_REFERENCE_NEUTRAL;
}
/**
 * 正交组合模式：每个模式只教一种组合概念（绑定 / 分支重组 / 补字段），
 * 互相之间无法拼成 benchmark 的完整答案。只使用通用变量名与 service.* 通用服务名。
 */
export const DSL_MICRO_PATTERNS = [
    "## 4. Composition patterns（组合模式）",
    "",
    "三个模式相互正交：每个只教一种组合概念；真实任务按数据流形状自行选用。",
    "",
    "### Pattern A: Fan-out — 数组元素字段绑定到工具参数",
    "details = map(",
    "    items,",
    "    service.get_detail(id=_.id)",
    ")",
    "",
    "### Pattern B: Split + recombine — 按谓词分支，各分支独立处理后再拼接",
    'positive = select(items, "value > 0")',
    'negative = select(items, "value <= 0")',
    "",
    "a = map(",
    "    positive,",
    "    service.process_a(id=_.id)",
    ")",
    "",
    "b = map(",
    "    negative,",
    "    service.process_b(id=_.id)",
    ")",
    "",
    "processed = concat(a, b)",
    "",
    "### Pattern C: Enrichment — 给已有实体补字段",
    "ratings = map(",
    "    users,",
    "    service.get_rating(user_id=_.user_id)",
    ")",
    "",
    "enriched = merge_by_key(",
    "    users,",
    "    ratings,",
    '    key="user_id"',
    ")",
    "",
    'merge_by_key(base, overlays..., key=...) 保留 base 中的记录集合，按 key 将 overlay 字段附加到对应 base record。它不是列表 union。',
    "",
    "选择判断：",
    "- 我要重新汇合两批结果 → concat",
    "- 我要给已有实体补字段 → merge_by_key",
].join("\n");
/**
 * 端到端示例（仅 full-example 模式，ablation 上界）：演示算子如何组合成一条完整流水线。
 * 拓扑与 R5-B 同构（search → map → compute → split → 两路 map → concat → 阈值 select → sort → take → return），
 * 但所有常量与 B 不同（query / limit / ratio 阈值 / score 阈值 / take 数），避免答案直接可复制。
 */
export const DSL_FULL_EXAMPLE = [
    "## 4. Full workflow example（一条端到端流水线，演示算子如何组合）",
    "",
    'repos = github.search_repositories(query="example framework", limit=20)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'ratio = compute(details, ratio="forks / stars")',
    'high = select(ratio, "ratio > 0.2")',
    'low = select(ratio, "ratio <= 0.2")',
    "high_scores = map(high, github.get_contributor_stats(full_name=_.full_name))",
    "low_scores = map(low, github.list_commits(full_name=_.full_name))",
    "all = concat(high_scores, low_scores)",
    'good = select(all, "score >= 50")',
    'ranked = sort(good, key="score", desc=true)',
    "top = take(ranked, 5)",
    "return top",
    "",
    "注意：这只是演示如何把算子组合成端到端流水线，参数不代表任何任务的真实参数。",
].join("\n");
/** 按 guidance 模式渲染 DSL 参考（primitive = 核心；patterns = 核心 + 组合模式；full-example = 核心 + 端到端示例）。 */
export function renderDslReference(mode) {
    switch (mode) {
        case "primitive":
            return DSL_CORE_REFERENCE;
        case "patterns":
            return `${DSL_CORE_REFERENCE}\n\n${DSL_MICRO_PATTERNS}`;
        case "full-example":
            return `${DSL_CORE_REFERENCE}\n\n${DSL_FULL_EXAMPLE}`;
    }
}
const DESCRIBE_TOOL_CALLS_LINE = "普通工具调用遵循随 active tool 提供的 DSL signature：参数名、参数类型与返回类型由签名决定，不得自创参数。";
const DEFINITIONS_TOOL_CALLS_LINE = "普通工具调用遵循工具定义（Tool Contract）中的 DSL signature：参数名、参数类型与返回类型由签名决定，不得自创参数。";
export function renderDslReferenceWithSource(mode, options = {}) {
    const core = options.toolContractSource === "definitions"
        ? DSL_CORE_REFERENCE.replace(DESCRIBE_TOOL_CALLS_LINE, DEFINITIONS_TOOL_CALLS_LINE)
        : DSL_CORE_REFERENCE;
    switch (mode) {
        case "primitive":
            return core;
        case "patterns":
            return `${core}\n\n${DSL_MICRO_PATTERNS}`;
        case "full-example":
            return `${core}\n\n${DSL_FULL_EXAMPLE}`;
    }
}
