# R7 B 任务错误模式笔记（事后记录，不改当前文案）

> 数据：`logs/experiments/r7-routing-2026-08-17T08-34-40-792Z/report.json`
> 目的：为未来 R7.x 新 variant 提供假设；当前候选文案与阈值保持冻结。

## 按臂摘要

| arm | runs | attempted | semantic true | completed | execute errors |
|---|---:|---:|---:|---:|---:|
| T1 | 20 | 6 | 0 | 15 | 1 |
| T2 | 20 | 7 | 6 | 19 | 0 |
| T3 | 20 | 20 | 20 | 20 | 7 |
| T4 | 20 | 16 | 0 | 20 | 23 |
| P0 | 20 | 20 | 20 | 20 | 8 |

## 观察

1. **T1**：30% 尝试、0% 语义成功。trigger 能诱发兴趣，但没有语法知识，
   模型反复在 atomic 路径中完成；失败主因是 syntax（32 次）。
2. **T2**：35% 尝试、86% 尝试成功，但 clean=0——多数模型先做完全部
   atomic 工作才想起 JIT。lazy manual 解决了“能写”，没有解决“及时”。
3. **T3**：100% adoption / precision，20 个 run 全部正确；有 7 次
   编译/执行错误但都被修复，说明完整 manual + inline signature 可修复。
4. **T4**：80% 尝试但 precision=0，syntax/output contract 错误远高于 T3。
   极简 manual 不足以支撑 B 的完整流水线（与 H pilot 一致）。
5. **P0**：与 T3 同为 100/100，但 clean=100%、avgTokens 更低
   （8,929 vs 10,320）。system prompt 载体的效率仍好于 tool-embedded。
6. 常见执行错误：`project 的 source “top” 不是对象（得到 数组）`
   在 T3/P0 都出现，属于模型偶发把数组塞进 project 的写法问题，
   compiler/runtime 反馈能引导修复，不构成本轮文案差异。

## 对 R7.x 的候选假设（不修改当前批次）

- H7.x-a：T2 需要更明确的“决策后不要再先跑 atomic”触发器；
- H7.x-b：T4 需要补齐 compute/select/merge 的至少一条完整组合示例；
- H7.x-c：若 holdout 显示 T3 ≈ P0，可比较两者在真实 DSH 下的 cache/tax，
  再决定载体。
