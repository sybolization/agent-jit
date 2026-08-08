# Agent JIT

**A compiler/runtime for dynamically offloading deterministic execution paths from LLM agent loops.**

## 这里的 "JIT" 指什么

不是传统意义上的 just-in-time 机器码编译器。这里的 **JIT = dynamic agent path compilation / offloading**：

> 传统 agent loop 把每一步工具编排都经过 LLM context（"解释执行"）；Agent JIT 让 agent 用一门受限 DSL 写出确定性执行路径，compiler 把它编译成 typed Execution IR，graph runtime 确定性执行——**被编译的确定性路径从此不再回到模型 context**。

一句话类比：传统 JIT 把"频繁执行的代码路径"编译成机器码以避开解释器；Agent JIT 把"频繁重复的确定性 agent 路径"编译成执行图以避开 LLM。

```text
LLM / Agent
    ↓  识别 deterministic execution path
生成受限 DSL 程序
    ↓
Compiler（static checking → typed IR）
    ↓
Execution IR（tool / map / compute / join / return）
    ↓
Runtime / Scheduler（依赖图调度 / 并发 map / value store / trace）
```

## 为什么需要它

传统 agent 的工具编排有两个放大器：

1. **round trips**：`LLM → tool → LLM → tool → …` 每步一次模型往返，中间数据反复回填 context。
2. **context 膨胀**：中间结果（如 N 个仓库的 JSON）每轮重新喂给模型，随任务规模线性增长。

Agent JIT 的解法是**把"数据怎么流通"从模型手里拿走**：模型只写一次意图（程序），compiler 静态检查，runtime 确定性执行——中间数据全部留在 runtime，模型 context 恒定。

## 核心抽象

### 1. DSL（语言前端，`src/language/`）

模型写的是代码形状的小语言，不是 JSON。语法：`<name> = <callee>(<key>=<value>, ...)`，裸标识符即引用、定义数据流边。

```agent
let repos = github.search_repositories(query="agent framework", limit=15)
let details = map(repos, github.get_repository(full_name=_.full_name))
let ranked = sort(details, key="stars", desc=true)
return take(ranked, 3)
```

内置 construct：`tool 调用` / `map` / `take` / `filter` / `sort` / `compute` / `select` / `join` / `return`。

**为什么不用 JSON 手写 graph？** JSON 等价于让模型手写 IR——node ID、edge、引用一致性全由模型管理，token 爆炸且错误到运行时才暴露。DSL 让变量引用定义边，compiler 产生图。

### 2. Compiler（`src/compiler/`）

手写 tokenizer + 递归下降 parser（错误恢复、批量诊断）+ 语义编译。13 种编译期诊断码把错误从"运行时"提前到"编译期"：

| 诊断 | 拦截的错误 |
|---|---|
| `unknown_tool` | 调用目录外的工具 |
| `undefined_reference` | 引用未定义变量 |
| `type_mismatch` | 引用类型不兼容 |
| `unknown_parameter` | **模型幻觉参数名**（如 `prompt` vs `positive_prompt`，编译期拒绝，后端不再拒） |
| `duplicate_name` / `duplicate_argument` / `invalid_key` … | 语法与形状错误 |

确定性：同一段 DSL 永远编译出同一张图（纯函数、无副作用、可 hash、可离线测试）。

### 3. Execution IR（`src/compiler/ir.ts`）

typed 中间表示（typebox 契约），五类节点：

```text
tool      外部工具/API 调用（参数为 literal | ref）
map       动态展开：source × 元素→参数绑定 + concurrency（运行时 fan-out）
compute   op ∈ take / filter / sort / compute / select（确定性程序）
join      多输入按 key 合并字段（分支结果重组）
return    出口
```

变量引用定义数据流边——IR 是可调度的图，不是扁平的节点列表。

### 4. Runtime / Scheduler（`src/runtime/`）

`execute(graph, registry)` 按依赖图调度，不依赖节点顺序：

- **map 并发**：以 DSL 声明的 concurrency 做 fan-out，运行时并行执行 N 个工具调用；
- **value store**：中间值留在 runtime，不进模型 context；
- **trace**：每节点产出执行轨迹，可审计。

### 5. 工具接入（`src/tools/`）

统一 `ToolDefinition`（`id` / `description` / `inputSchema` / `outputSchema` / `execute`）→ `ToolRegistry`，**一次注册，三处消费**：compiler 契约、给 LLM 的目录渲染、runtime 实现。

```text
JSON / OpenAI / MCP tool
        ↓
   ToolDefinition
        ↓
    ToolRegistry
     ↙         ↘
Compiler   DSL catalog renderer
```

配套两个后端：`githubAdapter`（真实 GitHub API）+ `mockTools`（可控 adversarial mock，用于可复现实验）。

## 实验证据

`experiment_result/` 下每轮有完整报告。

### R4b：DSL 一次提交 vs 迭代工具调用（真实 GitHub）

`search → get_repository × N → 返回 top-k`，N ∈ {2, 5, 10, 20}，两臂各 10 样本：

| 指标（N=20） | DSL | iterative | 差距 |
|---|---:|---:|---:|
| tokens | 941（恒定） | 8,904（线性增长） | **9.5×** |
| exposed_bytes | ~460（恒定） | 4,196 | 9.1× |
| round_trips | 1.0 | 4.0 | 4.0× |
| llm_ms / e2e_ms | 1,117 / 4,711 | 7,393 / 18,844 | 6.6× / 4.0× |

机制：DSL 把"数据怎么流通"编译成确定性 IR 由 runtime 消费；iterative 每轮把全部中间数据重新喂给模型。

### R4e：分支 + 数据重组（mock adversarial dataset）

`search → details → 分支（ratio>0.15 走 contributors / 否则走 commits）→ join → select → sort → take`，N ∈ {15, 30}，各 10 样本：

- tokens **6.9× / 8.1×**，round_trips 1.0-1.3 vs 4.0-4.1；
- DSL 侧 `runtime_internal` 随 N 增长（2,273 → 4,570，中间数据全留 runtime），iterative 恒 0（全经 model context）；
- 本轮还暴露了 DSL 的信息瓶颈：工具契约不透明时模型幻觉返回字段（正确率 70%/50% vs iterative 100%）；契约写清后两臂恢复 100%——**模型没有运行时反馈时必须精确"记住"工具契约**。

### 诚实的边界

- 正确率侧两臂在 benchmark 中均饱和（100%），证据集中在**成本侧**（tokens / context / round trips / latency）；
- 单模型（DeepSeek）；R4e 用可控 mock 后端，无真实 API 随机性；
- 定位是 **agent execution 层的动态路径编译**——不是传统 JIT compiler，README 首页已澄清。

## Install

```
npm install
```

依赖：`@earendil-works/pi-agent-core`（agent 基座）+ `typebox`（IR 契约）。

## 运行实验（agent 生成程序）

```
# 1. 配置 DeepSeek key（.env 已被 .gitignore 排除）
echo 'DEEPSEEK_API_KEY=sk-...' > .env

# 2. 跑 DSL 生成实验（多轮修订，mock tools 执行，不碰真实 GitHub）
npm run experiment
```

`src/llm/gateway.ts` 是唯一接触模型的地方；实验报告写入 `logs/experiments/` 与 `experiment_result/`。

## Layout

```
src/language/         DSL 前端：tokenizer / parser / AST / 诊断（通用）
src/tools/            ToolDefinition / ToolRegistry（工具唯一事实源）
src/compiler/         ExecutionIR 编译器（tool/map/compute/select/join）+ 工具目录渲染
src/runtime/          图 runtime：依赖调度 / 并发 map / value store / trace / 表达式求值
src/llm/              LLM gateway（pi-ai DeepSeek 端点）
src/contracts/        canvas 语义图契约（历史产品场景输出）
src/domain/canvas/    canvas 语义编译层（历史产品场景）
src/experiments/      R1-R4 语言实验 + R4b/e 对比实验脚本
tests/                编译器 + runtime + 实验测试
experiment_result/    各轮实验报告（markdown）
docs/                 设计文档 + dsl-memory 项目知识档案
```
