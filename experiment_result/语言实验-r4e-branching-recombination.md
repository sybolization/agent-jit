# 语言实验 R4e：Branching + Recombination（分支 + 数据重组，mock adversarial dataset）

日期：2026-08-07 ｜ 实验：`r4e-benchmark-2026-08-07T09-48-39-642Z`（正式，samples=10 × 两臂 × 2 cells = 40 runs，mock 数据，两臂 100%）＋ `r4e-benchmark-2026-08-07T09-42-36-300Z`（首轮，契约模糊版，DSL 70%/50%）｜ 前置：[R4d 报告](file:///Users/apple/Documents/agent-execution-dsl-seed/experiment_result/语言实验-r4d-sequential-dependency-depth.md)、[R4e 计划](file:///Users/apple/Documents/agent-execution-dsl-seed/.trae/documents/语言实验-r4e-branching-recombination.md)

## 目标

R4d 证明了 sequential dependency depth 的成本放大但正确率饱和（两臂 120/120）——因为 D3 是"深而直的流水线"，每层都告诉模型做什么。R4e 换复杂度类型（用户定义）：

> **Branching + recombination**：前面的结果决定后面走哪条路，最后把多条路径的数据重新组合。不是"多了一步"，而是模型必须保持三个东西不出错——**分支判断**（哪个 repo 调哪个工具）、**身份对应**（工具结果对应回正确 repo）、**重新合并**（两路不同数据统一 score）。

难度轴（本轮起同时记录）：Dependency depth=4（details→分支决策→阶段工具→join→最终计算）；Branching factor=2（ratio>0.15→contributors，否则→commits）；Recombination burden=3（details+两路 score 按 full_name 合并）；State cardinality=N×(ratio+分组+score)。

**数据后端：可控 mock/adversarial dataset**（用户明确要求），保证"分错一次支 / 漏掉 join / 用错一个字段 / 漏掉阈值 → 答案一定变化"（tests/mockTools.test.ts 逐条置换断言验证）。

## 方法

- **任务**：search(N) → get_repository × N → compute ratio=forks/stars → select 分支（ratio>0.15 / ratio≤0.15）→ contributors 路径调 get_contributor_stats、commits 路径调 list_commits（**两路都返回同名字段 score**，统一可比尺度）→ join 回 details（key=full_name）→ select(score≥100) → sort(score desc) → take 3。N∈{15,30}。
- **语言扩展（R4e = 语言能力压力测试）**：`compute(<源>, <字段>="<算术表达式>")`（元素级字段计算）、`select(<源>, "<比较谓词>")`（谓词过滤，filter 的推广）、`join(<源1>, <源2>, …, key="<字段>")`（多输入按 key 合并字段）。表达式用**字符串字面量**（tokenizer/parser 零改动），compiler 预解析（写错 → 编译诊断 → repair 可修）；executor 与 oracle 共用 `evalExpr`（受限白名单：字段引用+四则+比较）。
- **图语义检查扩展**：`taskSpec` 新增 `computeExprs`（期望字段=表达式）、`selectPreds`（期望谓词）、`joinSpec`（key/sources 数量/分支工具集合），在 return 可达闭包（含 join 全部分支）上检查。
- **strict checker 沿用**：iterative 必须 submit_answer + exactAnswerMatch；DSL = 精确匹配 AND 图语义。

## 结果（正式运行 40 runs：两臂 task 全 100%，零失败）

| 臂 | N | task% | roundTrips | modelIngress | modelEgress | runtimeInternal | tokens | llmMs | e2eMs |
|---|---|---|---|---|---|---|---|---|---|
| dsl | 15 | 100% | 1.0 | 4359 | 765 | 2273 | 1667 | 1942 | 1945 |
| dsl | 30 | 100% | 1.3 | 5943 | 1167 | 4570 | 2291 | 2804 | 2807 |
| iterative | 15 | 100% | 4.0 | 16328 | 3427 | 0 | 11497 | 12820 | 12820 |
| iterative | 30 | 100% | 4.1 | 25154 | 6212 | 0 | 18653 | 21471 | 21471 |

相对差距（iterative/dsl）：tokens **N=15: 6.9x / N=30: 8.1x**；model_ingress **3.7x / 4.2x**；model_egress 4.5x / 5.3x；round_trips 4.0x / 3.2x。DSL 侧 runtime_internal 随 N 增长 2273→4570（分支+join 的中间数据全留 runtime），iterative 恒 0（全部经 model context）。

## 关键发现（本轮的完整故事，两次运行）

1. **正确率分化的第一个真实信号 = 信息不对称，不是计算难度本身**。首轮运行（工具契约描述只写"贡献者统计/提交统计"，未写返回字段）下 **DSL 70%/50% vs iterative 100%**——iterative 臂第一次在 benchmark 里全面压过 DSL。但逐样本诊断（DSL 样本记录了 program + correctness_failures）显示 8/8 失败全是同一根因：**模型在写程序时幻觉工具返回字段**（写 `compute(score="total_contributions")`，而 mock 契约返回 `{full_name, score}`）→ 执行出 NaN → 答案空。iterative 臂每轮都能看到工具**实际返回**，天然免疫这类错误。这是"DSL 一次声明"架构的代价面：**模型必须精确"记住"工具契约，iterative 有运行时反馈**。
2. **修复信息基线后正确率再次饱和**：给 registry 工具描述写清返回 schema（`{full_name, score}`，两路同尺度）+ 修复 joinSpec 检查器的误判（模型正确做二次 join 时，检查器 `find(join)` 找到第二个 join 而非分支 join，误报"缺少分支工具"——改为存在性匹配）→ 重新运行 **DSL 两档 100%**，且 round_trips 1.0-1.3（模型能一次写对含 compute/select/join 的完整图，个别样本靠 repair 修正）。DeepSeek 在"分支判断 + 身份对应 + 重新合并"这个复杂度上两臂都可靠。
3. **成本侧分化持续放大，且机制更清晰**：tokens 6.9-8.1x、ingress 3.7-4.2x；iterative 的 4 轮往返 = search → details → 两路分支工具 → submit_answer，每一轮把中间数据重新送 context；DSL 1 次往返，复杂度全部落在 runtime（runtime_internal 2273→4570）。
4. **语言压力测试的真实产出**：compute/select/join 三个新关键字模型能学会（契约清晰后一次写对），但**首轮的契约敏感暴露了 DSL 的信息瓶颈**——这是 R4e 相比 R4c/R4d 的新证据：正确率差异不是"模型不会写程序"，而是"模型没有运行时反馈时必须精确预测数据契约"。

## 关键修复（实验层）

1. **joinSpec 检查器误判**：`reachable.find(join)` 找第一个 join，但模型可能做二次 join（分支 join 后再把 score 合并一次）→ 误报。修复：存在性匹配（任一 join 满足 key+sources 数量+分支工具即通过）。测试驱动发现。
2. **DSL 样本诊断缺口**：DSL 失败样本只记 task_pass，看不到程序/失败原因。修复：DslArmResult 记录 `program` + `correctness_failures`——没有它，首轮的契约敏感根本无法诊断。
3. **工具契约不透明**：registry 描述未写返回字段 → 模型幻觉。修复：description 明确 `{full_name, score}` 及两路同尺度。这是**实验公平性**修复（两臂信息基线对齐），不是给 DSL 作弊——iterative 仍能读运行时返回。
4. **阈值对 top-3 数学上恒冗余的发现**：`s3 < T ≤ s4` 与 `s3 ≥ s4` 矛盾——阈值只在"过阈值者 < 3"时改变答案。数据设计据此调整：N=15 过阈值者恰好 2 个（GT 长度 2，漏阈值 → 长度 3 → 答案必变）；N=30 加 repo-17 过阈值（GT 长度 3，N 梯度分叉）。诚实记录：N=30 的阈值由图语义检查强制（答案层面与 N=15 的阈值必要性不同）。

## 结论与取舍

- **H7（分支+重组）成本侧获支持，正确率侧仍饱和**：mock adversarial 数据验证了"每步必要"（置换断言全过），但 DeepSeek 在信息基线一致时两臂都能正确处理分支+join+阈值（40/40）。**正确率分化的必要条件不是任务变难，而是两臂信息不对称**——首轮数据（DSL 70/50 vs iterative 100）是这一命题的直接证据。
- **R4e 的价值**：(1) 完成 compute/select/join 语言扩展（表达式字符串，受限白名单，IR 新增 JoinNode，多输入调度验证）；(2) mock adversarial dataset 方法论落地（可控、可复现、每步必要可断言）；(3) **第一次让 iterative 在正确率上压过 DSL**（首轮，契约模糊版），并把根因定位到"信息不对称"而非计算难度；(4) 4 难度轴显式记录。
- **边界**：(1) 正式运行正确率饱和，主结论落在成本侧 + 契约敏感性；(2) mock 数据无真实 API 随机性；(3) 单模型（DeepSeek）。
- **下一步候选**：让"信息不对称"成为实验变量本身（工具目录 vs 运行时反馈的系统性对比，即"契约模糊 × 深度"网格）；或把阈值/分支做进**运行期决策**（模型在 DSL 里写不死的条件，如运行时外部配置）；或增大 State cardinality（N=50+，iterative 的 context 失控点）；或 R3b few-shot / P5 agent node。
