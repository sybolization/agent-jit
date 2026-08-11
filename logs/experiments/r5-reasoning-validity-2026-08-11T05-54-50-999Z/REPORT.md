# R5.1a Reasoning OFF vs ON Observation Validity 实验报告

- **实验目录**：`logs/experiments/r5-reasoning-validity-2026-08-11T05-54-50-999Z/`
- **时间**：2026-08-11（Asia/Shanghai）
- **模式**：`r5-reasoning-validity`（`npm run experiment:r5-reasoning-validity -- --samples=30`）

## 1. 实验目标（方法论问题）

确认 **开启 reasoning 本身是否改变 Agent 的 JIT 决策行为**。若 ON 显著更早 JIT，则 CoT 只能解释
reasoning-enabled Agent，不能直接作为原始（OFF）Agent 的因果证据——先把"观测工具是否改变被观测对象"
验证干净，再谈用 CoT 诊断 offload boundary。

## 2. 实验设计

**固定变量**（与 R5 treatment 完全一致，唯一变量 = reasoning）：

| 变量 | 值 |
|---|---|
| Task | B（repo-score-pipeline） |
| Arm | treatment |
| DSL guidance | primitive |
| Policy | current |
| Model | deepseek-chat（OFF/ON 同一个 model id） |
| Max rounds | 10 |

**唯一变量**：`reasoning = false` vs `reasoning = true`（DeepSeek thinking 模式，`thinking:{type:"enabled"}` + `reasoning_effort`，thinkingLevel=medium）。

**设计**：`--samples=30` = 30 pairs × 2 arms = 60 runs；交替执行（pair 奇数 OFF→ON，偶数 ON→OFF），
抵消时间顺序偏差；稳定 runId `off-001/on-001…`；raw CoT 按 arm 分文件（各自带 meta 首行），
report 不含思维链原文。

## 3. 结果（OFF vs ON，各 30 runs）

| 指标 | OFF | ON |
|---|---|---|
| adoption | 97% | 100% |
| jitSemanticCorrect | 93% | 97% |
| offloadPrecision | 97% | 97% |
| taskCompleted | 97% | 97% |
| **avgOffloadDecisionRound** | **1.7** | **1.1** |
| **preOffloadPipeline avg / median / p90 / max** | **2.7 / 1 / 1 / 31** | **1.1 / 0 / 0 / 31** |
| sameRoundBusinessCallRate | 37% | 10% |
| fallbackRate | 0% | 0% |
| avgRounds | 4.8 | 4.2 |
| avgTokens | 15,104 | 14,197 |
| avgLatencyMs | 13,143 | 14,698 |

## 4. 关键读数

- **ON 显著更早 offload**：decision round 1.7 → 1.1；pre-offload 中位数 1 → 0（p90 两侧均为 1，
  未被两侧各 1 个 31-call outlier 拉偏，median 是稳健读数）。
- **OFF 更多"先做一点再 JIT"**：OFF 37% 的 run 在决策同轮并发业务调用（sameRound），ON 仅 10%——
  ON 倾向直接 offload，OFF 倾向先摸数据。
- 两臂 correctness 接近（offloadPrecision 97% / taskCompleted 97%），差异集中在 **offload 时机**而非正确性。

## 5. 结论（按 r5goal.md 决策规则）

> **Reasoning mode 本身改变了 policy。**

OFF avg decision round = 1.7 vs ON = 1.1，pre-offload calls 显著下降——符合 r5goal.md 中
"如果 ON 显著更早 JIT…那么要明确：Reasoning mode 本身改变了 policy"的判据。因此：

- CoT 只能解释 reasoning-enabled Agent，**不能直接作为原始 Agent 的因果证据**；
- 早期 R5.1 observation（30 条真实 CoT）的 taxonomy 结论（recognition-late 主导）应限定在
  reasoning-on 语境，不是原始 Agent 的诊断；
- 若需诊断原始 Agent 的 boundary 问题，应回到 OFF 行为指标（decision round 1.7 / pre 中位数 1 /
  sameRound 37%），或设计不改变行为的被动观测方式。

## 6. 产物与复现

- `report.json`：60 runs 全量指标 + OFF/ON 双臂聚合（含 pre-offload mean/median/p90/max）
- raw CoT（gitignored）：`logs/reasoning-raw/r5-reasoning-validity-2026-08-11T05-54-50-999Z/{off,on}/traces.jsonl`
  （OFF 全部 reasoning 为空；ON 为真实 thinking blocks）
- 冒烟报告：`logs/experiments/r5-reasoning-validity-2026-08-11T05-40-40-493Z/report.json`
- 复现：`npm run experiment:r5-reasoning-validity -- --samples=30`
- 相关代码：`src/experiments/r5ReasoningBenchmark.ts`（`--mode=validity`）、`r5ReasoningAnalyze.ts`（OFF 跳过 taxonomy）、`reasoningTrace.ts`（诊断 meta）
