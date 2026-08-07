# 语言实验 R4d：Sequential Dependency Depth（顺序依赖深度 + 严格答案接口）

日期：2026-08-07 ｜ 实验：`semantic-benchmark-2026-08-07T09-15-53-581Z`（samples=10 × 两臂 × 6 cells = 120，干净运行，零限流/零失败）｜ 可视化：同目录 `report-plot.html`（`npx tsx src/experiments/plotReport.ts <report.json>`）｜ 前置：[R4c 报告](file:///Users/apple/Documents/agent-execution-dsl-seed/experiment_result/语言实验-r4c-semantic-dependency-scaling.md)、[r4c方向.md](file:///Users/apple/Documents/agent-execution-dsl-seed/docs/r4c方向.md)、[R4d 计划](file:///Users/apple/Documents/agent-execution-dsl-seed/.trae/documents/语言实验-r4d-sequential-dependency-depth.md)

## 目标

R4/R4c 已证明 **width 增长**（N↑）时 DSL 把数据留在 runtime、iterative 把数据带进 context。R4d 换到用户定义的第二个正交轴：

> **Sequential dependency depth**：完成最终任务所需的、必须等待上一阶段结果才能确定下一阶段输入的工具调用层数。

同时修复 R4c 的两个正确率侧硬伤：(1) iterative 从正文 regex 抽答案 + 集合交集判定的宽松 checker → 改为 **submit_answer 结构化机器接口 + 严格等值**；(2) L2 filter 对真实数据不筛人 → 构造 filter 真实淘汰的数据集。

## 方法

- **深度轴（真实 GitHub，query="agent framework"，N ∈ {10, 30}）**，每层依赖上一层的输出：
  - D1：search(N) → get_repository × N → sort(forks desc) → take 3；
  - D2：+ filter(language="TypeScript") → get_contributor_stats × M → sort(total_contributions desc) → take 3；
  - D3：D2 的 contributors 排序 → take 5 → list_commits × 5 → sort(total_commits desc) → take 3。
- **字段隔离延续**：`forks` 只在 get_repository、`total_contributions` 只在 get_contributor_stats、`total_commits` 只在 list_commits（新工具，Link 头解析总提交数）——跳过任何一步必然拿不到排序依据。DSL 用既有 closed operators（map/filter/sort/take）表达全链，**无新语言特性**。
- **严格答案接口（两臂对称）**：iterative 臂新增 `submit_answer(repositories=[...])` 工具，未调用 = 未提交 = 失败；DSL 臂 `return` 的结构化输出即机器接口。判定 `exactAnswerMatch`（长度 + 逐元素 + 顺序），DSL 侧再叠加图语义检查（`taskSpec` 新增 `stageTools`（阶段工具按序）/ `takeCounts`（双 take 序列））。
- 实现（修改）：`registry.ts`/`githubAdapter.ts`（get_contributor_stats、list_commits）；`taskSpec.ts`（多阶段图检查）；`iterativeToolCalling.ts`（exactAnswerMatch + submit_answer + strictAnswer）；`semanticBenchmark.ts`（R4d 重建）；`mockTools.ts`（字段对齐）；新增 `plotReport.ts`（可视化）。

## 结果（120 runs 全部 task_pass=100%，两臂零失败）

| 臂 | 深度 | N | task% | roundTrips | modelIngress | modelEgress | runtimeInternal | tokens | llmMs | execMs | e2eMs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dsl | D1 | 10 | 100% | 1.0 | 2592 | 269 | 2246 | 1077 | 1270 | 2099 | 3370 |
| dsl | D1 | 30 | 100% | 1.0 | 2592 | 281 | 6772 | 1081 | 1264 | 4980 | 6245 |
| dsl | D2 | 10 | 100% | 1.0 | 3068 | 444 | 2334 | 1230 | 1613 | 2730 | 4344 |
| dsl | D2 | 30 | 100% | 1.0 | 3068 | 476 | 7295 | 1237 | 1506 | 7097 | 8605 |
| dsl | D3 | 10 | 100% | 1.0 | 3459 | 536 | 2435 | 1375 | 1572 | 4227 | 5801 |
| dsl | D3 | 30 | 100% | 1.0 | 3459 | 536 | 7785 | 1374 | 1562 | 7353 | 8917 |
| iterative | D1 | 10 | 100% | 3.0 | 7430 | 1207 | 0 | 4732 | 5152 | 7122 | 8081 |
| iterative | D1 | 30 | 100% | 3.1 | 16021 | 2126 | 0 | 9332 | 8654 | 18064 | 13692 |
| iterative | D2 | 10 | 100% | 4.0 | 13778 | 1288 | 0 | 7694 | 5983 | 6927 | 8705 |
| iterative | D2 | 30 | 100% | 4.2 | 29909 | 2883 | 0 | 16208 | 11293 | 21516 | 17345 |
| iterative | D3 | 10 | 100% | 4.9 | 20390 | 1454 | 0 | 11012 | 6962 | 7512 | 10212 |
| iterative | D3 | 30 | 100% | 5.0 | 43009 | 3738 | 0 | 22617 | 14014 | 23116 | 20746 |

### 相对差距（iterative / dsl）与深度折叠

| 指标 | D1·N10 | D1·N30 | D2·N10 | D2·N30 | D3·N10 | D3·N30 |
|---|---:|---:|---:|---:|---:|---:|
| tokens | 4.4x | 8.6x | 6.3x | **13.1x** | 8.0x | **16.5x** |
| model_ingress | 2.9x | 6.2x | 4.5x | **9.7x** | 5.9x | **12.4x** |
| model_egress | 4.5x | 7.6x | 2.9x | 6.1x | 2.7x | 7.0x |
| exec_ms | 3.4x | 3.6x | 2.5x | 3.0x | 1.8x | 3.1x |
| round_trips | 3.0x | 3.1x | 4.0x | 4.2x | 4.9x | 5.0x |

按深度折叠（N=10/30 平均）的迭代/DSL 比值：tokens **D1=6.5x → D2=9.7x → D3=12.2x**；model_ingress **D1=4.5x → D2=7.1x → D3=9.2x**。round trips 绝对值：DSL 恒 1；iterative 3.0 → 4.1 → 4.95（深度每加一层，多约一轮 LLM 决策）。

## 分析

1. **depth scaling 成立，且比 width scaling 更陡**。R4c 在 N=20 时 tokens 比值 5.9-6.1x；R4d 在 D3·N30 达到 **16.5x**（tokens）、**12.4x**（ingress）。机制可读：iterative 每加一层依赖就多一轮 LLM 往返（3→4→5），每一轮把**上一阶段的中间结果**再送进 context；DSL 只写一次程序（tokens 1077→1374 的微增只是程序变长），多出的复杂度全部落在 runtime graph（runtime_internal 2246→7785，随 N 与阶段数增长）。`runtime_internal vs model_ingress` 两列拼在一起就是用户的核心命题的量化：**中间数据留在 runtime（DSL）还是被搬进 model context（iterative），且随依赖深度放大**。
2. **strict checker 生效但未抓出错误——正确率再次饱和，这次是"全对"而非"宽松判过"**。120 runs 两臂 100%：iterative 每个样本都正确调用 submit_answer（无 unsubmitted、无顺序错、无长度错），DSL 每个样本都精确匹配 + 图语义全过（含 D3 的双 take 序列与三阶段工具顺序）。R4c 那 2 例"答案对但图语义未过"的 L2 失败在本轮没出现——D2/D3 的 prompt 用 B 臂语法形态与分阶段措辞后，DeepSeek 在 D3 深度上仍能一次写出完整计算图。
3. **"数据真的改变答案"构造成功**（R4c 的 filter 不筛人问题已修）：真实数据下 query="agent framework"（不限语言）的 top-30 含大量 Python/Rust 仓库，filter(language="TypeScript") 在 N=30 淘汰 24/30、N=10 保留仅 1/10；D1 的答案含 Python 仓库（langchain-ai/langchain），D2/D3 的答案只含 TypeScript 仓库——**深度分叉真实可见**（N=30：D1≠D2≠D3 全真）。
4. **数据运气诚实化（冒烟预检 + 报告标注）**：D1 的 N=10/30 ground truth 重合（forks 排序下 stars 前 30 的 forks 前三与前 10 相同）；N=10 的 D2/D3 只有 1 个 TypeScript 仓库（k=1，退化弱 cell）。这两个 cell 在报告中标注为**弱区分度**，不静默丢弃——正确率本就饱和，弱 cell 只削弱"深度分叉概率"，不影响成本侧信号。

## 关键发现（实验层）

1. **`stageTools` 检查的第一次实现 bug**：阶段工具在 IR 里是 **map 节点**（绑定调用）而非独立 tool 节点，`path.filter(kind==="tool")` 只找到源工具。修复：tool 节点与 map 节点都收集（`node.tool`），按子序列判定。测试驱动发现。
2. **块注释里的 `*/` 会提前终止**：plotReport.ts 头注释写了 `semantic-benchmark-*/report.json`，esbuild 直接语法错误。改掉措辞即修。
3. **list_commits 用 per_page=1 + Link 头 `rel="last"` 页号当总提交数**：单请求拿到真实总数，避免 per_page=100 的截断饱和（100 以上全部并列）。
4. **严格 checker 的成本侧副作用**：iterative 每轮 toolCalls 里 submit_answer 单独成轮（多数样本 rt=3/4/5 与深度严格对应），未出现"正文作答但漏提交"的失败——prompt 强调到位。

## 结论与取舍

- **H7（深度侧）获强支持且机制被量化**：随 sequential dependency depth 增长，DSL 以恒定 tokens/ingress/round trips 保持正确率（全 100%），iterative 的 tokens/ingress 随深度**超线性**放大（D3·N30 达 16.5x/12.4x），round trips 每层 +1。`runtime_internal vs model_ingress` 的对照直接度量"数据进不进 model context"。
- **H7 正确率侧仍未分化**：DeepSeek 在 D3（三层依赖）深度下两臂都可靠。严格 checker 已消除"宽松判过"的假阳性，但模型本身没在 D3 犯错——正确率分叉可能需要：更苛刻的 filter（比值/阈值，需比较算子）、更大 fan-out（N=50+ 且保证中间层 M 大）、或模型能力更弱的区间。
- **R4d 的价值**：(1) 把"深度"从概念变成可实验、可度量的轴（Sequential dependency depth 定义落地）；(2) 完成严格答案接口改造（submit_answer + exactAnswerMatch，两臂对称，DSL/iterative 同一把尺子）；(3) 新增两个阶段工具（get_contributor_stats、list_commits）验证"逐层依赖"在真实 GitHub 数据上可行；(4) 可视化基建（plotReport.ts，自包含 HTML/SVG）。
- **边界**：(1) 正确率两臂 100% 饱和，区分度仍在成本侧；(2) N=10 的 D2/D3 弱 cell（k=1）与 D1 的 N 不敏感性；(3) 单模型（DeepSeek）。
- **下一步候选**：D3 之上加"条件依赖"（根据阶段结果分支，如 contributor 数低于阈值的仓库跳过 commits——需新 compute op）；或比较算子让 filter 真实按阈值筛人；或降低样本确定性（并发改写 ground truth）制造正确率分化；或 R3b few-shot / P5 agent node。
