# R7 Routing Development 正式报告

> 生成方式：由预注册脚本与规则自动产出；H holdout 完成后会更新最终结论。
> 状态：B/A 已完成并校验；H holdout 运行中。

## 1. 实验配置

| 项 | 值 |
|---|---|
| 模型 | DeepSeek V4 Flash |
| reasoning | OFF |
| stopAfterSubmit | true |
| boundaryPolicy in system prompt | 无（工具面臂只靠工具描述） |
| rounds | 10 |
| development B | N=20 / arm，七臂 |
| development A | N=10 / arm，七臂 |
| arm 顺序 | 奇数样本 C0→P0，偶数样本逆序 |
| 提示词 SHA | 冻结于 tests/routingToolPrompts.test.ts |
| 决策规则 | src/experiments/r7Decision.ts（预注册） |

## 2. Development B 结果

| arm | runs | completed | adoption | precision | clean | rounds | avgTokens | efficiencyScore |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | 20 | 100% | — | — | 0% | 4.1 | 18,744 | 18,744 |
| T0 | 20 | 100% | 0% | — | 0% | 4.0 | 20,004 | 20,004 |
| T1 | 20 | 75% | 30% | 0% | 0% | 4.2 | 23,432 | 31,243 |
| T2 | 20 | 95% | 35% | 86% | 0% | 3.8 | 18,599 | 19,578 |
| T3 | 20 | 100% | 100% | 100% | 75% | 2.6 | 10,320 | 10,320 |
| T4 | 20 | 100% | 80% | 0% | 0% | 5.3 | 42,071 | 42,071 |
| P0 | 20 | 100% | 100% | 100% | 100% | 2.4 | 8,929 | 8,929 |

## 3. Development A 结果（固定 tax）

| arm | runs | completed | unnecessary | avgTokens | vs T0 |
|---|---:|---:|---:|---:|---:|
| C0 | 10 | 100% | 0% | 1,349 | — |
| T0 | 10 | 100% | 0% | 1,930 | — |
| T1 | 10 | 100% | 0% | 2,138 | +208 |
| T2 | 10 | 100% | 0% | 2,140 | +210 |
| T3 | 10 | 100% | 0% | 3,565 | +1,635 |
| T4 | 10 | 100% | 0% | 2,442 | +512 |
| P0 | 10 | 100% | 0% | 3,162 | +1,232 |

## 4. 预注册 development 决策

- 候选：T0–T4
- 门槛：`taskCompletionRate >= 0.9 && offloadPrecision >= 0.9`
- 主选择：`efficiencyScore` 最低
- Tie（<5%）：选常驻描述更短臂
- 输出：
  - eligibleArms = **T3**
  - winner = **T3**
  - conclusion = **holdout-pending**

## 5. Holdout H 结果与决策

| arm | runs | completed | adoption | precision | clean | rounds | avgTokens | efficiencyScore |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C0 | 20 | 100% | — | — | 0% | 3.0 | 4,950 | 4,950 |
| T0 | 20 | 100% | 0% | — | 0% | 3.0 | 6,122 | 6,122 |
| T1 | 20 | 100% | 10% | 100% | 5% | 3.1 | 7,424 | 7,424 |
| T2 | 20 | 100% | 30% | 100% | 20% | 3.1 | 7,532 | 7,532 |
| T3 | 20 | 100% | 100% | 100% | 100% | 2.3 | 6,091 | 6,091 |
| T4 | 20 | 95% | 60% | 0% | 0% | 3.6 | 11,555 | 12,163 |
| P0 | 20 | 100% | 100% | 100% | 100% | 2.5 | 6,872 | 6,872 |

预注册 holdout 判定（`decideR7Holdout`）：

- winner = **T3**
- gate（completion >= 0.9 且 precision >= 0.9）= **pass**
- efficiencyScore <= P0（6,091 <= 6,872）= **pass**
- conclusion = **recommend-default**

## 6. Prompt overfit audit

- 七臂 forbiddenTokenHits：全部为“无”
- 最长公共子串范围：6–8 字符
- 结论：候选文案未发现模板级泄漏。

## 7. 最终结论与上线建议

- Development + holdout 均通过，T3（`systemPrompt:false` +
  `routingPrompt:"tool-embedded"` + inline DSL signatures）达到预注册上线门槛；
- 用户已决定切换生产默认：DSH 插件默认现在是
  `systemPrompt:false + routingPrompt:tool-embedded + systemPromptReference:neutral`；
- 跨模型抽检仍未执行（当前 .env 没有第二模型 API key），作为切换后的
  追补门禁保留：不通过则回滚到 `systemPrompt:true + baseline`；
- 回滚开关仍保留在插件配置中。
