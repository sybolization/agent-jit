# R4e：Branching + Recombination（分支 + 数据重组，mock adversarial dataset）

日期：2026-08-07 ｜ 前置：[R4d 报告](file:///Users/apple/Documents/agent-execution-dsl-seed/experiment_result/语言实验-r4d-sequential-dependency-depth.md)、[R4d 计划](file:///Users/apple/Documents/agent-execution-dsl-seed/.trae/documents/语言实验-r4d-sequential-dependency-depth.md)
状态：**已确认**（用户：表达式字符串；N∈{15,30} 单任务，2 cells × 10 × 2 臂 = 40 runs）

## 1. 背景与目标

R4d 证明了 sequential dependency depth（D1→D3）下 iterative 的成本放大（tokens 比值 6.5x→9.7x→12.2x），但正确率 120/120 全对——因为 D3 是"深而直的流水线"，每一层都在告诉模型下一步做什么、用哪个字段、怎么排序，iterative 只是在**照流程执行**。

R4e 换复杂度类型：**Branching + recombination**。用户定义：

> 前面的结果决定后面走哪条路，而且最后还要把多条路径的数据重新组合。
> 不是"多了一步"，而是模型必须保持三个东西不出错：**分支判断**（哪个 repo 调哪个工具）、**身份对应**（工具结果必须对应回正确 repo）、**重新合并**（两条路径不同字段，最后统一 score）。

难度轴（R4e 起同时记录，不再只用"工具层数"）：

| 轴 | 定义 | R4e 值 |
|---|---|---|
| Dependency depth | 有几层顺序依赖 | 4（details → 分支决策 → 阶段工具 → join → 最终计算） |
| Branching factor | 中途有多少种路径 | 2（ratio>0.15 → contributors；否则 → commits） |
| Recombination burden | 最终要合并多少来源的数据 | 3 来源（details + 两路 score）按 full_name 合并 |
| State cardinality | 模型同时要维护多少对象的状态 | N×（ratio + 分组 + score） |

**数据后端：mock/adversarial dataset（用户明确要求）**。保证：
- 分错一次支 → 答案一定变化；漏掉一次 join → 答案一定变化；用错一个字段 → 答案一定变化。
- 真实 GitHub 数据容易"做错一步但 top3 恰好没变"（R4d 的弱 cell 教训），mock 可完全控制。

## 2. 任务设计（用户草图落地）

```
search N repos → get_repository × N
→ compute ratio = forks / stars          # 必须真算
→ branch：ratio > 0.15 → get_contributor_stats（contributors 路径）
          ratio ≤ 0.15 → list_commits（commits 路径）
→ 两路都产出同名字段 score（可比较的统一尺度）
→ join 回原 repo 数据（按 full_name，身份对应）
→ select score ≥ 阈值                     # 满足阈值才保留
→ sort(score desc) → take 3
```

**关键设计：两条路径产出同名字段 `score`**——join 后每个 repo 只有一个 score（来自它走的那条路径），排序直接按 score。这样不需要 if/三元表达式，DSL 表达式面保持最小（算术 + 比较）。

**adversarial 数据要求**（mock 构造）：
- forks 与 stars 的排序不同（用错字段 → 分组反 → 答案变）；
- ratio 分布跨越 0.15 边界，且边界附近存在"contributors score 高而 commits score 低"的 repo（分错分支必错）；
- score 只能来自路径工具（不可从 details 推断）；两路 score 数值可比；
- 阈值真实筛人（有 score 低于阈值但 forks 高、容易"以为能进"的 repo）；
- 正确 top3 **混合两条路径**（否则某条路径对答案无影响，branching 失效）；
- 正确 top3 与第 4 名有安全距离（任何单步错误都会把正确 repo 挤出）。

## 3. 语言扩展（3 个新关键字，零 tokenizer/parser 改动）

用**表达式字符串**（字面量已支持），表达式由 compiler/executor 内部解析（受限白名单，非完整表达式 VM）：

| 关键字 | 语法 | IR | 语义 |
|---|---|---|---|
| `compute` | `ratio = compute(details, ratio = "forks / stars")` | `ComputeNode{op:"compute", args:{out:"ratio", expr:"forks / stars"}}` | 元素级：浅拷贝 + 计算新字段 |
| `select` | `high = select(ratio, "ratio > 0.15")` | `ComputeNode{op:"select", args:{pred:"ratio > 0.15"}}` | 谓词过滤（`> >= < <= == !=`），是 filter 的推广 |
| `join` | `merged = join(ratio, contrib, commit, key="full_name")` | **新 JoinNode** `{kind:"join", sources:[...], key}` | 多输入：sources[0] 为基准，其余按 key 匹配后合并字段（基准已有字段不覆盖） |

表达式白名单（evalExpr，executor + oracle 共用）：字段引用（裸标识符，从元素取值）、数字/字符串字面量、`+ - * /`、括号、比较运算符（`> >= < <= == !=`）。拒绝函数调用/变量赋值/字符串拼接等。表达式必须是**元素级纯函数**（不引用其他节点，不引用数组级聚合）。

DSL 程序形态（给模型的示例）：
```
repos = github.search_repositories(query="agent framework", limit=30)
details = map(repos, github.get_repository(full_name=_.full_name))
ratio = compute(details, ratio = "forks / stars")
high = select(ratio, "ratio > 0.15")
low = select(ratio, "ratio <= 0.15")
contrib = map(high, github.get_contributor_stats(full_name=_.full_name))
commit = map(low, github.list_commits(full_name=_.full_name))
merged = join(ratio, contrib, commit, key="full_name")
kept = select(merged, "score >= 100")
ranked = sort(kept, key="score", desc=true)
top = take(ranked, 3)
return top
```

### IR / 执行层改动
- `src/compiler/ir.ts`：`ComputeNodeSchema.op` union 加 `"compute"`/`"select"`；新增 `JoinNodeSchema`（`{id, kind:"join", sources: string[], key: string}`）；`ExecutionNodeSchema` 加 join。
- `src/runtime/dependencies.ts`：join → `sources`（多输入调度已支持，只需返回全部依赖）。
- `src/runtime/executor.ts`：`evalExpr`（受限表达式求值）；`compute`（浅拷贝+新字段）；`select`（谓词过滤）；`join`（基准优先合并，key 索引 Map）。
- `src/compiler/compiler.ts`：`buildComputeNode`（out/expr 必填字符串字面量，expr 预解析校验）、`buildSelectNode`（pred 必填字符串字面量）、`buildJoinNode`（sources 位置参数 + key 必填）；`buildNode` dispatch 加入三个关键字。**expr/pred 编译期预解析**（格式错 → 编译诊断，repair 可修）。

### taskSpec 图语义检查扩展（`src/experiments/taskSpec.ts`）
- `computeExprs?: Record<string, string>`（期望 compute 节点：out + expr 精确匹配）。
- `selectPreds?: readonly string[]`（期望 select 节点按序出现，谓词规范化后匹配——`>`/`<=` 与边界字面量，容忍空格）。
- `joinSpec?: { sources: readonly string[]; key: string }`（期望 join 节点的 sources 集合 + key）。
- 沿 return 数据流路径检查（join 节点在 path 里，sources 多依赖时 returnDataflowPath 需扩展：join 的 source 取 sources[0] 继续回溯）。

## 4. mock/adversarial 数据（`src/runtime/mockTools.ts` 或新文件）

- 新 `createAdversarialGithubTools()`（或参数化现有 mock）：确定性数据，spec 与 githubTools 一致。
- search：返回 N 个固定 `{full_name}`；get_repository：返回 `{full_name, forks, stars, language}`（forks/stars 反序设计）；get_contributor_stats → `{full_name, score}`；list_commits → `{full_name, score}`。
- **score 不可从 forks/stars 推断**：contributors 路径 score 依赖 contributor_count（独立随机种子），commits 路径 score 依赖 total_commits。
- 构造规则（实现时确定性生成 + 关键点覆盖）：
  - 30 个仓库，ratio = forks/stars ∈ [0.05, 0.5] 覆盖 0.15 两侧；
  - 边界 0.145–0.155 放 4 个"陷阱"仓库（contributors score 高但 commits score 低的在 ≤0.15 侧，反之在 >0.15 侧）；
  - 两路各 6-8 个高 score（>100），其余低 score；
  - 正确 top3 混合两路且与第 4 名差距 ≥30%（单步错误必变答案）。

## 5. 实验设计

- **cells**：R4e 分支任务 × N ∈ {15, 30}（State cardinality 梯度）。samples=10、rounds=5（DSL repair）、parallel=4、mock 无 pacing 需求（无真实限流）。
- 两臂：DSL（一次 submit_program 写全图）vs iterative（strictAnswer submit_answer）。
- ground truth：确定性 oracle 执行同 pipeline（共用 evalExpr 语义）。
- 指标：沿用 R4d（tokens/ingress/egress/runtime_internal/roundTrips/execMs/task_pass）+ 报告记录 4 难度轴。
- report.json 结构：`mode: "r4e-branching-recombination"`，`results[].depth = "R4e"`（或 "R4e-N15" 等），plotReport.ts 兼容（depth 非 D/L 前缀时按出现顺序排）。
- iterative prompt：描述分支规则 + 必须 submit_answer。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/compiler/ir.ts` | ComputeNode op 加 compute/select；新增 JoinNodeSchema |
| `src/compiler/compiler.ts` | buildComputeNode / buildSelectNode / buildJoinNode + dispatch |
| `src/runtime/executor.ts` | evalExpr（受限表达式）+ compute/select/join 执行 |
| `src/runtime/dependencies.ts` | join → sources |
| `src/experiments/taskSpec.ts` | computeExprs / selectPreds / joinSpec 检查 + path 对 join 的处理 |
| `src/runtime/mockTools.ts` | createAdversarialGithubTools（确定性对抗数据） |
| `src/experiments/semanticBenchmark.ts` | R4e 任务构造 + oracle + 两臂跑（或新建 r4eBenchmark.ts） |
| 测试 | ir/compiler/executor/taskSpec/mock/adversarial oracle/benchmark 结构 |

## 7. 测试与验证

1. 单元：evalExpr（算术/比较/缺字段/非法表达式报错）；compute/select/join executor（含 join 基准优先、缺失 key 不合并）；compiler 三关键字（语法/未知参数/表达式预解析失败诊断）；taskSpec（computeExprs/selectPreds/joinSpec 通过与失败）；mock 数据（30 仓库确定性、两路 score 混合、top3 混合）。
2. `npx vitest run` 全绿（既有 168 + 新增）。
3. 冒烟 `--samples=1 --rounds=3`：DSL 程序编译/执行含全部新节点；iterative 走分支；tokens>0；GT 打印 + 4 难度轴。
4. 完整运行 `--samples=10 --rounds=5`。
5. 报告 + 矩阵 E8 + 3 commit + push。

## 8. 假设与取舍

- **表达式字符串而非结构化参数**（待确认）：贴用户画的 `ratio > 0.15`；compiler 预解析保证错误在编译期暴露（repair 可修）。
- **join 基准优先不覆盖**：同一 repo 只可能命中一条路径（互斥分支），安全。
- **score 同名字段消解 if 表达式**：保持 DSL 表达式面 = 算术 + 比较（最小）。
- **filter 保留**（R4c 等值）与 select（比较谓词）并存；select 是新关键字。
- mock 数据确定性：跑多轮可复现；无限流/网络脆弱性。
- 风险：模型对三个新关键字不熟 → 编译失败多 → repair 轮消耗（这正是语言压力测试要测的）；iterative 臂可能漏 select（阈值）→ 严格 checker 抓。
