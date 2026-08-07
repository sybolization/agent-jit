# Canvas DSL

A small, closed, deterministic authoring language for the Workbench semantic canvas: the agent writes code-shaped text, and the compiler turns it into the exact `SemanticCanvasGraphV1` the Harness already runs.

> 定位（seed）：让 LLM 用代码形状的小语言写"节点 + 参数 + 数据流"，编译器确定性翻译成运行时真正执行的图，Harness 统一调度。下一步演进为通用 Agent Execution DSL（tool / agent / compute / control 节点）。

## Layout

```
src/contracts/        SemanticCanvasGraphV1 与 CanvasWorkflowTool 契约（typebox）
src/domain/canvas/    编译器 / 目录自动翻译 / 语法规范 prompt
src/experiments/      实验脚本（dslHarness）
tests/                编译器用例
docs/                 设计文档
dsl-memory.md         项目知识档案（为什么做、数据、坑、下一步）
```

## Key points

- 语法：`<name> = <callee>(<key>=<value>, ...)`，newline 分隔语句；裸标识符即引用，定义数据流边。
- 编译器：手写 tokenizer + 递归下降 parser（错误恢复、批量诊断）+ 语义编译（参数路由 / 类型校验 / 契约自校验）。
- 确定性：同一段 DSL 永远编译出同一张图（纯函数、无副作用、可 hash、可离线测试）。
- 依赖：仅 `typebox`（编译器 + 契约）；`dslHarness.ts` 额外依赖运行时（新项目需重写）。
