# GitHub Demo 项目矩阵表（Roadmap Matrix）

> 依据：docs/任务短期目标.md（第一版项目计划）＋ 当前仓库现状
> 日期：2026-08-07
> 核心目标：**自然语言 GitHub 分析任务 → LLM 一次生成 DSL program → 编译器产出 Execution IR → Harness 并行执行 GitHub API + 确定性数据加工 → 仅把必要数据交给 Agent 语义判断**（不是"GitHub Agent"）。

---

## 1. 主推进矩阵（阶段 × 工作项 × 结构 × 基础设施 × 验收）

| 阶段 | 里程碑 | 参考结构优化 | 基础设施接入 | 验收标准 | 主要风险 / 取舍 |
|---|---|---|---|---|---|
| **P0 基座落定** | 项目可安装、依赖可复现 | `package.json`（ESM, node>=20）；`node_modules` 已排除 | `@earendil-works/pi-agent-core@0.84` + `typebox@1.3`（npm，非 uv——pi-agent 是 npm 生态） | `npm install` 可复现；`import { Agent }` 可用 | —（已完成） |
| **P1 重构：parser 与 canvas 解耦** | tokenizer/parser/AST/diagnostics 从 `canvasDsl.ts` 抽出为通用层（**已落地** 2026-08-07） | `canvasDsl.ts` → `src/language/{tokenizer,parser,ast,diagnostics}.ts`；canvas 专属逻辑留 `legacy/canvas/`（不删除） | 无新增 | 现有 5 组 describe / 23+ 用例全绿（回归防护网） | 重构静默改变 canvas 语义 → 必须测试先行；一次只搬模块不搬行为 |
| **P2 IR：通用执行 IR** | 编译目标从 `SemanticCanvasGraphV1` 切到 `ExecutionIR`（**已落地** 2026-08-07：四行 search→map→take→return 编译出 IR） | 新增 `src/compiler/{compiler,ir}.ts`；catalog 接口保留、输出改为 tool 签名 | typebox 定义 IR schema（`ToolNode/MapNode/ComputeNode/ReturnNode`） | 四行示例（search→map→take→return）编译出 IR，**不执行** | IR 过早泛化（加 `while/lambda/管道`）→ 第一版只做 assignment+call；IR 用 JSON/typebox（LLM 不该写 IR，但 IR 可以是结构化数据） |
| **P3 runtime：最小调度器** | 动态 map 展开 + 并发 + trace | 新增 `src/runtime/{runtime,scheduler,valueStore,trace}.ts` | node 内置（Promise/队列），无外部依赖 | mock tool 跑通 map fan-out → join、并发上限、value 传播、trace 落盘 | map 的语义边界（并发数、join 顺序、错误传播）；先不确定执行顺序承诺 |
| **P4 GitHub adapter** | 4 个只读 tool 端到端 | 新增 `src/tools/github/*`；`renderWorkflowDslCatalog` 泛化为 `renderToolCatalog(registry)`（继承 unknown_parameter/config_type_mismatch 经验） | **V0：`gh api` subprocess**（不写 OAuth）→ **V1：REST fetch + token**；处理 rate limit | 真实 GitHub 数据端到端（search→get_repository→languages→contributors） | 搜索 endpoint 限制更严；subprocess 换 fetch 时保持 Tool 接口不变 |
| **P5 agent node** | 图上同存 tool/program/model | 新增 `src/agents/modelAgent.ts` | pi-agent `Agent` 运行时 + LLM 配置（provider/token） | 一张 heterogeneous graph 端到端，Agent 只收到 take 后的少量数据 | Agent 输入规模失控 → 必须限定只喂必要数据；模型调用计入实验 usage |
| **P6 对比实验** | sequential tool calling vs DSL execution | `dslHarness.ts` 迁移为 `src/experiments/{githubDemo,benchmark}.ts`（usage/report 方法论直接继承） | 复用 pi-agent usage 归因（input/output/cacheRead/totalTokens） | 产出对比报告（token / 耗时 / 成功率），可复现 | 实验公平性（同模型同 prompt 面）；缺运行时模块需补齐 |

---

## 2. 结构迁移矩阵（现状 → 目标，按阶段）

| 现状 | 目标位置 | 迁移阶段 | 处理 |
|---|---|---|---|
| `src/domain/canvas/canvasDsl.ts`（单文件编译器） | `src/language/*`（前端）+ `src/compiler/*`（语义/IR） | P1 → P2 | 拆前端（通用）与后端（编译目标可换） |
| `src/domain/canvas/canvasDslCatalog.ts` | `src/catalog/{registry,renderCatalog}.ts` | P2（签名泛化）→ P4（接真实 tool） | 输入从 `CanvasWorkflowTool[]` 泛化为 tool registry |
| `src/domain/canvas/canvasDslGrammar.ts` | `src/language/grammarPrompt.ts` | P1 | 随前端走 |
| `src/contracts/{canvas,semanticCanvas,subgraphTransaction}.ts` | `legacy/canvas/`（保留为回归 reference） | P2 之后 | **不删除**——第一份已验证 evidence |
| `src/experiments/dslHarness.ts` | `src/experiments/{githubDemo,benchmark}.ts` | P6 | 复用工具循环 + usage 归因 + report 思路；依赖的 promptBuilder/semanticTransaction/toolRuntime 由 P3/P5 自建替代 |

---

## 3. 基础设施接入矩阵

| 基础设施 | 用途 | 接入阶段 | 接入方式 | 状态 |
|---|---|---|---|---|
| `@earendil-works/pi-agent-core` | agent loop / 模型适配 / tool 执行 | P0（装）→ P5（用） | npm | 已装 0.84.0 |
| `typebox` | IR 与 tool 契约 schema | P2 起 | npm | 已装 1.3.x |
| node 内置（Promise/队列） | runtime 并发/限流 | P3 | 无外部依赖 | — |
| `gh` CLI | GitHub V0 认证与调用 | P4 | subprocess（`gh api ...`） | 需 `gh auth login` |
| GitHub REST + token | GitHub V1 直连 | P4 后 | `fetch` + 运行时读 token | 需 token；含 rate limit 处理 |
| LLM provider（pi-ai） | agent node | P5 | pi-agent 统一 provider | 需模型 API key/网关 |

---

## 4. 阶段依赖与推进顺序

```
P0 基座（已完成）
  ↓
P1 解耦 parser        ← 今日可开始；旧测试作防护网
  ↓
P2 定义 ExecutionIR   ← 最小闭环：4 行 DSL → IR（不执行）→ 骨架成立
  ↓
P3 runtime + trace    ← 骨架跑起来：动态 map / 并发 / value 传播
  ↓
P4 GitHub 4 tools     ← 第一个真实 adapter（V0 gh api → V1 REST）
  ↓
P5 agent node         ← 第一张 heterogeneous graph
  ↓
P6 对比实验           ← 方法论已成熟，直接迁移
```

**关键前置**：P2 是分水岭——IR 一旦定义，编译器后端（canvas / GitHub / 未来 tool）全部可插拔；P1 是 P2 的地基（前端与 canvas 语义解耦）。两者建议连续做，形成"四行 DSL → IR"的最小可演示闭环（与文档"今天就开始写的东西"一致）。

---

## 5. 第一版约束（防范围蔓延）

- 语法面不改：保持 `<name> = <callee>(key=value, ...)` 单行 statement（parser 几乎不动）
- 不加 `|>` / `lambda` / `for` / `{}` / `while` / 复杂 expression（否则变 parser 项目）
- `compute` 只用 closed operators：filter / sort / take / project / count / group（不引 expression VM）
- IR 可以是 JSON/typebox 结构——**LLM 不该写 Runtime IR，但 IR 本身是确定结构**
- GitHub 只做 4 个只读 tool，最多加 `list_commits`
- 保留 canvas 代码为 regression reference，不删除

---

## 6. 待决策项（推进到对应阶段前需确认）

| 决策点 | 影响 | 需在 | 建议 |
|---|---|---|---|
| 新 IR 与 canvas 编译出口并行还是替换 | P2 工作量与回归策略 | P1 收尾时 | 先并行（新 compiler 独立），P2 后 canvas 走 legacy |
| runtime 并发上限 / 失败重试策略 | map 语义与可靠性 | P3 前 | V0 固定 `concurrency=5`，失败即收集错误不重试 |
| GitHub token 来源 | V1 架构与安全 | P4 前 | 本地 `.env`（进 .gitignore），不走 `gh` 会话 |
| LLM provider 选择（api-key 还是网关） | agent node 接入 | P5 前 | 与现有 LLM_GATEWAY_* 环境变量一致 |
