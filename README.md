# Canvas DSL

A small, closed, deterministic authoring language for the Workbench semantic canvas: the agent writes code-shaped text, and the compiler turns it into the exact `SemanticCanvasGraphV1` the Harness already runs.

> 定位（seed）：让 LLM 用代码形状的小语言写"节点 + 参数 + 数据流"，编译器确定性翻译成运行时真正执行的图，Harness 统一调度。下一步演进为通用 Agent Execution DSL（tool / agent / compute / control 节点）。
> 基座：基于 [pi-agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core`）开发——agent 循环、工具调用与消息状态管理复用 pi-agent 的 `Agent` 运行时。

## Install

```
npm install
```

依赖：`@earendil-works/pi-agent-core`（agent 基座，含 `pi-ai` / `typebox` 传递依赖）+ `typebox`（编译产物契约）。

## 运行实验（agent 生成 DSL）

```
# 1. 配置 DeepSeek key（.env 已被 .gitignore 排除）
echo 'DEEPSEEK_API_KEY=sk-...' > .env

# 2. 跑 DSL 生成实验（多轮修订，mock tools 执行，不碰真实 GitHub）
npm run experiment
```

`src/llm/gateway.ts` 是唯一接触模型的地方（pi-ai 的 DeepSeek 端点）；实验报告写入 `logs/experiments/`。

## Layout

```
src/contracts/        SemanticCanvasGraphV1 与 CanvasWorkflowTool 契约（typebox）
src/language/         DSL 语言前端（tokenizer / parser / AST / 诊断，通用）
src/compiler/         通用 ExecutionIR 编译器（tool / map / compute / return）+ 工具目录渲染
src/runtime/          执行 runtime（依赖图调度 / 并发 map / value store / trace / mock tools）
src/llm/              LLM gateway（pi-ai DeepSeek 端点，实验唯一接触模型处）
src/domain/canvas/    canvas 语义编译层 / 目录自动翻译 / 语法规范 prompt
src/experiments/      实验脚本（dslHarness）
tests/                编译器用例
docs/                 设计文档（canvas-agent-code-dsl-plan）+ 项目知识档案（dsl-memory）
```

## Key points

- 语法：`<name> = <callee>(<key>=<value>, ...)`，newline 分隔语句；裸标识符即引用，定义数据流边。
- 编译器：手写 tokenizer + 递归下降 parser（错误恢复、批量诊断）+ 语义编译（参数路由 / 类型校验 / 契约自校验）。
- 通用 IR：`compileExecutionDsl`（src/compiler/）把 DSL 编译为 ExecutionIR（tool / map / compute / return，变量引用定义数据流边），与 canvas 后端并行。
- runtime：`execute(graph, registry)`（src/runtime/）按依赖图调度，不依赖节点顺序；map 以 DSL 声明的 concurrency 做 fan-out 并发，每节点产出 trace；mock GitHub tools 验证闭环（P4 换真实 adapter）。
- 确定性：同一段 DSL 永远编译出同一张图（纯函数、无副作用、可 hash、可离线测试）。
- agent 基座：`dslHarness.ts` 复用 pi-agent-core 的 `Agent` 工具循环（`apply_canvas_dsl` 单工具、多轮修订），并聚合每条 assistant 消息的 usage 做 token 归因；`src/experiments/` 依赖的运行时（promptBuilder、harness、tool runtime）为 seed 中未包含的外部模块，接入产品时需补齐。
