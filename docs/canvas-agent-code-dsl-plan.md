# 画布 Agent 代码化：DSL 编译回图计划

> 状态：M0/M1/M2/M3 校验已实现，实验（M4）完成——easy/hard 对比 + conformance 实锤（60%→100%）
> 日期：2026-08-05（初稿）／2026-08-06（实现与实验）
> 背景：画布 agent 语义化主线（f5a1519→2e2310b）之后的架构演进讨论
> 定位：`todo/` 已被 Git 排除，本文件仅本地持续追踪，不随代码提交

## 1. 背景与动机

- 现状：画布 agent 像"写代码交给编译器（harness）运行"——agent 产出语义图 JSON（`SemanticCanvasGraphV1`）与图补丁事务，harness 负责校验、规划（DAG 分层）、提交 generation job、reconcile 写回。
- 用户问题：不写 JSON、直接编程，是不是 LLM 更擅长的？想以此提升 agent 能力。
- 结论：是，但精确说——LLM 强在"代码形状的文本"，而不是"任意程序"：
  1. JSON schema 遵循是 LLM 弱项（封闭 record、引号/键名噪声）；代码符号噪声低，错误率低、省 token；
  2. 约束性质不同：代码的语法/类型错误由编译器兜底，错误从"运行时才发现"提前到"编译期"；
  3. 整体规划 > 增量修补：写一段完整程序再编译，优于逐条 JSON 补丁。

## 2. 核心区分与架构决策

- 区分"作者面（LLM 写的东西）"与"可执行物（harness 跑的东西）"，两者可以分离。
- **DEC-1**：作者面 = 一门小 DSL（代码形状）；可执行物 = 现有 `SemanticCanvasGraphV1`（JSON 不变）。
- **DEC-2**：DSL 编译器确定性输出语义图；runtime（规划器、分层、签名复用、reconcile、状态机）零改动。
- **DEC-3**：否决"节点 = 任意 Python/TS 函数"，理由：
  1. 执行身份机制（`workflow_node_definition_snapshot` / `execution_signature` / `dependency_snapshot`）基于声明式 JSON 的稳定 hash，任意代码不可 hash、不可 diff；
  2. 画布是人类可编辑的可视化产物，代码不是好的编辑面；
  3. 编译器必须确定性（纯函数、可测试、可离线推演）；任意代码意味着跑解释器，安全与可复现性全丢。
- **DEC-4**：DSL 永远不长大成通用语言（无任意循环副作用、无外部 I/O、无运行时不确定性）。

## 3. 层次 1（第一步）：DSL 编译回图

### 3.1 DSL 定义
- 领域专用语言，语法封闭、极小（预计 50～100 行语法）、完全确定。
- 同一段 DSL 永远编译出同一张图（可 hash、可复用、可离线测试）。

### 3.2 语法草案
```text
img  = generate(prompt, size=1024)               # → workflow 节点（带 workflow_id）
tags = classify(img, labels=["safe", "nsfw"])    # → 分类节点
out  = route(tags, safe=img, nsfw=fallback(img)) # → 分支糖（编译期展开为 DAG）
```
- 赋值语句：`<name> = <call>(<arg>=<value>)`，`<name>` 即节点 ID / 中间命名值。
- 参数：字面量 → `inputs.literal` 或 `config`；`<name>` 引用 → `inputs.node_output`。
- 控制流糖（if/loop/route）编译期展开为等价 DAG；第一版是否包含见第 5 节开放问题。

### 3.3 编译目标
- 输出 `SemanticCanvasGraphV1`（agent-runner/src/contracts/semanticCanvas.ts），契约与现有完全一致。
- 编译器与现有 `semanticGraph.ts` 同层：多一条"DSL 文本 → 语义图"的输入路径。

### 3.4 收益
- 错误率下降（编译期校验反馈给 agent，少重试、少 recovery）；
- token 消耗下降；
- 规划视野从局部增量修补变为整体程序。

## 4. 层次 2（后续，能力天花板）：运行时控制流节点

- 目标：图本身支持 if/loop/route 节点，运行时按结果分发执行，突破"无环、无分支、无循环"的天花板。
- 需要改动：规划器（分支展开/循环展开）、reconcile、节点状态机、输出写回语义。
- DSL 的循环/分支糖是第一层铺垫；层次 2 让糖变为真实运行时语义。
- 触发信号：DSL 场景出现真实的"重试 3 次""评分低走 B 路径"等需求。

## 5. 第一步（层次 1）开放问题

- **Q1** 第一版 DSL 语法范围：只做"赋值 + 函数调用 + 字面量参数"（纯 DAG 表达），还是第一版就含分支/循环糖（编译期展开）？
- **Q2** 编译器语言与位置：agent-runner（TypeScript，与 `semanticGraph.ts` 同层）？
- **Q3** 编译期校验范围：编译器自己做类型/必填/环路校验（给 agent 结构化错误），还是只翻译、错误留给后端 harness？
- **Q4** 错误反馈格式：编译错误如何变成 agent 可读的修复建议（错误码 + 位置 + 建议）？
- **Q5** 接入方式：agent 写入工具是否改为"提交 DSL → 编译 → 提交语义图"？`read_graph` 是否保持只读 JSON？
- **Q6** 实验对比：如何量化"LLM 写 DSL vs 写 JSON"的错误率与 token 差异？
- **Q7** 节点标题/描述：DSL 是否可声明 title/描述（编译成节点 title）？

## 6. 里程碑（草案）

- **M0** 语法与编译器设计：收敛第 5 节开放问题，产出 DSL 语法规范
- **M1** DSL 词法/语法解析器 + 编译器（DSL 文本 → `SemanticCanvasGraphV1`）
- **M2** 编译期校验与结构化错误反馈
- **M3** 接入 agent 写入流（DSL → 编译 → 现有事务提交），保留 JSON 路径为兼容
- **M4** 实验对比与验收（DSL vs JSON 错误率 / token；真实场景 text_to_image → image_to_video）
- **M5**（未来，层次 2）控制流节点运行时支持

## 7. 当前明确不做

- 不把节点变成任意代码 / 解释器；
- 不修改 `SemanticCanvasGraphV1` 契约；
- 不修改后端规划、执行、reconcile、状态机；
- 不做完整的通用编程语言（循环副作用、外部 I/O 等）。

## 8. 实现进展（2026-08-06）

| 项 | 位置 | 说明 |
|---|---|---|
| DSL 编译器（M0/M1/M2） | `agent-runner/src/domain/canvas/canvasDsl.ts` | 手写 tokenizer + 递归下降 parser（错误恢复、批量诊断）+ 语义编译；对照 workflow catalog 把参数路由到 `inputs`/`config`；确定性输出、排序稳定；硬错误 12 码（含 **type_mismatch 引用类型兼容**、**schema_invalid 契约自校验**、**unknown_parameter 未声明参数**、**config_type_mismatch 字面量类型校验**）/ 软提示 incomplete_input |
| config 字面量校验（M3 对齐） | `canvasDsl.ts` | 镜像 Harness normalize/validate 管道：字符串→数字/布尔归一化 + 按参数 kind 校验（int/float/bool/file/combo/枚举/标量），编译期拒绝未知 config 键——与真实 `apply_subgraph_transaction` 的 `config_field_not_declared`/`config_type_mismatch` 对齐 |
| DSL 语法规范（给 LLM） | `agent-runner/src/domain/canvas/canvasDslGrammar.ts` | 7+1 节：语句格式、值类型、数据流、参数路由、内置节点、诊断、编写要点、完整示例（few-shot）；含"单行格式"警示、"修复纪律"硬约束；示例全部使用真实目录 id |
| 工作流目录自动翻译（关键接口） | `agent-runner/src/domain/canvas/canvasDslCatalog.ts` | `renderWorkflowDslCatalog(workflowTools)`：同一份 `workflow_tools`（与 agent 同源）自动渲染为 DSL 签名目录；引用型输入标注、同名去重、`*`=必填且无默认值、内部键过滤、类型归一 |
| 编译器针对性诊断 hint | `canvasDsl.ts` | 三种常见错误给专属 suggestion：把已定义节点当工作流调用 / 缺左括号（单行格式）/ 逐行写参数（Python 式布局） |
| 实验脚本（DSL 臂，工具调用版） | `agent-runner/src/experiments/dslHarness.ts` | 复用 pi-agent-core `Agent` 工具循环，单工具 `apply_canvas_dsl`（compile 编译 → 结构化诊断 error）；支持多轮、attempt 级 DSL 原文留档、summary.md |
| 测试 | `src/__tests__/canvasDsl.test.ts` / `canvasDslCatalog.test.ts` | 23 个：语义等价（与 JSON 手写图全等）、70 节点 hard 程序、hint 断言、目录渲染、unknown_parameter / config_type_mismatch / 字符串归一化 / 内置节点自由 config |

### 关键设计决策（实验中确认）

- **DSL 用工具调用提交，而非自由文本回复**（用户提出）：LLM 的"工具参数纪律"根治散文混入/围栏包裹；两臂同为工具循环，对比公平；实验工具定义可直接平移给 M3。
- **给 agent 的数据必须与产品同源同形**：harness 早期从 spec 接口拉数据，`references` 无 `required` 字段（required 在 parameter 上）→ 所有可选多输入（video_2..6）被误判必填，实验系统性偏严。修复：与 `canvas_agent_tooling.py` 一致，从同名 parameter 派生 required；null 默认值不注入（对齐后端 exclude_none）。

## 9. 实验结论（M4，easy case 三连跑）

口径：同一 LLM 网关；easy case prompt = 构建 10 节点工作流；DSL 臂 = 工具调用版；JSON 臂 = 现有 `test/agent-harness-test/harness_batch.py` 真实 agent。

| 轮次 | 变更 | Success | 首过率 | 均时 | 失败模式 |
|---|---|---|---|---|---|
| Run 1 | 工具调用基线 | 4/5 | 40% | 25.0s | 78 处 syntax（Python 式多行布局）；1 轮收到 soft 错误后放弃 |
| Run 2 | +few-shot +修到绿约束 +编译器 hint | 5/5 | 20% | 34.8s | syntax 归零、放弃消失；可选多输入被误判必填（数据 bug） |
| Run 3 | +required 派生修正 | 5/5 | **80%** | **22.7s** | 仅 R3 首次把已定义节点名当工作流调用（hint 已修复） |
| JSON 臂（1 轮） | 真实产品 agent | 1/1 | — | 129.7s | 3× 目录搜索 0 结果 + 1× 事务绑定歧义 |

结论：

1. **工具调用消除了散文/围栏失败**，few-shot + 单行警示 + hint 把 syntax 错误从 78 归零；
2. **"修到绿"硬约束消除了提前放弃**（Run 1 的失败轮次在 Run 2 后消失）；
3. **首过率从 40% → 80% 的主因是数据形状修正**（可选输入误判必填），验证"实验数据必须与产品同源"；
4. 残留失败模式（1/5）：模型把**自己定义的节点名当工作流调用**——编译器已给针对性 hint，能收敛；
5. 用时方面 DSL 臂 ~22.7s vs JSON 臂 ~129.7s（5.7×，但 JSON 仅 1 轮样本，待补 5 轮基线）。

## 10. 下一步

- **conformance 实锤（已完成，见第 12 节）**：60% 接受率暴露编译器缺口 → 补齐 unknown_parameter/config_type_mismatch 后回到 100%
- **JSON 臂 5 轮基线**：补齐公平对比
- **M3 产品化**：把 `apply_canvas_dsl` 工具注册进 agent-runner 真实工具集，编译后复用现有语义事务提交（编译器校验已与后端对齐，可直接平移）
- **M5（层次 2）**：控制流节点运行时支持（触发信号见第 4 节）

## 11. 完成记录

| 日期 | 事项 | 证据 |
|---|---|---|
| 2026-08-05 | 方向讨论与计划落档 | 本文档；讨论结论见第 2 节 DEC |
| 2026-08-06 | M0/M1/M2：DSL 编译器 + 语法规范 + 目录自动翻译 + 诊断 hint + 类型/契约校验 | `canvasDsl.ts`、`canvasDslGrammar.ts`、`canvasDslCatalog.ts` |
| 2026-08-06 | M4 easy case 三连跑 + JSON 基线 | `logs/agent/dsl-harness-tool/2026-08-06T08-19-05-857Z`（Run1）等 3 份 batch.json；`logs/agent/harness-batches/20260806T080739Z`（JSON） |
| 2026-08-06 | M4 hard case 编译器口径基线 | `logs/agent/dsl-harness-tool/2026-08-06T08-37-45-433Z/batch.json` |
| 2026-08-06 | M4 hard case M2 加强口径（type/schema 零触发） | `logs/agent/dsl-harness-tool/2026-08-06T08-43-23-715Z/batch.json` |
| 2026-08-06 | M4 conformance 实锤：60% 接受率暴露编译器缺口 → 补齐 unknown_parameter/config_type_mismatch → 100% | `logs/agent/dsl-harness-tool/2026-08-06T08-56-04-441Z/batch.json`（修复前）与 `2026-08-06T09-05-48-022Z/batch.json`（修复后） |

## 12. Conformance 实锤（2026-08-06）

口径：15 节点工作流 × 5 轮；DSL 臂编译成功的图，反构为 add-only `SubgraphTransactionV1` 提交到真实 `SemanticCanvasHarness.apply()`（与产品 `apply_subgraph_transaction` 同一校验管道，空画布 + base_canvas_version=null）。

### 修复前（60% 接受率）

| Round | 节点 | 编译器 | 后端接受 | 拒绝原因 |
|---|---|---|---|---|
| 1 | 15 | 通过 | reject | `config_field_not_declared: prompt` 未声明（multi_image_to_image 真实参数为 positive_prompt） |
| 2 | 17 | 通过 | accept | — |
| 3 | 19 | 通过 | accept | — |
| 4 | 15 | 通过 | accept | — |
| 5 | 16 | 通过 | reject | `config_field_not_declared: prompt` 未声明（ltx_image_to_video_multi_action 真实参数为 user_prompt） |

结论：**"编译器口径 100% 通过"存在 40% 假阳性**——LLM 幻觉出语义合理的参数名（`prompt`），编译器对非引用字面量参数无未知键校验，直接塞进 config，只有真实后端能拦截。这是此前实验的最后一个盲区。

### 编译器修复（对齐 Harness）

- **unknown_parameter**（对标 `config_field_not_declared`）：workflow 节点的字面量参数必须声明于该工作流目录（text/asset 内置节点保持自由 config）；
- **config_type_mismatch**（对标同名 harness 错误）：按参数 kind 校验（int/float/number/boolean/file/combo/枚举/标量），并镜像 harness 的「字符串→数字/布尔」归一化后再写 config；
- `fetchWorkflowTools` 补映射 `options`，使 select/combo 枚举校验在实验中真实生效；
- 语法 prompt 与 DSL 目录补「参数名必须与目录一致、不得自创」约束。

### 修复后（100% 接受率）

| Round | 节点 | 调用 | 首过 | 后端接受 |
|---|---|---|---|---|
| 1 | 15 | 2 | no | accept（15/15） |
| 2 | 15 | 1 | yes | accept（15/15） |
| 3 | 16 | 2 | no | accept（16/16） |
| 4 | 15 | 4 | yes | accept（15/15） |
| 5 | 15 | 2 | no | accept（15/15） |

- conformance 接受率 5/5 = **100%**，success 5/5，无拒绝；
- 首过率从 100% 降到 40%、均调用 1.8→2.2：编译器现在正确拒绝幻觉参数（3× unknown_parameter、1× invalid_reference），模型在工具循环内修正后通过——这是"校验前移"的预期代价，换来的是提交后端不再被拒；
- 验证方式：修复前两条失败 DSL 重编译，恰好命中与后端一致的 4 处 unknown_parameter（无多余误伤）。

**盲区闭合**：编译器验收 ≈ 后端完整图校验（type/schema/参数声明/字面量类型全部对齐）。

## 13. 7× 差距归因分析（token vs 失败率/轮次，2026-08-06）

口径：15 节点 × 同一提示词。为拿真实 token，两臂补齐 usage 采集：
- **DSL 臂**：pi-agent-core 每条 assistant 消息带 usage（pi-ai 从 provider 流解析），`dslHarness.ts` 新增 `aggregateUsage` 落盘；
- **JSON 臂**：`agentEvents.ts` emitCompleted 汇总 usage → 后端 `canvas_agent_conversations.py` 事件透传补 usage → `harness_batch.py` 从 `agent_run_completed` 提取。

### 数据（成功轮）

| 指标 | DSL 臂（5 轮均值） | JSON 臂（2 轮成功均值） | 倍数 |
|---|---|---|---|
| totalTokens | 13,948 | 141,089 | **10.1×** |
| input（未缓存） | 2,189 | 21,803 | **10.0×** |
| output | 1,929 | 7,069 | 3.7× |
| cacheRead（缓存命中） | 9,830 | 112,217 | **11.4×** |
| 耗时 | 35.9s | 127.4s | 3.5× |
| 成功率 | 5/5（100%） | 2/3（1 轮 900s 超时） | — |
| 事务失败率 | 0（conformance 100%） | 5/10 次 apply 失败（50%） | — |

JSON 臂单轮明细：r1 total=78,985（in 16,871）；r3 total=203,193（in 26,735，cacheRead 168,675）——r3 因失败重试使 input/cacheRead 比 r1 翻 2.6×。

### 归因结论

1. **Token 压缩是主导**（~10× totalTokens）。DSL 输出紧凑代码、一次编译全图；JSON 输出冗长工具参数 JSON、多轮增量事务。
2. **失败率/轮次是放大器**：JSON 臂 50% 事务失败率 → 重试 → 每轮重放全部历史（cacheRead 占 79.5%）。失败轮（r3）token 是干净轮（r1）的 2.6×。DSL 臂 conformance 100%、零后端拒绝。
3. **两者互为因果**：token 少 → 调用快、出错少；出错多 → 重试 → token 更多。根因是**"DSL 一次编译全图" vs "JSON 多轮增量事务"的形态差异**。
4. **成本口径提示**：cacheRead（缓存读）在主流网关计费远低于普通 input（约 10 倍差价），实际成本差距小于 token 差距；但缓存吞吐本身占用模型上下文窗口与延迟，仍构成瓶颈。

### 数据来源
- DSL 臂：`logs/agent/dsl-harness-tool/2026-08-06T10-00-51-993Z/batch.json`（5 轮，usage 全量）
- JSON 臂：`agent-runner/src/experiments/logs/agent/harness-batches/20260806T101005Z/batch.json`（3 轮，2 成功 1 超时）
