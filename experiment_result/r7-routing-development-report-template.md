# R7 Routing Development 正式报告（模板）

> 本文件是报告模板，不是结果。所有表格在 development / holdout 完成后填写。
> 填写规则：只能填数据、执行预注册决策；不得根据结果修改阈值、文案或指标定义。

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
|---|---|---|---|---|---|---|---|---|
| C0 | — | — | — | — | — | — | — | — |
| T0 | — | — | — | — | — | — | — | — |
| T1 | — | — | — | — | — | — | — | — |
| T2 | — | — | — | — | — | — | — | — |
| T3 | — | — | — | — | — | — | — | — |
| T4 | — | — | — | — | — | — | — | — |
| P0 | — | — | — | — | — | — | — | — |

## 3. Development A 结果（固定 tax）

| arm | runs | completed | unnecessary | avgTokens | vs T0 |
|---|---|---|---|---|---:|
| C0 | — | — | — | — | — |
| T0 | — | — | — | — | — |
| T1 | — | — | — | — | — |
| T2 | — | — | — | — | — |
| T3 | — | — | — | — | — |
| T4 | — | — | — | — | — |
| P0 | — | — | — | — | — |

## 4. 预注册 development 决策

- 候选：T0–T4
- 门槛：`taskCompletionRate >= 0.9 && offloadPrecision >= 0.9`
- 主选择：`efficiencyScore` 最低
- Tie（<5%）：选常驻描述更短臂
- 输出：
  - eligibleArms = ___
  - winner = ___
  - conclusion = holdout-pending | system-prompt-required

## 5. Holdout H 结果与决策

| arm | runs | completed | adoption | precision | clean | rounds | avgTokens | efficiencyScore |
|---|---|---|---|---|---|---|---|---|
| winner | — | — | — | — | — | — | — | — |
| P0 | — | — | — | — | — | — | — | — |

- gate（0.9 / 0.9）= ___
- efficiency <= P0 = ___
- conclusion = recommend-default | reject | data-incomplete

## 6. Prompt overfit audit

- `npm run experiment:r7-audit` 结果路径：___
- 七臂 forbiddenTokenHits：___
- 最长公共子串范围：___
- 结论：候选文案是否与 A/B/H 任务文本存在模板级泄漏

## 7. 最终结论与上线建议

- 若 `recommend-default`：按 `docs/r7-tool-prompt-rollout.md` 灰度；
- 若 `reject` / `system-prompt-required`：保持 `systemPrompt:true + baseline`，
  下一步研究“最小 system prompt”；
- 跨模型抽检通过前不切换默认。
