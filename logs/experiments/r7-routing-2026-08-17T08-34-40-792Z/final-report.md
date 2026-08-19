# R7 Routing Development 正式报告（自动生成）

生成时间：2026-08-17T09:59:39.393Z
报告输入：logs/experiments/r7-routing-2026-08-17T08-34-40-792Z/report.json, logs/experiments/r7-routing-2026-08-17T09-37-02-977Z/report.json, /Users/apple/Documents/agent-execution-dsl-seed/logs/experiments/r7-routing-2026-08-17T09-39-39-907Z/report.json

## 1. Development B

| arm | runs | completed | precision | avgTokens | efficiencyScore |
|---|---:|---:|---:|---:|---:|
| C0 | 20 | 100% | 0% | 18744 | 18744 |
| T0 | 20 | 100% | 0% | 20004 | 20004 |
| T1 | 20 | 75% | 0% | 23432 | 31243 |
| T2 | 20 | 95% | 86% | 18599 | 19578 |
| T3 | 20 | 100% | 100% | 10320 | 10320 |
| T4 | 20 | 100% | 0% | 42071 | 42071 |
| P0 | 20 | 100% | 100% | 8929 | 8929 |

## 2. Development A

| arm | runs | completed | unnecessary | avgTokens |
|---|---:|---:|---:|---:|
| C0 | 10 | 100% | 0% | 1349 |
| T0 | 10 | 100% | 0% | 1930 |
| T1 | 10 | 100% | 0% | 2138 |
| T2 | 10 | 100% | 0% | 2140 |
| T3 | 10 | 100% | 0% | 3565 |
| T4 | 10 | 100% | 0% | 2442 |
| P0 | 10 | 100% | 0% | 3162 |

## 3. Development 预注册决策

- eligible=T3
- winner=T3
- conclusion=holdout-pending
- P0 efficiency=8929

## 4. Holdout H

winner=T3
gatePass=true
efficiencyNotWorseThanP0=true
conclusion=recommend-default

## 5. Prompt overfit audit

| arm | forbiddenHits | longestCommonSubstring |
|---|---|---:|
| C0 | 无 | 6 |
| T0 | 无 | 8 |
| T1 | 无 | 8 |
| T2 | 无 | 8 |
| T3 | 无 | 8 |
| T4 | 无 | 8 |
| P0 | 无 | 8 |

## 6. 备注

- 本报告由 `src/experiments/r7FinalReport.ts` 自动生成；
- 决策阈值来自 `src/experiments/r7Decision.ts`（预注册）；
- 修改任何阈值/文案必须重跑对应批次。
