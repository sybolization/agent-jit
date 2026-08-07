# 语言实验 R4b：Programmatic Tool Calling（DSL 一次提交）vs Traditional（迭代工具调用）

日期：2026-08-07 ｜ 实验：`programmatic-benchmark-2026-08-07T08-11-18-243Z`（samples=10 × 两臂 × 4 档 = 80）｜ 前置：R4（真实 GitHub adapter + 传输协议）、H6 假设

## 目标

R1-R4 验证的是"LLM 能否生成 DSL 程序"（语言侧）。R4b 换一个正交问题：**给定同一个任务，两条执行架构随工具图复杂度的成本曲线**：

- **DSL 臂**：一次 `submit_program(source)` + deterministic runtime 调度（map fan-out / 并发 / join 全部在运行时完成，模型只写程序）；
- **Traditional 臂**：迭代工具调用 agent loop（`LLM → tool → LLM → tool → …`，模型每步决定调什么、怎么调）。

> **H6**：随工具图复杂度（fan-out N）增加，DSL 显著降低 round trips / exposed bytes / tokens / latency，同时保持 task correctness。

## 方法

- **任务集**：真实 GitHub，`search_repositories("agent framework language:typescript")` 取前 N 个仓库，逐仓库 `get_repository` 取详情，最终返回前 k 个（k=min(3,N)）。N ∈ {2, 5, 10, 20} 四档梯度。
- **ground truth**：实验开始前用真实 search API 拉一次（每档 limit=N），取前 k 个 `full_name`，两臂共用同一基准；正确性 = 模型答案与 ground truth 的集合交集 ≥ k（不看顺序）。
- **公平性**：同模型（deepseek-chat）、同真实 GitHub 后端、同 prompt 面（工具目录同源渲染）。
- **指标**：`round_trips`（complete 调用次数）、`exposed_bytes`（喂给模型的中间数据字节）、`usage`（input/output/cacheRead/totalTokens）、`llm_ms` / `e2e_ms`、`task_pass`。
- **实现**（新增）：
  - `src/experiments/iterativeToolCalling.ts`：传统臂 agent loop（无内置 loop helper，手写循环：complete → 执行 toolCalls → toolResult 回填 → 连续 2 轮无工具调用即结束，`maxSteps` 兜底）。
  - `src/experiments/programmaticBenchmark.ts`：任务梯度 / ground truth 生成 / DSL 臂 runner / 汇总与 report.json。
  - `tests/iterativeToolCalling.test.ts`（12 用例）+ `tests/programmaticBenchmark.test.ts`（6 用例）：mock gateway 注入验证消息累积/结束条件/指标；mock fetch 验证 ground truth 取数与排序。

## 结果（两臂 × 4 档 × 10 样本 = 80，真实 GitHub）

| 臂 | N | task% | roundTrips | exposedBytes | tokens | llmMs | e2eMs |
|---|---|---|---:|---:|---:|---:|---:|
| dsl | 2 | 100% | 1.0 | 373 | 942 | 1170 | 2528 |
| dsl | 5 | 100% | 1.0 | 459 | 941 | 1081 | 2644 |
| dsl | 10 | 100% | 1.0 | 462 | 942 | 1059 | 3239 |
| dsl | 20 | 100% | 1.0 | 461 | 941 | 1117 | 4711 |
| iterative | 2 | 100% | 4.5 | 454 | 4030 | 4509 | 6355 |
| iterative | 5 | 100% | 4.0 | 1077 | 4312 | 4834 | 8430 |
| iterative | 10 | 100% | 4.0 | 2195 | 5998 | 5512 | 11769 |
| iterative | 20 | 100% | 4.0 | 4196 | 8904 | 7393 | 18844 |

### 相对差距（iterative / dsl，N=20 时）

| 指标 | N=2 | N=5 | N=10 | N=20 |
|---|---:|---:|---:|---:|
| tokens | 4.3x | 4.6x | 6.4x | **9.5x** |
| exposed_bytes | 1.2x | 2.3x | 4.8x | **9.1x** |
| llm_ms | 3.9x | 4.5x | 5.2x | **6.6x** |
| e2e_ms | 2.5x | 3.2x | 3.6x | **4.0x** |
| round_trips | 4.5x | 4.0x | 4.0x | 4.0x |

## 分析

1. **task correctness 两臂全 100%——正确率饱和，无法用正确率区分两臂**（与 R4 单链 toy 任务饱和一致）。H6 的证据在成本侧，不在正确率侧。

2. **round trips 不是线性瓶颈——修正计划假设**。计划时预期"传统臂 round trips 随工具数线性增长"，实测恒定 ~4（1 次 search + 1-2 批并行 get_repository + 收尾）。原因是 OpenAI/DeepSeek 支持**单轮并行工具调用**：模型一次 complete 可发出多个 get_repository。真正的分化在 context 膨胀。

3. **核心分化：context 膨胀随 N 线性增长，DSL 恒定**。
   - tokens：DSL 恒定 941（只回传程序 + 结果）；iterative 4030 → 8904（每轮把全部历史重新喂给模型，toolResult 数据反复计入 input）。N=20 时 **9.5x**。
   - exposed_bytes：DSL 恒定 ~460；iterative 454 → 4196（**9.1x**），因为每个 get_repository 的完整 JSON 都进 context 且随轮次累积。
   - 这一条的机制解释：**DSL 臂把"数据怎么流通"编译成确定性 IR，模型只写意图；传统臂把中间数据全部暴露给模型，由模型无差别消费。**

4. **llm_ms / e2e_ms 同样分化**：llm_ms 6.6x（长 context 的生成成本）、e2e_ms 4.0x（DSL 臂的 runtime 并行 fan-out 抵消了部分差距——DSL 的 map 并发执行 N 个 get_repository，而 iterative 受模型逐批调度约束）。

## 关键发现与修复（实验层）

1. **pi-ai 工具名不允许 "."——带点工具名被静默丢弃**：`github.search_repositories` 作为工具定义传给 pi-ai 时 complete 短路（~150ms 返回空 content/空 toolCalls/0 tokens），`echo` 正常。根因是 OpenAI 兼容工具名规范不允许点号。修复：`toPiToolName` 把 `.` 映射为 `_`（prompt 目录 / 工具定义 / 执行反查三处同步）。**教训：pi-ai 对非法工具名是静默降级而非报错，冒烟阶段必须检查 tokens > 0，否则会拿到"假全对"的空数据。**
2. **答案提取的 URL 污染**：`extractFullNames` 初版正则会把 `https://github.com/owner/repo` 的域名段 `github.com/owner` 当答案。修复：先剥协议+域名再匹配，path 中的 `owner/repo` 仍可提取。

## 结论与取舍

- **H6 获支持（成本侧）**：随 fan-out 增加，DSL 以恒定成本保持正确率（tokens/exposed_bytes 恒定 ~941/~460），传统臂成本线性增长（N=20 时 9.5x / 9.1x）。
- **正确的表述修正**：对比实验的胜负手不是"round trips 随工具数线性增长"（并行工具调用削弱了这条），而是 **"中间数据是否进入模型 context"**——DSL 的 runtime 用确定性调度消费数据，传统臂用模型逐轮消费。这比 round trips 更本质，也更贴近 P5 agent node 的输入规模控制动机。
- **边界**：(1) 任务正确率饱和，两臂都太简单，区分度只在成本指标；(2) N=10/20 档的 ground truth 只取前 3（k=min(3,N)），但模型仍需处理全部 N 个仓库的中间数据——梯度体现在成本而非正确率；(3) 真实 search 排序随 repo 变动，两臂共用同一 ground truth 快照，公平性不受影响。
- **下一步候选**：把 fan-out 梯度推向更高 N（40/80）观察成本曲线是否持续线性；或转向"正确率有区分度"的任务（多跳依赖、条件分支），让 DSL 的确定性调度在正确率侧也产生差异。
