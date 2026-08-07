# R4c 实验：Semantic Dependency Scaling（filter/sort 语言扩展 + 正确率分化）

日期：2026-08-07 ｜ 状态：计划 ｜ 前置：R4b（E5 已落地：成本侧获支持，正确率饱和）、[r4c方向.md](file:///Users/apple/Documents/agent-execution-dsl-seed/docs/r4c方向.md)

## Summary

R4b 测出了成本分化（tokens/exposed_bytes 随 N 线性增长 vs 恒定），但正确率两臂全 100%——任务太简单：`get_repository` 的返回值没有参与最终答案。R4c 换任务设计，核心原则：

> **后续工具的返回值必须改变最终答案。**

任务改为：`search(N) → get_repository × N → filter（等值条件）→ sort（按 get_repository 独有字段 forks 降序）→ take 3 → return`。这样：
- 答案所需的 `forks` 只有 `get_repository` 返回（search 不返回 forks）→ 中间数据真实参与决策，满足"语义依赖"；
- DSL 臂首次需要用 **filter/sort 两个新语言关键字** 表达计算图（语言能力压力测试，方向文档明确认可）；
- iterative 臂必须把 N 个 detail 对象带进 context 做筛选排序 → 正确率与成本同时可能分化。

**难度梯度（用户已确认）**：深度轴 L1（单字段聚合：sort forks desc → take 3）× L2（多条件决策：filter archived=false AND language="TypeScript" → sort → take 3）＋ 成本轴 N ∈ {5, 20} = **4 cells × 10 样本 × 2 臂 = 80 runs**。

**公平性修复（方向文档建议，全部纳入）**：iterative 臂 `minConsecutiveNoTool` 2→1；同一 completion 的 toolCalls 并行执行（`mapLimit` concurrency=5，与 DSL map 对齐）；指标拆分 `model_ingress_bytes / model_egress_bytes / runtime_internal_bytes`。

核心假设 **H7**：随计算深度增加，DSL 的确定性调度保持正确率且成本恒定（中间数据留在 runtime），iterative 的正确率开始分化（context 中完成筛选排序易漏条件/排错序）且成本继续线性增长。

## Current State Analysis

- **[programmaticBenchmark.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/experiments/programmaticBenchmark.ts)**（R4b）：任务只到 `map→take→return`，ground truth = search 前 k 个 full_name（无需 get_repository 数据）；`exposed_bytes` 一个指标全包。**R4b 文件与报告保留不动**，R4c 新建独立 benchmark。
- **[iterativeToolCalling.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/experiments/iterativeToolCalling.ts)**：`minConsecutiveNoTool` 默认 2；toolCalls **顺序** for 循环执行（N=20 时 tool_ms 11-14s）；无指标拆分。
- **[compiler.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/compiler/compiler.ts)**：语言关键字只接 map/take/return，`filter`/`sort` 走 `unknown_tool`。
- **[ir.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/compiler/ir.ts)**：`ComputeNodeSchema.op` 联合已含 `filter`/`sort`（预留），args 为 `ExecutionLiteralSchema`——**IR schema 无需改动**。
- **[executor.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/runtime/executor.ts)**：compute 只实现 take，filter/sort 抛"尚未实现"。
- **[taskSpec.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/experiments/taskSpec.ts)**：只检查 source/map bindings/take。
- **[githubAdapter.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/runtime/githubAdapter.ts)**：`get_repository` 返回 { full_name, stars, archived, language }，**无 forks**；search 返回同字段集合，也无 forks。R4c 需要在 get_repository 返回 `forks`（`forks_count`），search **保持不加**——制造"只有 get_repository 知道答案"的依赖。
- **[mockTools.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/runtime/mockTools.ts)**：mock get_repository 返回 { full_name, stars, archived, language }，需同步加 forks 以维持"real/mock 字段对齐"不变式。
- 测试：现有 110+ 用例全绿（含 `iterativeToolCalling.test.ts` 的 2 轮结束条件、`programmaticBenchmark.test.ts` 的 R4b 任务梯度）。

## Proposed Changes

### 1. DSL 语言扩展：`filter` / `sort`（closed operators，不引 expression VM）

**语法**（新增两条语言关键字，单行 statement，位置参数风格与 take 一致）：

```
active = filter(details, archived=false, language="TypeScript")   # 保留满足全部等值条件的元素
ranked = sort(active, key="forks", desc=true)                     # 按字段排序（默认 asc）
```

**`src/compiler/compiler.ts`**（新增 `buildFilterNode` / `buildSortNode`，在 buildNode 的 map/take/return 之后、registry 查找之前 dispatch）：
- `filter`：`applyPositionalArgs` slots = `["source"]`；source 必须 ref（`refArg`）；其余命名参数为等值条件，值必须字面量（`literalArg`），每个条件 `args[field] = literal`；**没有** 额外参数概念（所有命名参数都是条件）。IR：`{ kind: "compute", op: "filter", source, args }`。
- `sort`：slots = `["source"]`；`key` 必填 string 字面量（缺失 → `syntax` 诊断，非 string → `config_type_mismatch`）；`desc` 可选 boolean 字面量（默认 false）；未知参数 → `unknown_parameter`。IR：`{ kind: "compute", op: "sort", source, args: { key, desc } }`（desc 恒写入）。
- `ir.ts` 不改（op 联合已含 filter/sort，args 是字面量）。

**`src/runtime/executor.ts`**（compute 分支补 filter/sort）：
- `filter`：source 必须数组；对每个元素（对象），全部条件 `element[field] === literal` 才保留；元素非对象或字段缺失 → 丢弃。trace 记 `inputSize/outputSize`。
- `sort`：source 必须数组；稳定排序（`Array.prototype.sort` 稳定的 JS 语义）；比较规则：两侧都是 number → 数值比较；都是 string → 字典序；字段缺失视为 `-Infinity`（升序排最前 / desc 时排最后）；`desc=true` 反转。

**`src/experiments/programmaticBenchmark.ts` 不动**（R4b 保留）；R4c 的系统 prompt（见 §5）在语法指南中加 filter/sort 两行。

### 2. Adapter：`forks` 只进 `get_repository`

- **`src/runtime/githubAdapter.ts`**：`RepoResult` 接口加 `forks_count: number`；`get_repository` 返回值加 `forks: data.forks_count`。`SearchItem`/search 返回**不加** forks（保持依赖：答案必须经过 get_repository）。
- **`src/runtime/mockTools.ts`**：mock `get_repository` 返回值加 `forks: 200`（对齐 real 字段集，维持"real/mock 可互换"不变式）；mock search 不加。

### 3. TaskSpec 扩展：filter / sort 正确性检查

**`src/experiments/taskSpec.ts`**：
- `TaskSpec` 加 `filterConditions?: Record<string, unknown>`、`sortKey?: string`、`sortDesc?: boolean`。
- `checkTaskCorrectness`（沿用 return 数据流回溯，多 compute 节点链都能遍历到）：
  - `filterConditions` 存在时：`path.find(op === "filter")` → `args` 与期望完全一致（每条件字段存在且字面量相等，无多余条件），否则记 failures；
  - `sortKey` 存在时：`path.find(op === "sort")` → `args.key === sortKey` 且（`sortDesc` 缺省时不查 desc；L1/L2 都传 `sortDesc: true`）`args.desc === true`；
  - 现有 source/map bindings/take 检查不变。L1 无 filterConditions（不要求 filter 节点存在）。

### 4. iterative 臂公平性修复

**`src/experiments/iterativeToolCalling.ts`**：
- `minConsecutiveNoTool` 默认 2 → **1**（"给出答案的 no-tool 轮即结束"，方向文档明确建议）。
- toolCalls 执行：顺序 for 循环 → `mapLimit(toolCalls, 5, ...)`（与 DSL map concurrency=5 对齐；`mapLimit` 保持结果顺序，toolResult 回填顺序不变）。
- `IterativeToolResult` 新增 `model_ingress_bytes` / `model_egress_bytes` / `runtime_internal_bytes`（iterative 恒 0）。保留 `exposed_bytes`（R4b 兼容，= Σ toolResult 字节）。
  - `model_ingress_bytes`：初始 messages（system+user）+ 每轮 assistant（content + toolCalls 参数 JSON）+ 每轮 toolResult content 的 UTF-8 字节累计（**含重复喂给模型的累积历史**——这正是 context 膨胀的度量）；
  - `model_egress_bytes`：每轮模型输出（content + toolCalls 参数 JSON）字节累计。

### 5. R4c benchmark（新建 `src/experiments/semanticBenchmark.ts`）

- **任务集 `buildR4cTasks()`**（export，供测试）：4 cells（L1/L2 × N∈{5,20}），工具集 = search + get_repository。`R4cTask { level, n, k: min(3,n), dslPrompt, iterativePrompt, tools, takeCount: 3, filterConditions?, sortKey: "forks", sortDesc: true }`。
  - L1 prompt：搜索前 N 个 TypeScript agent framework 仓库 → 获取每个仓库详情 → 按 forks 从高到低排序 → 返回前 3 个 full_name。
  - L2 prompt：同上 + 只保留 `archived=false` 且 `language="TypeScript"` 的仓库。
  - DSL 臂系统 prompt 语法指南补 filter/sort。
- **确定性答案 `computeDeterministicAnswer(details, task)`**（export 纯函数，oracle）：`filter → sort(key=forks, desc) → take(3) → full_name`，与 executor 语义一致（两侧各自测试保证对齐）。
- **ground truth `fetchR4cGroundTruth(searchTool, repoTool, task)`**（export）：`search(limit=n)` → `mapLimit(get_repository × n, 5)` → `computeDeterministicAnswer`。每 cell 一次，两臂共用。
- **DSL 臂 runner**（沿用 R4b runDslArm 结构）：
  - 包装 runtime 工具记录每次 tool 结果字节 → `runtime_internal_bytes`（中间数据留在 runtime 的度量）；
  - `model_ingress_bytes` = 初始 prompt + submit_program source + 编译反馈字节；`model_egress_bytes` = 模型输出字节；
  - `checkTaskCorrectness` 用含 filterConditions/sortKey/sortDesc 的 taskSpec；`task_pass = 答案匹配 && correctness.pass`。
  - **冒烟防护：tokens > 0 检查**（R4b 教训：pi-ai 非法输入静默降级会拿到"假全对"空数据）。
- **iterative 臂**：`runIterativeToolCalling({ minConsecutiveNoTool: 1, ... })`，ground truth 匹配 required = `min(3, groundTruth.length)`（filter 后可能不足 3 个）。
- **main**：CLI `--samples=10 --parallel=4`；输出 `logs/experiments/semantic-benchmark-<ts>/report.json` + 控制台汇总表（level | N | 臂 | task% | roundTrips | modelIngress | modelEgress | runtimeInternal | tokens | llmMs | toolMs | e2eMs）。入口守卫（`process.argv[1]` 判等）保证测试可 import。
- R4b 的 `programmaticBenchmark.ts` 完全不动。

### 6. 测试

- **`tests/executionDsl.test.ts` 追加**：filter/sort 编译为正确 compute 节点（含 desc 默认 false）；错误路径（sort 缺 key、desc 非布尔、filter 条件值引用节点、未知参数）。
- **`tests/runtime.test.ts` 追加**：executor filter（多条件 AND、字段缺失丢弃、非对象丢弃）、sort（数值降序、字符串、缺失字段位置、稳定性）；经 `execute()` 端到端（mock 工具）。
- **`tests/taskSpec.test.ts` 追加**：filterConditions/sortKey/sortDesc 检查 pass/fail（条件值不符、缺 filter、sort key 错误、op 顺序）。
- **`tests/githubAdapter.test.ts` 追加**：mock fetch 注入 `forks_count` → `get_repository` 返回 `forks`；search 返回不含 forks。
- **`tests/iterativeToolCalling.test.ts` 更新**：默认结束条件 2→1（no-tool 首轮即结束）；多 toolCalls 并行执行 + 结果顺序保持；新指标字段存在且 `runtime_internal_bytes === 0`。
- **`tests/semanticBenchmark.test.ts` 新建**：`buildR4cTasks`（4 cells、L2 带 filterConditions、工具集 search+get_repository）；`computeDeterministicAnswer` 纯逻辑（filter/sort/take、不足 3 个全返回）；`fetchR4cGroundTruth`（mock fetch：search + N×get_repository → 答案）。
- 回归：现有 110+ 用例全绿。

## Assumptions & Decisions

1. **后端统一真实 GitHub**（延续 R4b）；ground truth 每 cell 拉一次快照，两臂共用。
2. **语言扩展只做 filter+sort**（用户确认）：不引 expression VM / join / ratio；sort key 用 get_repository 独有字段 `forks`（替代方向文档的 forks/stars 比值——比值需除法表达式，超出 closed-ops 约束；`forks` 已满足"后续工具改变答案"原则）。
3. **任务含真实依赖**：search 不返回 forks → DSL 与 iterative 都必须真调 get_repository 才能排序。L2 的 `language="TypeScript"` filter 即使对大部分仓库成立，条件检查仍在（graph 语义正确性要求）。
4. **正确率判定**：集合匹配（matchAnswer），required = min(3, groundTruth.length)（filter 后不足 3 个时以实际数为准）；DSL 侧还需 taskSpec 语义检查（filter 条件 / sort key / map binding / take count 全对）。
5. **公平性修复全部纳入**（方向文档建议）：minConsecutiveNoTool=1、toolCalls 并行（concurrency=5）、指标三分。R4b 的 exposed_bytes 语义保留但 R4c 主指标用三拆分。
6. **样本数默认 10**（延续）；4 cells × 10 × 2 臂 = 80 runs；get_repository 估算 ground truth 50 + DSL 500 + iterative ~500 ≈ 1050 次、search ≈ 170 次，总量 <5000/h 可控。
7. **R4b 完全不动**：文件、报告、report.json 保留；R4c 独立 benchmark + 独立报告，不覆盖历史数据。

## Verification

1. `npx vitest run`：新增测试 + 现有 110+ 用例全绿。
2. 冒烟 `npx tsx src/experiments/semanticBenchmark.ts --samples=1`：4 cells 两臂跑通；检查 tokens > 0（防 pi-ai 静默降级假数据）；L2 的 DSL 程序确实编译含 filter/sort 节点。
3. 完整 `--samples=10`：80 runs → `logs/experiments/semantic-benchmark-<ts>/report.json`。
4. 报告 `experiment_result/语言实验-r4c-semantic-dependency-scaling.md`：L1 vs L2 的 task% 对比、两臂成本曲线、model_ingress vs runtime_internal 对比（验证"中间数据进不进 context"）。
5. 矩阵 `.trae/plan/github-demo-roadmap-matrix.md` 加 E6 行标注结果。
6. commit（分阶段避免混淆）→ push（代理 127.0.0.1:12001，不动 git config）。
