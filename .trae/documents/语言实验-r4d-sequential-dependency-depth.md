# R4d：Sequential Dependency Depth（顺序依赖深度 + 严格答案接口）

日期：2026-08-07 ｜ 前置：R4c（E6，成本侧获支持/正确率饱和）、[r4c方向.md](file:///Users/apple/Documents/agent-execution-dsl-seed/docs/r4c方向.md)、R4c 报告
状态：已确认（用户：真实 GitHub + D1/D2/D3 全深度）

## 1. 背景与目标

R4c 已证明 **width 增长**（N↑）时 DSL 把数据留在 runtime、iterative 把数据带进 context（tokens 6.1x、model_ingress 4.5x @N=20）。但两个问题使其无法认真比较 correctness：

1. **iterative 的 correctness checker 太宽松**：从最终文本 regex 抽所有 `owner/repo`，集合交集 `>= required` 即过——不查顺序、不查长度，模型正文提到过正确答案即 PASS（最新日志里大量这种"被 20 个名字救回"的通过）。
2. **L2 的 filter 没有真正改变候选集**：真实数据 20 个仓库全部满足 `archived=false && language="TypeScript"`，四个 cell 的 ground truth 完全一致，正确率被数据巧合顶死。

R4d 目标（用户定义）：

> **Sequential dependency depth**：完成最终任务所需的、必须等待上一阶段结果才能确定下一阶段输入的工具调用层数。
>
> 深度不是"步骤多"，而是"后一步的输入必须由前一步产生的新信息决定"。

R4/R4c 已证明 width 差异；R4d 测 **depth 增长时两种架构的 correctness、round_trips、tokens、状态管理是否开始分叉**。同时把答案接口改成**结构化机器接口**（严格比较），让 correctness 真实可见。

## 2. 深度轴设计（真实 GitHub，query="agent framework"，N ∈ {10, 30}）

| Depth | 数据流 | 阶段工具 | 最终排序键 |
|---|---|---|---|
| D1 | search(N) → get_repository × N → sort(forks desc) → take 3 | get_repository | forks |
| D2 | search(N) → get_repository × N → filter(language="TypeScript") → get_contributor_stats × M → sort(total_contributions desc) → take 3 | + get_contributor_stats | total_contributions |
| D3 | D2 的排序结果 → take 5 → list_commits × 5 → sort(total_commits desc) → take 3 | + list_commits | total_commits |

- **每个阶段工具返回一个可排序标量字段**（`forks` / `total_contributions` / `total_commits`）——延续 R4c"字段隔离"：stage-k 的数据只有 stage-k 工具返回，跳过任何一步必然拿不到排序依据 → 严格 checker 必抓。
- **依赖结构**：D2 的 `get_contributor_stats × M` 的输入（M 个 full_name）必须先完成 get_repository × N + filter 才能确定；D3 的 `list_commits × 5` 的输入必须先完成 contributor 排序才能确定。两臂都必须真跑完整链。
- **D1 ≠ D2 ≠ D3**（数据上）：query 不带 language 限制 → top-N 含 Python/Rust 等非 TS 仓库（LangChain/AutoGen/CrewAI…），filter 真实淘汰；forks 冠军、contributors 冠军、commits 冠军通常不是同一批仓库 → 每层 ground truth 不同。
- **冒烟时逐 cell 验证**（数据运气诚实化）：打印每 cell ground truth 与 `kept/total`（filter 淘汰数）。若某 cell filter 未淘汰（kept==N）或各 depth ground truth 重合，在报告标注该 cell 失效，不静默丢弃。

## 3. 严格答案接口（msg 1 的 checker 修复，两臂对称）

- **iterative 臂**：新增 `submit_answer(repositories=["owner/repo", ...])` 工具（pi-ai Tool，非 ToolSpec）。
  - 模型完成任务后**必须**调用它提交最终列表；不调用 = 未提交 = `task_pass=false`（不再从正文 regex 捞答案）。
  - 循环检测到 submit_answer 即终止，提取 `repositories` 数组。
  - `runIterativeToolCalling` 加 `strictAnswer?: boolean`（默认 false，R4b 行为不变）。
- **DSL 臂**：`return` 返回的 runtime 结构化对象本身就是机器接口，直接取 full_name 数组。
- **判定**：`exactAnswerMatch(submitted, groundTruth)` = 长度相等 AND 逐元素相等 AND 顺序一致（`JSON.stringify` 级严格）。新增导出函数，两臂共用；DSL 侧为 `exactAnswerMatch(answered, groundTruth) && correctness.pass`。
- `extractFullNames` / `matchAnswer` 保留（R4b programmaticBenchmark 与历史测试仍用）。

## 4. 改动清单

### 4.1 `src/compiler/registry.ts`（新增 2 个工具 spec）
- `github.get_contributor_stats(full_name: string 必填)` → outputKind `ContributorStats`，描述"获取仓库贡献者统计（贡献者人数与总贡献量）"。
- `github.list_commits(full_name: string 必填, per_page?: int)` → outputKind `CommitStats`，描述"获取仓库提交统计（总提交数与最近提交时间）"。
- 不改既有 4 个工具。

### 4.2 `src/runtime/githubAdapter.ts`（新增 2 个执行器）
- `getJson` 扩展：内部返回 `{ data, headers }`（含 `link` 头），公开签名保持兼容（其余调用点不变）。
- `get_contributor_stats`：`GET /repos/{o}/{r}/contributors?per_page=100` → `{ full_name, contributor_count: length, total_contributions: Σcontributions }`。
- `list_commits`：`GET /repos/{o}/{r}/commits?per_page=1` → 解析 `Link` 头 `rel="last"` 页号 = 总提交数；返回 `{ full_name, total_commits, latest_commit_at: data[0].commit.committer.date }`。Link 解析失败 fallback `total_commits = data.length`。
- 沿用限流有界重试（403/429 已实现，不用动）。

### 4.3 `src/runtime/mockTools.ts`（字段对齐不变式）
- 新增 `get_contributor_stats` / `list_commits` mock 执行器（确定性假数据，供既有 runtime/executionDsl 集成测试保持 registry↔mock 对齐）。

### 4.4 `src/experiments/taskSpec.ts`（多阶段图检查）
- `TaskSpec` 新增：
  - `stageTools?: readonly string[]`：return 数据流上按序（return 侧在前）出现的阶段工具 id；用"路径中 tool 节点序列包含该子序列"判定。
  - `takeCounts?: readonly number[]`：路径上按序出现的 take count（return 侧在前），D3 = `[3, 5]`。
- 既有 `filterConditions / sortKey / sortDesc / takeCount / bindings` 检查保留（`path.find` 最近节点语义天然覆盖最终阶段）。

### 4.5 `src/experiments/iterativeToolCalling.ts`（严格答案接口）
- 新增 `export function exactAnswerMatch(submitted, groundTruth): boolean`（长度 + 逐元素 + 顺序）。
- 新增 `export const SUBMIT_ANSWER_TOOL: Tool`（`submit_answer`，参数 `repositories: Type.Array(Type.String())`）。
- `IterativeOptions.strictAnswer?: boolean`：true 时把 SUBMIT_ANSWER_TOOL 追加进 piTools；每轮 complete 结果若含 submit_answer → 提取 repositories（过滤为字符串数组）、终止循环返回（不执行同轮其他 tool call）；无 tool 轮收尾 / maxed_out 且未 submit → `answered = []`、`task_pass = exactAnswerMatch([], gt)`（未提交即失败），保留 `final_text` 供诊断。

### 4.6 `src/experiments/semanticBenchmark.ts`（R4d 重建，主文件）
- 类型重命名：`R4cTask→R4dTask`、`R4cLevel→R4dLevel`、`buildR4cTasks→buildR4dTasks`；`mode: "r4d-semantic-benchmark"`。
- `buildR4dTasks()`：6 cells（D1/D2/D3 × N∈{10,30}）；`R4dTask { depth, n, k:3, takeCount:3, midTake?:5, filterConditions?(D2/D3: {language:"TypeScript"}), stageSortKey (D1:"forks"/D2:"total_contributions"/D3:"total_commits"), stageTools, dslPrompt, iterativePrompt, tools }`。
- 工具集按 depth：D1 = search+get_repository；D2 = +get_contributor_stats；D3 = +list_commits。
- oracle 纯函数（与 executor 共用 `compareValues`，export 供测试）：
  - `computeDeterministicAnswer(details, task)`（D1，保留原语义）；
  - `computeD2Answer(details, contribStats, task)`、`computeD3Answer(details, contribStats, commitStats, task)`（filter→sort→[take 5]→sort→take→full_name）。
- `fetchR4dDetails(searchTool, repoTool, task)`（export）→ `fetchR4dGroundTruth(searchTool, repoTool, statsTools, task)`（export）：真实链式取数，两臂共用快照。
- ground truth 校验输出：每 cell 打印 `groundTruth`、`kept/total`（filter 淘汰数）、各 depth 是否互异；冒烟用。
- DSL 臂：`task_pass = exactAnswerMatch(answered, groundTruth) && correctness.pass`；taskSpec 按 depth 构造（query="agent framework"、queryTokens=["agent framework"]、stageTools、takeCounts、filterConditions、final sortKey）。
- iterative 臂：`runIterativeToolCalling({ ..., strictAnswer: true })`；prompt 说明必须 submit_answer。
- CLI 不变：`--samples=10 --rounds=5 --parallel=4 --pacing=1000`（120 runs）。
- 汇总表加 depth 列；报告 JSON 结构同 R4c（含 groundTruth、error、final_text）。

### 4.7 测试
- `tests/semanticBenchmark.test.ts`：改 R4d 命名；buildR4dTasks（6 cells、depth 工具集、filterConditions、midTake）；oracle 纯函数（D1/D2/D3、不足 3、升序、filter 淘汰）；fetchR4dGroundTruth（mock 工具链）。
- `tests/iterativeToolCalling.test.ts`：`exactAnswerMatch` 单测（顺序/长度/多余/空）；strictAnswer 循环测试（submit_answer 提取+精确匹配、顺序错→false、长度错→false、正文作答未 submit→answered=[] 且 false、maxed_out 未 submit）。
- `tests/taskSpec.test.ts`：R4c filter describe 改 R4d（条件仅 language）；新增 stageTools / takeCounts 检查用例（D3 双 take、stage 工具顺序错→失败）。
- `tests/githubAdapter.test.ts`：新增 get_contributor_stats（URL/字段/Σ）与 list_commits（per_page=1 + Link 头 total_commits、fallback）用例。
- 既有 executionDsl / runtime 测试不受影响（filter/sort/map 语义未改；registry 加工具不破坏 unknown_tool 逻辑）。

### 4.8 文档
- `experiment_result/语言实验-r4d-sequential-dependency-depth.md`（干净运行后写报告）。
- `.trae/plan/github-demo-roadmap-matrix.md` 加 E7 行。

## 5. 验证步骤

1. `npx vitest run` 全绿（既有 144 + 新增）。
2. 冒烟 `npx tsx src/experiments/semanticBenchmark.ts --samples=1 --rounds=3`：
   - 逐 cell 打印 ground truth / kept-total / 深度互异检查（D1≠D2≠D3、filter 淘汰>0）；
   - 两臂 6 cells 跑通；tokens > 0；DSL 程序编译含全部阶段节点；
   - 若某 cell 数据退化（filter 未淘汰 / 各 depth ground truth 重合）→ 记录并在完整运行报告中标注，不重跑。
3. 完整运行 `--samples=10 --rounds=5 --parallel=4 --pacing=1000`（2 臂 × 6 cells × 10 = 120）。
4. 分析报告：depth 增长时两臂 correctness / round_trips / tokens / model_ingress 的分叉曲线；严格 checker 的实际效果（unsubmitted / 顺序错 / 幻觉名字命中数）。
5. 矩阵 E7、3 个 commit（system / experiment+logs / docs）、代理推送。

## 6. 假设与取舍

- **真实 GitHub**（用户确认）：adversarial separability 只能提高概率无法保证 → 用冒烟"逐 cell 验证 + 报告标注"兜底，不静默丢弃退化 cell。
- **阶段工具返回标量统计字段**（而非新增 aggregate 语言算子）：保持 DSL closed operators 不变（"保持现有架构不变"），rank 键 = 工具返回的字段，oracle 与 executor 语义天然一致。
- **D3 的 commits 排序键 = total_commits**（Link 头解析），tie 概率低；latest_commit_at 仅作诊断字段。
- `list_commits` 默认 per_page=1（只要最新一条 + Link 头），模型传 per_page 时 clamp 1..100。
- N∈{10,30}、P=5（mid take 字面量；若 filter 后 M<5，take(x,5) 按 slice 语义返回 M 个，oracle 一致）。
