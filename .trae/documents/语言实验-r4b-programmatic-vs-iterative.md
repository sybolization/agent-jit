# R4b 实验：Programmatic Tool Calling Benchmark（DSL 程序执行 vs 迭代工具调用）

日期：2026-08-07 ｜ 状态：计划 ｜ 前置：R4（真实 GitHub adapter 端到端 50/50）、传输协议（submit_program tool envelope）

## Summary

同任务、同模型（DeepSeek）、同后端（真实 GitHub API）下，对比两条执行架构：

- **DSL 臂**（已有基础设施）：模型一次 `submit_program(source)`，deterministic runtime 调度 N 个工具。
- **Traditional 臂**（需新建）：迭代工具调用 agent loop——`LLM → tool call → 执行 → tool result → LLM` 逐轮，模型决定每一步。

核心假设 **H6**（r4方向.md）：

> 随着工具图复杂度增加，DSL 程序执行相较迭代 Tool Calling，应显著降低模型往返次数、中间数据暴露、token 与端到端延迟，同时保持任务正确率。

任务复杂度用 fan-out 梯度 **N=2/5/10/20** 控制，画出两臂四条曲线（round trips / exposed bytes / tokens / latency）随 N 的增长。

## Current State Analysis

- **[gateway.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/llm/gateway.ts)**：已支持 `complete(messages, { tools })` + toolCall/toolResult 消息（传输协议），manual 工具循环可直接构建——**pi-ai 无内置 agent loop 封装，需手写**。
- **[githubAdapter.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/runtime/githubAdapter.ts)**：真实 GitHub 4 工具已就绪（`createRealGithubTools()`，fetch + token，字段与 mock 对齐），两臂共用同一工具后端。
- **[dslGenerationExperiment.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/experiments/dslGenerationExperiment.ts)**：DSL 臂 harness（runOnce + taskSpec + report + `--backend=real`）已存在；但**未记录执行延迟与中间数据暴露量**，且任务固定 N=10。
- **[r3Tasks.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/experiments/r3Tasks.ts)**：`R3Task { id, name, prompt, spec, tools }`，`TaskSpec { query, queryTokens, limit, takeCount, bindings }`——梯度任务可复用该结构。
- **runtime**：`execute()` 返回 `totalDurationMs`；`mapLimit` 可用。工具目录渲染 `renderExecutionToolCatalog` 可给两臂共用 prompt。

## Proposed Changes

### 1. 梯度任务集 + ground truth（`src/experiments/programmaticBenchmark.ts`）

- 单语义：search TypeScript agent 仓库（`query="agent framework language:typescript"`）→ `N × get_repository`（`full_name → full_name`）→ `take K=3` → `return`。复用 R3 任务 1 的 prompt 措辞，limit 按档变化。
- 四档 `N ∈ {2, 5, 10, 20}`，K = `min(3, N)`。任务工具目录 = search + get_repository（真实 adapter）。
- **ground truth**：确定性执行生成——真实 `search_repositories(query, limit=N)` → 按返回顺序对前 K 个调 `get_repository` 得 `full_name` 列表。两臂的答案都与之比较（集合不敏感匹配：模型答出的 full_name 与 ground truth 的交集 ≥ K 即 task_pass）。

### 2. Traditional 臂（`src/experiments/iterativeToolCalling.ts`，新建）

手动工具循环：
- prompt：任务描述 + 工具目录 + "用这些工具完成任务，最后在文本中给出前 K 个仓库的完整名称（owner/repo），每条一行"。
- 循环：`complete(messages, { tools: 真实 GitHub 4 工具 })` → 若含 `toolCall`：执行对应 adapter `execute`，把 `toolResult`（JSON 序列化）加回 messages → 继续；若只有 text：循环结束。
- 兜底：`maxSteps = N + 10`；工具执行异常 → toolResult(isError) 反馈继续；连续 2 轮无 toolCall 视为结束。
- 指标（用 `performance.now()` 包裹）：
  - `round_trips` = complete 调用次数；
  - `exposed_bytes` = 每轮 toolResult JSON 的 UTF-8 字节累计（喂给模型的中间数据）；
  - `usage` = 每轮 gateway usage 累计（input/output/cacheRead/totalTokens）；
  - `llm_ms` / `tool_ms` / `e2e_ms`。
- 答案提取：从最终 text 正则提取 `owner/repo`（`[\w.-]+\/[\w.-]+`），与 ground truth 比较。

### 3. DSL 臂 benchmark runner（`src/experiments/programmaticBenchmark.ts` 内）

- 复用现有组件组装（不依赖 dslGenerationExperiment 的 runOnce，避免改动 R3/R4 实验）：`compileExecutionDsl(allowMapBinding=call) + checkTaskCorrectness + execute(real adapter)` + `submit_program` 工具循环（同 transport 协议）。
- 指标对齐：
  - `round_trips` = 提交轮数（含 repair）；
  - `exposed_bytes` = `|source|` + `|return 结果 JSON|`（中间数据不经模型）；
  - `usage` / `llm_ms` / `e2e_ms`（LLM + runtime 执行）。
- 答案来源：`return` 节点结果数组的 `full_name` 字段，与同一 ground truth 比较。

### 4. 入口与报告（`src/experiments/programmaticBenchmark.ts` 的 main）

- CLI：`--samples=10 --parallel=4`（档内样本串行、档间并发，避免 search 30/min 限速）。
- 输出：`logs/experiments/programmatic-benchmark-<ts>/report.json`（每臂 × 每档 summary + 逐样本记录）+ 控制台四条曲线表（round trips / exposed bytes / tokens / latency / correctness）。
- 汇总：两臂在 N=20 档的比值（如 round trips DSL:traditional 的倍数）。

### 5. 测试（`tests/iterativeToolCalling.test.ts` + `tests/programmaticBenchmark.test.ts`）

- 答案提取正则：full_name 列表、错误行忽略、去重。
- 工具循环纯逻辑：mock gateway（注入假 complete 返回序列：toolCall → text）验证 messages 累积与结束条件；不真实打 API/LLM。
- ground truth 生成：mock fetch 注入（复用 githubAdapter 测试模式）验证排序与取 K。
- 回归：现有 92 用例不动。

## Assumptions & Decisions

1. **后端统一真实 GitHub**（用户已确认）；网络抖动/rate limit 对两臂一致，不做 mock 层。
2. **只用 workload 1（fan-out）**：`search → N×get_repository → take → return`。workload 2（+transformation）/ 3（+semantic node）留 R5（heterogeneous graph），避免引入 P5 agent node 的 LLM variance 污染 R4b。
3. **正确性 = 结构化答案提取**（用户已确认）：集合匹配 ground truth，不看顺序。
4. **DSL 臂答案**从 return 结果取（确定性），traditional 从最终 text 取（模型输出）——两臂各自自然产出，判定同一 ground truth。
5. **exposed_bytes 口径**：DSL = source + return 结果；traditional = Σ toolResult JSON。中间数据暴露的核心对比。
6. **样本数默认 10**（用户确认不考虑调用成本）：2 臂 × 4 档 × 10 = 80 次 DSL 生成 + 80 次迭代对话。rate limit 估算：search 80 次（30/min，档内串行安全）、get_repository ~Σ(2+5+10+20)×10 = 370 次 + traditional 侧同量级，总量 <5000/h。
7. **不动现有实验**：benchmark 独立模块，R1-R4 的 harness/报告不回归。

## Verification

1. `npx vitest run`：新增测试 + 92 旧用例全绿。
2. 冒烟 `--samples=1`：两臂 × 4 档跑通，指标字段完整，答案提取非空。
3. 完整 `--samples=10`（两臂 × 4 档 = 80+80 次生成）→ report.json。
4. 抽查报告：四条曲线单调性、task correctness 两臂对比、N=20 档的成本倍数。
5. 报告 `experiment_result/语言实验-第四轮结果.md` 追加 R4b 节（或独立文档）+ 矩阵 E5 行标注。
6. 询问 commit/push（按用户规则）。
