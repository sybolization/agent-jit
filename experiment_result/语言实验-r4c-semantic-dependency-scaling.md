# 语言实验 R4c：Semantic Dependency Scaling（filter/sort 语言扩展 + 语义依赖任务）

日期：2026-08-07 ｜ 实验：`semantic-benchmark-2026-08-07T08-47-52-160Z`（samples=10 × 两臂 × 4 cells = 80，干净运行）｜ 前置：R4b（E5，成本侧获支持/正确率饱和）、[r4c方向.md](file:///Users/apple/Documents/agent-execution-dsl-seed/docs/r4c方向.md)

## 目标

R4b 正确率饱和的根因：`get_repository` 的返回值没有参与最终答案（ground truth 直接取自 search 前 k 个名字）。R4c 换任务设计，核心原则：

> **后续工具的返回值必须改变最终答案。**

构造手段是**字段隔离**：`forks` 只由 `get_repository` 返回（search 刻意不带）——"按 forks 排序"物理上不可能用 search 结果直接完成，两臂都必须真调 `get_repository × N`。任务为 `search(N) → get_repository × N → [filter] → sort(forks desc) → take 3`，深度轴 L1（单字段聚合）/ L2（多条件决策：`archived=false AND language="TypeScript"`）× 成本轴 N ∈ {5, 20}。

同时纳入方向文档的三项公平性修复：iterative 臂 `minConsecutiveNoTool` 2→1；同一 completion 的 toolCalls 并行执行（concurrency=5，与 DSL map 对齐）；指标拆分 `model_ingress_bytes / model_egress_bytes / runtime_internal_bytes`。

## 方法

- **DSL 臂首次使用 filter/sort 两个新语言关键字**（R4c = 语言能力压力测试）：`filter(details, archived=false, language="TypeScript")`（等值条件）/ `sort(active, key="forks", desc=true)`（closed operator，不引 expression VM）。编译器新增 `buildFilterNode/buildSortNode`，executor 实现 `compute.filter/sort`（与 oracle 共用 `compareValues`）。
- **ground truth**：真实 `search(limit=N)` → 并行 `get_repository × N` → 确定性 oracle（filter → sort → take → full_name），每 cell 一次快照两臂共用；判定 `required = min(3, groundTruth.length)`（filter 后可能不足 3 个）。
- **DSL 正确率 = 答案命中 AND 计算图语义正确**（`checkTaskCorrectness` 扩展 `filterConditions/sortKey/sortDesc` 检查——filter 条件必须精确、sort key 必须等于 forks、take count、map binding 全对）。
- 实现（新增/修改）：`src/experiments/semanticBenchmark.ts`（R4c benchmark 主文件）；`src/compiler/compiler.ts`、`src/runtime/executor.ts`（filter/sort）；`src/experiments/taskSpec.ts`（语义检查）；`src/runtime/githubAdapter.ts`（get_repository 返回 forks + **限流有界重试**）；`src/experiments/iterativeToolCalling.ts`（公平性修复 + 指标拆分）；`src/runtime/mockTools.ts`（字段对齐）。

## 结果（干净运行：两臂 × 4 cells × 10 样本 = 80，真实 GitHub，无限流污染）

| 臂 | 层级 | N | task% | roundTrips | modelIngress | modelEgress | runtimeInternal | tokens | llmMs | execMs | e2eMs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dsl | L1 | 5 | 100% | 1.0 | 2622 | 256 | 1142 | 1080 | 1256 | 3456 | 4715 |
| dsl | L1 | 20 | 100% | 1.0 | 2623 | 257 | 4599 | 1080 | 1286 | 5717 | 7004 |
| dsl | L2 | 5 | 80% | 1.0 | 2685 | 349 | 1272 | 1117 | 1387 | 3375 | 4763 |
| dsl | L2 | 20 | 100% | 1.0 | 2686 | 368 | 4599 | 1120 | 1401 | 5504 | 6906 |
| iterative | L1 | 5 | 100% | 3.0 | 5074 | 756 | 0 | 3145 | 4110 | 4459 | 6437 |
| iterative | L1 | 20 | 100% | 3.0 | 11054 | 1779 | 0 | 6413 | 7691 | 12538 | 11808 |
| iterative | L2 | 5 | 100% | 3.0 | 5239 | 755 | 0 | 3183 | 4477 | 4902 | 7173 |
| iterative | L2 | 20 | 100% | 3.1 | 12018 | 1962 | 0 | 6852 | 7806 | 12882 | 12096 |

### 相对差距（iterative / dsl）

| 指标 | L1·N5 | L1·N20 | L2·N5 | L2·N20 |
|---|---:|---:|---:|---:|
| tokens | 2.9x | **5.9x** | 2.8x | **6.1x** |
| model_ingress | 1.9x | **4.2x** | 2.0x | **4.5x** |
| model_egress | 3.0x | **6.9x** | 2.2x | **5.3x** |
| exec_ms | 1.3x | 2.2x | 1.5x | 2.3x |
| e2e_ms | 1.4x | 1.7x | 1.5x | 1.8x |
| round_trips | 3.0x | 3.0x | 3.0x | 3.1x |

## 分析

1. **成本侧：H7 获强支持，且机制被"三拆分"直接证实**。
   - `model_ingress_bytes`：DSL 恒定 ~2620（prompt 面，不随 N 增长）；iterative 5074 → 12018（N=20 时 **4.5x**）——中间数据每轮重新进 context 的累积。
   - `runtime_internal_bytes`：DSL 1142 → 4599（中间数据留在 runtime 的量，随 fan-out 增长 4x）；iterative **恒 0**（中间数据 100% 经过模型 context）。这两列拼在一起就是 R4b 结论的度量化：**"数据进不进模型 context"是两种架构的本质差异**。
   - `tokens`：DSL 恒定 ~1080-1120（模型只写一次程序）；iterative 3145 → 6852（N=20 时 **5.9-6.1x**）。
2. **正确率侧：干净运行下未分化**（iterative 全 100%，DSL 100/100/80/100）。"语义依赖"构造成功（两臂都真调了 get_repository，答案确实依赖 forks），但 DeepSeek 在 L1/L2 这个推理深度上足够可靠——context 里做 filter+sort 不出错。这与 R4b 的"easy-regime 饱和"不同：现在是"medium 难度 + 模型可靠"。
3. **唯一的正确率信号：DSL L2·N5 = 80%**。2/10 样本程序**编译通过、答案正确（与 ground truth 一致）、但图语义检查未过**——模型没有完整表达 filter 步骤（或条件形态不精确）。答案正确是因为该 query 的前 3 个 repo 恰好都满足 filter（真实数据没筛掉人），属于"数据巧合救回答案"。这暴露了 DSL 臂正确率的下限来自**模型是否完整表达计算图**，而不是 runtime——正是 R4c 语言压力测试想测的东西。
4. **公平性修复生效且副作用被观察到**：`minConsecutiveNoTool=1` 使 iterative round trips 从 R4b 的 ~4.0 降到 ~3.0（3 = search + 一批并行 get_repository + 答案）；toolCalls 并行使 exec_ms 差距从 R4b 的 4.0x 收窄到 2.2x。副作用：被限流污染的 run 里出现 rt=2 的"提前收尾"样本（模型在中间无工具轮被终止，拿不到答案）——干净运行下未出现，但风险真实存在。

## 关键发现与修复（实验层）

1. **限流污染（本轮最重要的教训）**：80 次 run 全部使用**完全相同**的 search query，短时间内触发 GitHub 搜索 API 403/429（`remaining=0`）。前两次完整运行全部被污染——DSL 臂 `ok=false` 的样本 error 字段全部是 403；iterative 臂失败样本的 `final_text` 全是"搜索工具被限流"。**修复**：(a) adapter 的 `getJson` 加**有界重试**（403/429 → 读 `x-ratelimit-reset` 等待，上限 15s、重试 2 次，reset 远在未来不挂死）；(b) benchmark 加 `--pacing=1000`（样本间间隔，降低相同 query 频率）。第三次运行零限流错误。
2. **错误与文本记录**：`ok=false` 的 DSL 样本现在记录 `error`；iterative 样本记录 `final_text`——否则限流污染根本无从诊断（第一次运行的失败原因只能靠推测）。
3. **filter 条件是模型最易错点**（语言压力测试的信号）：离线诊断显示模型在 L2 上倾向幻觉 `field=lit(...)`、`q=` 等不存在语法（编译期诊断拦截），或写成 `field=_.archived, lit=false` 的错误形态。DSL 的编译器 + 图语义检查两层防线把这类错误从"静默错答案"变成"显式失败"。

## 结论与取舍

- **H7 成本侧获支持（且机制可度量）**：随计算深度与 fan-out 增加，DSL 以恒定 tokens/ingress 保持正确率，iterative 的 context 膨胀线性增长（tokens 5.9-6.1x、model_ingress 4.2-4.5x、model_egress 5.3-6.9x @ N=20）。`runtime_internal vs model_ingress` 的三拆分直接量化了"数据进不进模型 context"。
- **H7 正确率侧在 L1/L2 未获支持**：DeepSeek 在该推理深度下两臂都可靠。"语义依赖"是必要条件但非充分条件——需要更高计算深度（L3 多阶段依赖 fanout / 更严格的 filter 条件）才能让正确率分叉。
- **R4c 的价值**：(1) 完成了 filter/sort 语言扩展（closed operators，IR schema 无需改）；(2) 证明"困难 case"的构造方法是**字段隔离**而非更大 N；(3) 测出 DSL 臂正确率的下限由"模型表达计算图的完整性"决定；(4) 暴露并修复了真实 GitHub benchmark 的限流脆弱性。
- **边界**：(1) 正确率两臂大体饱和，区分度仍在成本侧；(2) L2 的 filter 对真实数据几乎不筛人（前 3 个 repo 都满足条件），"filter 真的改变答案"的 harder case 需要换 query 或加 L3；(3) 只测了 DeepSeek 单模型。
- **下一步候选**：L3 多阶段依赖 fanout（filter 后对 top-M 再 map contributors 并按贡献者数据重排，需新 compute op）；或换更严的 filter 条件（如 `forks/stars` 比值、`open_issues` 阈值）让 filter 真实筛人；或 R3b few-shot / P5 agent node。
