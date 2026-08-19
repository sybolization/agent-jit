# R7 Routing Discovery — Pilot Smoke（N=1 / arm，仅验证 harness，不作决策）

日期：2026-08-17 ｜ 模型：DeepSeek V4 Flash（reasoning OFF）｜ rounds=6（H 为 8）
协议：stopAfterSubmit=true；边界策略不进 system prompt；tool-surface 臂 system prompt 与 control 完全一致。

> 这是 harness 冒烟，不是正式实验。**不得**用这些数据选择候选文案或修改提示词；
> 正式 development / holdout 需按 docs/r7-routing-plan.md 的 N 与预注册规则执行。

## B 任务（development，明显值得 JIT）

| arm | completed | adoption | precision | clean | rounds | tokens | 备注 |
|---|---|---|---|---|---|---|---|
| C0 control | ✓ | — | — | — | 4 | 18,964 | 普通工具完成 |
| T0 baseline | ✓ | 0% | — | 0% | 4 | 19,449 | 复现“无提示词不路由” |
| T1 trigger | ✓ | 100% | 0% | 0% | 6 | 38,413 | 尝试但无语法知识，未成功 |
| T2 lazy-manual | ✓ | 100% | 100% | 0% | 6 | 46,218 | 先做完全部普通调用才 JIT，重复工作 |
| T3 tool-embedded | ✓ | 100% | 100% | 100% | 2 | 8,143 | 一次成功 |
| T4 tool-embedded-mini | ✗ | 100% | 0% | 0% | 6 | 40,806 | mini manual 不足以写出完整 B 流水线 |
| P0 positive | ✓ | 100% | 100% | 100% | 2 | 6,147 | 正对照 |

## A 任务（不值得 JIT）

| arm | completed | unnecessary | tokens | vs T0 |
|---|---|---|---|---:|
| T0 baseline | ✓ | 0% | 1,902 | — |
| T3 tool-embedded | ✓ | 0% | 3,543 | +1,641 |
| T4 tool-embedded-mini | ✓ | 0% | 2,444 | +542 |
| P0 positive | ✓ | 0% | 3,144 | +1,242 |

## H holdout（shipment 域，异名 + 多字段 binding）

| arm | completed | adoption | precision | clean | rounds | tokens | 备注 |
|---|---|---|---|---|---|---|---|
| T0 baseline | ✓ | 0% | — | 0% | 3 | 6,362 | 同样不路由 |
| T3 tool-embedded | ✓ | 100% | 100% | 100% | 3 | 8,694 | 首次执行失败，第二轮修复成功 |
| T4 tool-embedded-mini | ✓ | 100% | 0% | 0% | 4 | 12,333 | JIT 失败后普通工具补救 |
| P0 positive | ✓ | 100% | 100% | 100% | 2 | 5,355 | 正对照 |

## 只作为冒烟结论

1. Harness、七臂配置、H holdout 工具、指标采集均可运行。
2. T0 的 adoption=0 在 B 与 H 上均被复现。
3. T3（完整中性 manual 进 execute 描述）与 P0 在单样本上都能自主路由并正确完成。
4. T4 的极简 manual 在 B/H 单样本上均不足以稳定写出完整程序；不能据此改文案，
   正式实验应保留 T4 并按预注册规则淘汰。
5. A 型固定 tax 排序（单样本）：T4 < P0 < T3，与文案长度顺序一致；正式实验需以 token 均值确认。
