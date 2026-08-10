# Agent JIT

**A compiler/runtime for dynamically offloading deterministic execution paths from LLM agent loops.**

> Agent JIT does not replace the agent. The agent remains the planner; Agent JIT is an execution offload layer for paths that no longer require model reasoning.

```text
Agent reasoning
      ↓
decides a path is deterministic
      ↓
execute_program(source)
      ↓
Compiler → schema-validated Execution IR → Runtime → Tools
      ↓
compressed result
      ↓
Agent reasoning continues
```

Agent JIT 的目标不是让 Agent 更聪明，而是让 Agent **不再为那些根本不需要智能的执行步骤付 token**。

传统 agent loop 会把大量确定性的工具编排、状态维护和中间数据反复送回模型。Agent JIT 将这部分路径编译成可静态检查的程序，并交给 graph runtime 确定性执行：

> **把“数据怎么流通”从模型手里拿走。**

---

## 为什么叫 JIT

这里的 JIT 不是传统意义上的 just-in-time 机器码编译器。

这里的 **JIT = dynamic agent path compilation / offloading**：

> Agent 在运行过程中识别出一段已经足够确定的未来执行路径，用受限 DSL 描述它；compiler 将其编译成 schema-validated Execution IR；runtime 直接执行这段路径，而不再让每一步工具调用重新经过 LLM context。

类比传统 JIT：

```text
传统 JIT
运行中的程序
  ↓
发现值得优化的代码路径
  ↓
编译
  ↓
避开后续解释执行
```

```text
Agent JIT
运行中的 Agent
  ↓
发现已经确定的执行路径
  ↓
编译成 Execution IR
  ↓
避开逐步 LLM orchestration
```

这个类比强调的是 **运行时路径编译**，而不是机器码生成、hot-path profiling 或传统编译器优化。

---

## 为什么需要它

传统 agent 的工具编排主要有两个放大器。

### 1. Model round trips

典型执行方式：

```text
LLM → tool → LLM → tool → LLM → tool → ...
```

很多中间步骤并不需要新的语义判断，但仍然必须重新进入模型。

### 2. Context growth

工具返回的中间数据会不断进入模型上下文：

```text
search results
+ repository details
+ contributor stats
+ commit stats
+ previous tool calls
+ previous outputs
+ ...
```

当任务 fan-out 增长时，Agent 不只是“调用更多工具”，还要持续搬运和维护更多执行状态。

Agent JIT 将这部分工作迁移到 runtime：

```text
LLM / Agent
    ↓  识别 deterministic execution path
生成受限 DSL 程序
    ↓
Compiler
(static checking → schema-validated IR)
    ↓
Execution IR
(tool / map / compute / merge_by_key / concat / return)
    ↓
Runtime / Scheduler
(dependency graph / concurrency / value store / trace)
```

中间执行数据保留在 runtime，不再随着 fan-out 逐轮回填模型 context。

在当前 benchmark 中，这使模型侧 context growth 与执行宽度显著解耦。

---

## 一个最小例子

Agent 想完成：

> 搜索候选仓库，批量获取详情，按 stars 排序并返回 Top 3。

传统 iterative agent 可能经历多轮：

```text
LLM
→ search
→ LLM
→ get_repository × N
→ LLM
→ sort / select
→ answer
```

Agent JIT 可以把已经确定的部分压缩成一段程序：

```agent
repos = github.search_repositories(
    query="agent framework",
    limit=15
)

details = map(
    repos,
    github.get_repository(full_name=_.full_name)
)

ranked = sort(details, key="stars", desc=true)

return take(ranked, 3)
```

模型只负责描述一次数据流。

之后的 fan-out、依赖调度、并发执行、中间状态和排序都由 runtime 接管。

---

## 实验结果

完整实验报告位于 [`experiment_result/`](./experiment_result/)。

当前证据的重点不是“Agent 做不到 iterative tool calling”。

相反，强模型在这些 benchmark 上通常可以保持很高的正确率。

Agent JIT 目前观察到的主要优势集中在：

- token usage
- model round trips
- model-exposed intermediate data
- end-to-end latency
- deterministic state ownership

### R4b：一次程序提交 vs 迭代工具调用

任务：

```text
search
→ get_repository × N
→ return top-k
```

真实 GitHub 工具，`N ∈ {2, 5, 10, 20}`，两臂各 10 个样本。

| 指标（N=20） | DSL / JIT | Iterative | 差距 |
| --- | ---: | ---: | ---: |
| tokens | 941 | 8,904 | **9.5×** |
| exposed bytes | ~460 | 4,196 | **9.1×** |
| model round trips | 1.0 | 4.0 | **4.0×** |
| LLM ms | 1,117 | 7,393 | **6.6×** |
| end-to-end ms | 4,711 | 18,844 | **4.0×** |

在测试规模内，DSL/JIT 侧模型 token 基本保持稳定，而 iterative agent 的模型输入随工具结果增长。

机制不是“模型更聪明”，而是：

> **确定性数据流由 runtime 消费，而不是由 LLM context 消费。**

### R4e：Branching + Recombination

任务：

```text
search
→ details
→ branch by ratio
   ├─ contributors
   └─ commits
→ join
→ select
→ sort
→ take
```

使用可控 adversarial mock dataset，`N ∈ {15, 30}`。

结果：

- token usage：**6.9× / 8.1×** 差距
- model round trips：约 **1.0–1.3 vs 4.0–4.1**
- JIT runtime 内部状态随 N 增长，但中间数据不需要全部进入模型上下文
- 在工具契约完整时，两臂 benchmark correctness 均达到 100%

R4e 也暴露了一个早期实现缺口：

> 当工具 output contract 没有被 compiler 完整建模时，模型可能幻觉工具返回字段。

补全工具契约后，两臂恢复到相同 correctness。

这个结果推动了当前 `ToolContract` 设计：工具的 input/output schema 应成为 compiler、LLM catalog 和 runtime 共同使用的唯一事实源，使参数和字段错误尽可能在执行前被静态发现。

### R5：Autonomous Offloading（模型自己决定是否 offload）

R4 系列验证的是 forced-JIT 形态（模型被告知"请用 DSL 完成任务"）。R5 把问题换成：

> **仅仅给 Agent 多一个 JIT 能力，它会不会自己正确使用？**

实验（`src/experiments/r5OffloadingBenchmark.ts`，两类工具都注册为 `AgentTool`，Agent loop 统一调度）：
- **Control**：普通 Agent + atomic tools + `submit_answer`；
- **Treatment**：同一个 Agent + 相同 atomic tools + `jit_describe_tools` + `jit_execute_program`；系统提示词只说"当一段后续工作可以确定性程序化时可以选择 describe + execute，**是否使用由你决定**"，不点名工具、不预设机制。
- 两个 arm 的最终答案都走结构化 `submit_answer(answer=...)`（同标准），不再从普通文本/程序 result 里抠答案。

三类任务（`src/experiments/r5Tasks.ts`）：
- **A 不值得 JIT**（单个 get_repository）：理想是直接调用业务工具；
- **B 明显值得 JIT**（search 30 → details × 30 → 分支两路 score → merge_by_key → filter → rank）：理想是 describe → execute 一次程序化；
- **C 混合型**（先读 issue → Agent 语义判断候选 → 批量确定性取分/排序 → 总结）：理想是 reasoning → atomic tools → reasoning → JIT 段 → reasoning。C 型 candidate 数可用 `--candidates=N`（4/10/20/40）缩放做 C-scaling。

**R5 review 后的指标**（在 task correctness / tokens / round trips / latency 之上，不再用单一 `path` 概括）：
- **逐 run 拆分记录**：`jitAttempted`（想用）/ `jitExecutionSucceeded`（跑通）/ `jitSemanticCorrect`（最后一次成功程序过图语义检查 `dslCorrect`）/ `jitCompleted`（JIT 独立完成：尝试 + 语义正确 + 无 fallback）/ `fallbackUsed`（第一次 jit 调用之后又用普通业务工具补救）/ `maxedOut`（跑满轮数，独立字段）；
- **JIT adoption rate = jitAttempted 比例**（"愿不愿意尝试"），**offload precision = semanticCorrect / attempted**（真 precision，分母是尝试过的 run 而不是总 run 数）——两个问题分开，避免旧 precision 只是 adoption 的别名；
- **unnecessary offload rate**：A 上 jitAttempted 比例（不该 offload 却尝试）；
- **compressed path length**：一次 `jit_execute_program` 实际替代了多少原子操作（tool nodes + map fanout + compute/merge/concat/filter，从执行 trace 统计）；另记 **correctlyCompressedOps**——只统计语义正确程序的压缩数，避免错误 DSL 夸大收益；
- **taskCompleted 严格语义（P0 修复，两版）**：`answerCorrect && (!jitAttempted || jitSemanticCorrect === true || fallbackUsed)`——① `dslCorrect=false` 的 JIT run 必须 fail（错误程序的 result 即使包含目标 repo 名也不作数）；② `jitSemanticCorrect === undefined`（执行失败 / A 型上的尝试）同样不视为完成，必须成功 fallback 补救。旧实现把"错误程序的整个 result JSON + finalText"拼成 haystack 做子串判定，导致 B 型 `dslCorrect=false` 仍被记成 `answerCorrect=true`，`correctRate=100%` 无意义——已废弃。
- **最终答案强制 `submit_answer`（P0）**：`answerCorrect` 只认模型显式提交的 `submit_answer(answer=...)`，**未提交即判错**，不再从 finalText 退回判定；两个 arm 同一严格输出协议。
- **完整 tool timeline**：每个 run 记录按序的 `toolTimeline`（业务 / describe / execute / submit_answer + isError），可验证 atomic → reasoning → JIT → reasoning 的真实序列。

**DSL surface（P0 review）**：`join` 改名 **`merge_by_key`**（明确 base+overlay 语义——给每条基准记录附加另一批数据的字段，不是对称合并；`join` 保留为遗留别名，R1–R4 冻结产物兼容）；新增 **`concat`**（真正的列表拼接）——模型不再需要把"拼接两段列表"硬塞进 merge。图语义检查的 `TaskSpec.joinSpec` 同步改名 `mergeSpec`。

**DSL manual 按需加载 + 每 primitive 精确语义**：treatment 常驻 prompt 只留一句"需要时使用 jit_describe_tools 获取编程契约"；DSL 语法极简参考改由 `jit_describe_tools` **第一次**调用时随工具契约一并返回（`MINIMAL_DSL_REFERENCE`，见 `src/integrations/pi/jit.ts`）——与"工具 contract 可以 lazy load"同一设计原则，A 型这种完全不用 JIT 的任务基本不承担 DSL context 成本（旧版常驻完整 DSL manual 让 treatment 的 A 型任务 token 从 861 涨到 2438）。每个 primitive 都带一句精确语义 + 最小示例（含 merge_by_key 的 base 语义与 concat 的分工）。**示例不泄露任何任务的 ground truth**：示例查询词/阈值/截取数使用与 A/B/C 全部错开的虚构常量（并有显式提示"不代表任何任务的真实参数"），否则 B 型任务会退化成"照抄模板"，offloadPrecision 变成假阳性（有回归测试把关）。

**编译错误诊断（P1）**：`jit_execute_program` 的编译失败反馈逐条附带"期望语义"提示（`FIX_HINTS`，如 UNKNOWN_FIELD → "绑定字段必须来自上游工具输出 schema"、expression_invalid → 支持的表达式语法），提高一次 repair 成功率。

**结果记录到 log**：每次实验运行结束把完整结果写入 `logs/experiments/r5-offloading-<ts>/report.json`（与 r4e 等实验约定一致，`logs/` 纳入版本控制以保证可复现性）——包含实验配置、任务元数据（prompt / oracle）、**每个 run 的全部指标**（`toolTimeline` / 拆分后的 JIT 指标 / `submittedAnswer` / `answerCorrect` / `taskCompleted` / 轮数 / tokens / latency / 业务调用序列 / describe+execute 次数 / 最后一次成功程序的源码与 `dslCorrect` / 压缩路径统计 / 失败的 execute 尝试的错误文本 `executeErrors` / 最终文本）以及 **arm × task(A/B/C) 分格汇总**（不再只看三任务平均 token）。运行入口：`npm run experiment:r5 -- --arm=both --task=all --samples=10`。

**R5 正式结果（DeepSeek，60 runs：10 samples × 3 tasks × 2 arms，`logs/experiments/r5-offloading-2026-08-10T06-15-49-414Z/report.json`）**

| 格 | adoption | execSucceeded | semanticCorrect | jitCompleted | offloadPrecision | unnecessary | fallback | taskCompleted | rounds | tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| control/A | 0% | — | — | — | — | 0% | 0% | **100%** | 3.0 | 1,814 |
| control/B | 0% | — | — | — | — | n/a | 0% | **100%** | 5.0 | 24,151 |
| control/C | 0% | — | — | — | — | n/a | 0% | **100%** | 5.1 | 7,903 |
| treatment/A | **0%** | 0% | 0% | 0% | 0% | **0%** | 0% | **100%** | 3.1 | 2,962 |
| treatment/B | **90%** | 90% | **90%** | **90%** | **100%** | n/a | 0% | **100%** | 4.5 | 14,976 |
| treatment/C | 0% | 0% | 0% | 0% | 0% | n/a | 0% | **100%** | 5.1 | 9,641 |

三个关键读数：
- **B 是 JIT 的正收益格**：模型自主选择 offload 9/10（adoption=90%），且尝试的 9 个全部语义正确（offloadPrecision=100%），tokens 24,151 → 14,976（**-38%**）、轮次 5.0 → 4.5。对比修复前（`join` 时代）treatment/B 的 semanticCorrect=0%——**B 的失败确实来自 DSL 语义摩擦**，改名 `merge_by_key` + 明确 base 语义 + `concat` + 带示例的按需参考后翻转。
- **A 零 unnecessary offload**：10/10 都不尝试 JIT，任务仍 100% 完成；treatment 相对 control 的额外 token 只有 ~1.1k（固定 jit 工具定义），DSL manual 按需加载把"不使用 JIT"的成本压到接近零（旧版常驻 DSL manual 是 +1.6k 且 token 861→2438）。
- **C 意外地 0 adoption**：C 型任务太短，模型不愿 JIT——这是 P2 C-scaling（`--candidates=4/10/20/40`）要研究的 autonomous offload threshold。

（此前 B 未稳定时的 single-sample smoke：B 主动选择 JIT 但把 join 基准写错 `dslCorrect=false`，新语义下 `taskCompleted=false`——adoption 与 offload precision 由此分开。）

---

## 当前结论

Agent JIT 目前并没有证明：

> “DSL 能完成 iterative agent 无法完成的任务。”

当前实验更支持一个更具体的结论：

> **对于可以提前表达成确定性程序的工具执行路径，可以把 orchestration state 从 LLM loop 迁移到 compiler/runtime，在保持任务质量的同时显著降低 token、context exposure 和 model round trips。**

因此，Agent JIT 的定位不是新的 Agent Framework，也不是用 DSL 替代 Agent。

它更接近：

> **an execution accelerator / path compiler for existing agents**

未来的理想使用方式是让 Agent 自己决定什么时候调用：

```text
execute_program(source)
```

Agent 保留开放式规划和语义判断能力；Harness 只接管那些已经不需要模型持续参与的确定性路径。

---

# Architecture

## 1. DSL frontend — `src/language/`

模型写的是代码形状的小语言，而不是 JSON execution graph。

基本形式：

```text
<name> = <callee>(...)
```

变量引用直接定义数据流边。

支持的核心 construct 包括：

```text
tool call
map
take
filter
sort
compute
select
merge_by_key
concat
return
```

> `merge_by_key` 是"按 key 给基准记录附加另一批数据的字段"（base+overlay）；`join` 是它的遗留别名（R1–R4 兼容，编译产物同一节点）。`concat` 是真正的列表拼接——两段列表接在一起时用它，不要用 merge_by_key。

例如：

```agent
repos = github.search_repositories(
    query="agent framework",
    limit=15
)

details = map(
    repos,
    github.get_repository(full_name=_.full_name)
)

active = filter(details, archived=false)
ranked = sort(active, key="stars", desc=true)

return take(ranked, 3)
```

### 为什么不是 JSON graph

让模型直接手写 JSON graph，本质上是在让模型手写 IR：

```text
node ids
edges
references
argument bindings
graph consistency
```

这些结构性约束会占用大量 token，并把很多原本可以由 compiler 确定处理的问题交给概率模型。

Agent JIT 使用变量引用表达边：

```text
details = ...
ranked = sort(details, ...)
```

然后由 compiler 产生 Execution IR。

---

## 2. Compiler — `src/compiler/`

Compiler 负责：

```text
source
→ tokenizer / parser
→ AST
→ static validation
→ schema-validated Execution IR
```

当前包括：

- 手写 tokenizer
- 递归下降 parser
- 错误恢复
- 批量诊断
- 工具参数校验
- 引用检查
- DSL construct 编译
- Execution IR 生成

典型诊断包括：

| Diagnostic | 拦截的问题 |
| --- | --- |
| `unknown_tool` | 调用了 registry 中不存在的工具 |
| `undefined_reference` | 引用了尚未定义的数据 |
| `type_mismatch` | 值与目标类型不兼容 |
| `unknown_parameter` | 模型幻觉了工具参数名 |
| `duplicate_name` | 重复定义变量 |
| `duplicate_argument` | 重复传递参数 |
| `invalid_key` | 非法字段 / key 使用 |

目标是尽可能把：

```text
“后端执行以后才发现错了”
```

变成：

```text
“执行前 compiler 就拒绝”
```

同一段合法 DSL 应确定性地产生同一份 Execution IR，因此可以：

- hash
- cache
- snapshot
- offline test
- audit

---

## 3. Execution IR — `src/compiler/ir.ts`

Execution IR 是 compiler 与 runtime 之间的稳定边界。

核心节点类别：

```text
tool
map
compute
join
concat
return
```

其中 `join` 对应 DSL 关键字的 `merge_by_key`（及遗留别名 `join`），`concat` 对应列表拼接。

`compute` 覆盖一组确定性数据操作，例如：

```text
take
filter
sort
compute
select
```

### Tool

外部 API / function / agent tool 调用。

参数来自：

```text
literal
or
reference
```

### Map

对 runtime 数据动态 fan-out：

```text
source × item
→ tool invocation
```

并支持 concurrency。

### Compute

运行确定性的数据变换。

### Merge (merge_by_key / join)

把不同执行分支产生的数据按 key 附加到基准记录（base+overlay，基准字段优先）。

### Concat

把多个列表按顺序拼接成一个大列表（元素原样保留，不做字段合并）。

### Return

定义程序出口。

变量引用定义依赖，因此 IR 本质上是一个可调度的数据流图，而不是按书写顺序解释的节点列表。

---

## 4. Runtime / Scheduler — `src/runtime/`

Runtime 接收 Execution IR，并根据依赖图执行。

```text
execute(graph, registry)
```

它不依赖节点在 source 中的物理顺序。

主要职责：

### Dependency scheduling

根据节点引用建立 dependency graph 和 ready queue。

### Concurrent map

按 DSL 声明的 concurrency 执行 fan-out：

```text
N items
↓
bounded parallel execution
```

### Value store

中间值保留在 runtime：

```text
search results
details
filtered candidates
merged records
scores
```

这些数据不会因为 Agent 每前进一步就自动进入模型 context。

### Trace

每个节点记录执行轨迹，用于：

- debugging
- audit
- benchmark
- failure analysis

---

## 5. Tool Registry — `src/tools/`

工具契约与实现分离为两个类型：

```text
ToolContract        静态契约：id / label / description / inputSchema / outputSchema
RegisteredTool      在 ToolContract 之上绑定 execute（可运行工具）
```

`ToolRegistry<T>` 实现薄接口 `ToolCatalog`（`get` / `all` / `resolveId` / `suggestIds`）——Compiler、LLM Catalog、Runtime 三方只依赖该接口，数组必须先经 `new ToolRegistry(...)` 包装。

**ToolIdResolver（内建于 ToolRegistry）**：注册时自动生成 host alias（`github.get_repository` → `github_get_repository`，点号 → 下划线），`get` / `resolveId` 对 canonical 与 host alias **无感解析**，IR 永远只写 canonical id——`.` 还是 `_` 是宿主框架与 DSL 的表示差异，不成为模型的认知负担：

```text
模型看到的名字           github_get_repository
        ↓
   ToolIdResolver（get / resolveId）
        ↓
   canonical Tool ID    github.get_repository
      ↙            ↘
  Compiler        Runtime
      ↓
    IR tool = "github.get_repository"
```

- **alias collision fail fast**：`foo.bar_baz` 与 `foo_bar.baz` flatten 同名 → 注册时抛错（配置错误，不运行时猜）；
- **`suggestIds`**：未知名字的确定性近似匹配（编辑距离阈值内，最多 2 个），describe 错误与 `unknown_tool` 诊断共用，同时展示 host alias 与 canonical（如 `"github_get_repository"（github.get_repository）`）。

```text
JSON / OpenAI / MCP / local tool
              ↓
   ToolContract / RegisteredTool
              ↓
         ToolCatalog
        /      |       \
       /       |        \
 Compiler  LLM Catalog  Runtime
               |
          jit_describe_tools
```

### Compiler

读取 schema 做：

```text
tool existence
required arguments
argument types
output fields
reference compatibility
```

### Compact LLM Catalog

`renderCompactToolCatalog` / `renderToolContracts`（`src/tools/llmCatalog.ts`）把 registry 自动渲染成给模型的紧凑 callable signature + 命名类型定义：

```text
github.search_repositories(
  query: string
  limit?: integer
) -> RepositorySummary[]   # 按查询条件搜索仓库，返回仓库摘要列表。

## 类型定义（结构相同的类型只展示一次）
RepositorySummary {
  full_name: string
  stars: integer
  archived: boolean
  pushed_at: string
  language: string
}
```

- 只渲染契约（input / output schema），**绝不渲染真实返回内容或示例 JSON**；
- 输出对象提取为命名类型，**结构相同的类型只展示一次**（共享类型去重，如 crm 两个工具同为 `Customer`）；
- **输出类型名优先来自 schema metadata**：`schema.title` → `schema.$id` → heuristic fallback（外部工具声明 title/$id 即得稳定类型名，如 github 契约的 `RepositorySummary` / `Repository` / `Commit`）；
- 渲染走归一化的 SchemaView 层（`src/tools/schemaView.ts`）：`string | null`、嵌套、union、record 都能正确表达，无法识别的类型保留 `unknown`，不默认当成 string；
- compiler 内部仍然使用完整 JSON Schema——目录只是给模型的紧凑投影。

> **唯一正式 renderer**：`src/tools/llmCatalog.ts` 是唯一的 DSL contract renderer；旧格式
> `renderExecutionToolCatalog` 已迁到 `src/experiments/executionCatalog.ts`（仅供旧 benchmark 的
> iterative 臂提示词使用，新代码不要引用）。

原则：

> **工具调用只需要 input contract；工具编排必须同时有 output contract。**

### JIT 元工具（jit_describe_tools / jit_execute_program）

同一个渲染内核被包装成 **Agent Tool**（`src/tools/jitTools.ts`），形成普通工具与 JIT 元工具的天然分工：

```text
普通工具：github.search_repositories / github.get_repository / ...（单次怎么调用）
JIT 元工具：
  jit_describe_tools(tool_names=[...])   模型决定编排时按需获取这些工具的 DSL 契约
  jit_execute_program(source)            提交 DSL 程序给 Harness 编译执行
```

`jit_describe_tools` 是**确定性**的：`tool_names → ToolIdResolver → SchemaView → compact DSL 契约文本`，没有概率过程。**严格语义（不允许 partial success）**：请求里任一 id 未知就整体失败——`UNKNOWN_TOOL: unknown1, unknown2` 一次性列出全部未知 + 确定性近似建议（`Did you mean "github_get_repository"（github.get_repository）？`），绝不返回部分契约；`tool_names` 上限 20（防 lazy loading 变回 eager loading）。因此 DSL 臂的常驻 system prompt **不内嵌业务工具目录**——只包含 DSL 语法/原则 + 两个元工具的说明；模型只有在判断"接下来这几步可以程序化"时才调用 describe_tools 获取契约，再写程序、调用 execute_program。

### Pi Agent Tool 集成（`src/integrations/pi/`）

JIT 元工具不仅是 gateway 的 transport 工具，也是 **Pi Agent 的普通可执行工具**（`@earendil-works/pi-agent-core` 的 `AgentTool`：parameters + execute）。工具调用循环由 Agent/agent loop 统一负责，实验 harness **不再对 jit_* 做特殊 dispatch**：

```text
ToolRegistry
    ↓
createPiTools(registry)        ← src/integrations/pi/toolAdapter.ts
    ↓
Pi Agent
  ├─ github_search_repositories    普通业务工具：host alias 名，execute → 原 RegisteredTool.execute
  ├─ github_get_repository
  ├─ ...
  ├─ jit_describe_tools            → registry → renderToolContracts
  └─ jit_execute_program           → compileExecutionDsl → execute(graph, 同一 registry) → result
```

- 普通工具只改名字（canonical → host alias）与执行签名（`execute(input)` → `execute(toolCallId, params)`），语义零改动；
- `jit_execute_program.execute` 内部完成 编译 → 执行（**同一个 registry**，compile 与 runtime 解析同一批工具），失败（未知工具 / 编译失败 / 执行失败）一律 throw，由 Agent 转成 `isError` toolResult 回填给模型——严格语义天然成立；
- 成功执行的程序随 `AgentToolResult.details` 携带结构化记录（`JitExecuteProgramDetails`：source / result / graph / trace），供 benchmark 测量（任务正确性、compressed path length），**不进入模型上下文**；
- 模型侧运行基座统一由 `src/llm/gateway.ts` 的 `createDeepSeekPiRuntime()` 提供（model + streamFn，与 `LlmGateway` 共用同一个 DeepSeek provider 配置）；共享运行辅助 `src/experiments/agentRunner.ts` 采集轮数 / tokens / 工具调用序列 / 最终文本。

### Runtime

调用同一个工具实现，并在执行前后各做一道 schema 校验（runtime validation 是不变量的最终防线）：

```text
args
 ↓  inputSchema 校验（TOOL_INPUT_SCHEMA_MISMATCH）
execute()
 ↓  outputSchema 校验（TOOL_OUTPUT_SCHEMA_MISMATCH）
```

这样无需维护：

```text
Agent tool registry
+
DSL tool registry
```

两份独立定义。

工具契约只有一个事实源。

Provider 实现与契约按域隔离在 `src/tools/providers/`（Compiler 与 Runtime 对具体工具零感知）：

- `src/tools/providers/github/contracts.ts`：GitHub 只读工具契约
- `src/tools/providers/github/real.ts`：真实 GitHub API adapter
- `src/tools/providers/github/mock.ts`：可控 adversarial mock（可复现实验）
- `src/tools/providers/domain/mock.ts`：跨域 mock（CRM / users / email）

---

# Design Principles

## 1. Agent remains the planner

Agent JIT 不试图替代模型的开放式推理能力。

当任务需要：

```text
semantic judgment
open-ended planning
natural-language interpretation
hypothesis formation
```

控制权应保留在 Agent。

## 2. Deterministic paths should not repeatedly cross the model boundary

如果接下来的工作已经可以完整写成：

```text
map
filter
branch
join
sort
aggregate
tool calls with known bindings
```

那么继续逐步进入 LLM 通常只是额外的 orchestration cost。

## 3. Compiler owns structure; runtime owns state

模型负责描述程序。

Compiler 负责结构正确性。

Runtime 负责执行状态。

## 4. Tool contracts are first-class

Input schema 和 output schema 都是编译器的一部分。

模型不应该靠运行后观察错误来猜：

```text
参数叫什么
输出有哪些字段
字段是什么类型
```

能够静态知道的东西，应尽量在执行前检查。

Agent JIT 是 programmatic orchestration：模型写 `A → B → C` 时 A 尚未执行，因此：

> **工具调用只需要 input contract；工具编排必须同时有 output contract。**
> input schema 告诉模型"这个工具怎么调用"；output schema 告诉模型"这个工具怎么被组合"。

## 5. Internal execution state should stay internal

Runtime 处理的数据量可以随 fan-out 增长。

但这些数据不应该默认全部暴露回 Agent。

未来的 Agent-Harness interface 将重点研究：

> **什么是让 Agent 继续推理所需的最小充分执行输出。**

---

# Limitations

当前结果需要在明确边界内理解。

- benchmark correctness 在多个任务上已经出现 ceiling effect，两臂均可达到 100%
- 当前主要证据集中在成本侧，而不是证明 DSL/JIT 拥有更高智能能力
- 当前实验主要使用单一模型（DeepSeek）
- 部分实验使用可控 mock backend，以减少外部 API 随机性并构造可验证任务
- 当前的 “JIT” 是 agent execution 层的动态路径编译类比，不是传统机器码 JIT compiler
- R5（Autonomous Offloading）已搭建双 arm 实验与三类任务，但统计结论（多采样下的 adoption / precision / unnecessary offload 率）尚未跑满
- Harness → Agent 的最小充分 output / continuation state 仍在设计中

这些限制是当前研究边界的一部分，而不是被隐藏的假设。

---

# Install

```bash
npm install
```

主要依赖：

- `@earendil-works/pi-agent-core` — agent 基座
- `typebox` — schema / IR contract

---

# Run Experiments

配置 DeepSeek API key：

```bash
echo 'DEEPSEEK_API_KEY=sk-...' > .env
```

`.env` 已被 `.gitignore` 排除。

运行实验：

```bash
npm run experiment
```

实验会让模型生成程序，并通过 compiler / runtime 执行。

相关代码：

```text
src/llm/gateway.ts
```

是模型 gateway 的集中入口。

实验结果写入：

```text
logs/experiments/
experiment_result/
```

---

# Repository Layout

```text
src/language/
    DSL frontend
    tokenizer / parser / AST / diagnostics

src/tools/
    ToolContract / RegisteredTool / ToolCatalog / ToolRegistry
    jitTools.ts                      JIT 元工具契约（jit_describe_tools / jit_execute_program）
    schemaView（归一化 schema 层：JSON Schema → SchemaView）
    llmCatalog（Compact LLM Catalog：全量目录 + describe_tools 子集渲染）
    providers/
        github/{contracts,real,mock}.ts   契约 + 真实 adapter + mock
        domain/mock.ts                    跨域 mock（CRM / users / email）

src/integrations/pi/
    toolAdapter.ts                   createPiTools(registry)：业务工具 + JIT 元工具 → Pi AgentTool
    jit.ts                           jit_describe_tools / jit_execute_program 的 AgentTool execute 层

src/compiler/
    Execution IR compiler
    tool catalog renderer
    static checking

src/runtime/
    dependency scheduler
    concurrent map
    value store
    trace
    expression evaluation

src/llm/
    LLM gateway（LlmGateway + createDeepSeekPiRuntime：Agent 的 model/streamFn 基座）

src/prompt/
    unified DSL system prompt（语法构造注册表 + 两个元工具的工作方式，不内嵌工具目录）

src/experiments/
    language experiments
    iterative-vs-programmatic benchmarks
    agentRunner.ts                   共享 Agent 运行辅助（轮数 / tokens / 工具调用 / 最终文本）
    hybridAgentBenchmark.ts          真 Agent 双通道 benchmark（Agent loop 统一调度，无特殊 dispatch）
    r5Tasks.ts                       R5 任务集（A/B/C 三类 + oracle + C 型 mock）
    r5OffloadingBenchmark.ts         R5 Autonomous Offloading 双 arm 实验 + 新指标汇总

tests/
    compiler / runtime / experiment tests

experiment_result/
    markdown reports for experiment rounds
```

---

# Research Direction

目前能力实验已经基本确认：

```text
Agent can do the work iteratively
```

以及：

```text
the same deterministic path can often be executed
with much less model involvement
```

下一阶段不再主要研究“DSL 能不能完成更复杂的工具流”，而是研究 Agent JIT 如何作为普通 Agent 的 execution accelerator（R5 已实现双 arm harness 与三类任务）：

```text
Existing Agent
    │
    ├── normal tools
    │
    └── execute_program(...)
              ↓
          Compiler
              ↓
       Execution Runtime
              ↓
          same tools
```

重点问题包括：

1. Agent 是否会自主识别值得 offload 的 deterministic path？（R5 的 adoption rate / offload precision 直接回答）
2. Agent 会压缩多长的执行路径？（R5 的 compressed path length）
3. 什么情况下它应该继续 reasoning，而不是 offload？（R5 的 unnecessary offload rate）
4. Harness 应该返回多少信息，才能保持后续 reasoning quality？
5. 是否可以在不损失任务质量的情况下继续降低 model-visible intermediate state？

---

## Thesis

> **Agent JIT does not make the model smarter. It compiles away the parts of agent execution that do not need intelligence.**

Or, more concretely:

> **Let the model reason. Let the compiler and runtime own deterministic execution.**
