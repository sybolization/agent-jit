# Canvas DSL 记忆包（2026-08-06）

> 这是一份可迁移的 DSL 项目知识档案，记录"为什么做、做了什么、数据是什么、坑在哪里、下一步去哪"。
> 配套源码：`agent-execution-dsl-seed/`（编译器 + 目录 + 语法 prompt + 实验脚本 + 契约 + 测试）。
> 本文档可独立阅读，作为新项目（Agent Execution DSL demo）的出发点。

---

## 1. 一句话定位

**A small language for LLMs to program heterogeneous agent execution graphs.**
（画布场景）让 LLM 用代码形状的小语言写"节点 + 参数 + 数据流"，编译器确定性翻译成运行时真正执行的图，Harness 统一调度。

## 2. 核心命题与动机

- 现状：画布 agent = "写 JSON 语义图 → Harness 校验 → 规划/执行/reconcile"。JSON 相当于**让模型手写 IR**。
- 用户假设：LLM 不擅长 JSON，擅长代码形状的文本。
- 验证结论（M4 数据）：
  1. **JSON schema 遵循是 LLM 弱项**：封闭 record、引号/键名噪声大；代码符号噪声低。
  2. **约束性质不同**：代码的语法/类型错误由编译器兜底，错误从"运行时才发现"提前到"编译期"。
  3. **整体规划 > 增量修补**：写完整程序一次编译，优于逐条 JSON 补丁。
  4. **Token 差距 10×**：DSL 臂每轮 13.9k tokens vs JSON 臂 141k（后详）。

## 3. 语言设计（Canvas DSL v1，纯 DAG 表达）

### 语法（newline 分隔语句）

```text
<name> = <callee>(<key>=<value>, <key>=<value>, ...)
```

- `<name>` = 节点 ID / 中间命名值（`[a-zA-Z_][a-zA-Z0-9_]*`）
- `<callee>` = 工作流目录 id 或内置节点 kind（`text`、`asset`）
- `<value>` = string | number | boolean | null | array | **name-reference**
- 裸标识符 = 引用先前语句 → 编译成 `node_output` 绑定（**变量引用本身定义边**）
- 字面量参数 → `inputs.literal` 或 `config`（按目录声明路由）

### 值类型体系（编译器内部）

primitive / object / list / optional / reference

### 13 种诊断码（硬错误，附带 line + message + suggestion）

| 码 | 含义 |
|---|---|
| syntax | 语法错误（含 Python 式多行布局、缺左括号等 hint） |
| unknown_tool | 调用了目录外的工作流/节点 |
| undefined_reference / invalid_reference | 引用未定义 / 非法引用（已定义节点不能当工作流调用） |
| duplicate_name / duplicate_argument | 重名 / 重复参数 |
| invalid_key / unsupported_literal | 非法键 / 不支持的字面量 |
| type_mismatch | 引用类型兼容检查（源节点输出 kind 必须匹配端口） |
| schema_invalid | 编译产物自校验 `Value.Check(SemanticCanvasGraphV1Schema)` |
| incomplete_input | 软提示：图通过但缺必填输入（readyness incomplete） |
| unknown_parameter | **未声明参数**（LLM 幻觉参数名，与后端 `config_field_not_declared` 对齐） |
| config_type_mismatch | 字面量类型校验（int/float/bool/file/combo/枚举，镜像后端 normalize） |

### 关键接口：目录自动翻译（不依赖人工维护）

`renderWorkflowDslCatalog(workflowTools)`：同一份 `workflow_tools`（与 agent 数据同源）自动渲染为 DSL 签名目录。规则：
- 引用输入（kind image/audio/video）可接节点输出或字面量 asset id；参数只能接字面量（进 config）
- 同键名既是引用又是参数 → 只渲染为引用
- `*` = 必填且无默认值；null 默认值不注入（对齐后端 exclude_none）
- 内部执行键（filename_prefix/output_prefix）过滤；类型归一（textarea→text、select→text）

### 语法 prompt（给 LLM，`canvasDslGrammar.ts`）

7+1 节：语句格式 / 值类型 / 数据流 / 参数路由 / 内置节点 / 诊断 / 编写要点 / 完整示例（few-shot）。硬约束：**只输出 DSL 代码、不用 Markdown 围栏、单行格式、任何诊断必须修订重提直至成功**。

## 4. 架构与文件清单

```
src/domain/canvas/canvasDsl.ts        编译器：手写 tokenizer + 递归下降 parser（错误恢复、批量诊断）+ 语义编译（参数路由/类型校验/契约自校验）
src/domain/canvas/canvasDslCatalog.ts 目录自动翻译（workflow_tools → DSL 签名）
src/domain/canvas/canvasDslGrammar.ts 语法规范 prompt（给 LLM）
src/contracts/semanticCanvas.ts       SemanticCanvasGraphV1 契约（编译输出，typebox）
src/contracts/canvas.ts               CanvasWorkflowTool 契约（编译输入）
src/experiments/dslHarness.ts         实验脚本：工具循环 + conformance + usage 采集
tests/canvasDsl.test.ts               23 个用例（语义等价/70 节点/hint/未知参数/类型）
docs/canvas-agent-code-dsl-plan.md    完整设计文档
```

依赖：仅 `typebox`（编译器 + 契约）；`dslHarness.ts` 额外依赖 pi-agent-core 等运行时（新项目需重写）。

### 编译器确定性

同一段 DSL → 同一张图（可 hash、可复用、可离线测试）。纯函数、无副作用。

## 5. 关键设计决策（DEC）

- **DEC-1**：作者面 = DSL（代码形状）；可执行物 = `SemanticCanvasGraphV1`（JSON 契约不变）。
- **DEC-2**：编译器确定性输出语义图；runtime（规划器/分层/reconcile/状态机）**零改动**。
- **DEC-3**：否决"节点 = 任意函数"——执行身份机制基于声明式 JSON 的稳定 hash，任意代码不可 hash/diff；画布是可视化产物；编译器必须确定性。
- **DEC-4**：DSL 永不长大成通用语言（无任意循环副作用/外部 I/O/运行时不确定性）。
- **DEC-5（实验确认）**：**DSL 用工具调用提交，而非自由文本回复**——LLM 工具参数纪律根治散文混入；两臂同为工具循环对比公平；实验工具定义可直接平移产品化。
- **DEC-6（实验确认）**：给 agent 的数据必须与产品**同源同形**——`references` 无 required 字段，必须从同名 parameter 派生，否则可选多输入误判必填。

## 6. 实验数据（M4）

### easy case（10 节点）三连跑

| 轮次 | 变更 | Success | 首过率 | 均时 | 失败模式 |
|---|---|---|---|---|---|
| Run 1 | 工具调用基线 | 4/5 | 40% | 25.0s | 78 处 syntax（Python 式多行布局）；1 轮软错后放弃 |
| Run 2 | +few-shot +修到绿 +hint | 5/5 | 20% | 34.8s | syntax 归零；可选多输入误判必填（数据 bug） |
| Run 3 | +required 派生修正 | 5/5 | **80%** | **22.7s** | 仅 1 次把已定义节点名当工作流调用（hint 可收敛） |
| JSON 臂 | 真实产品 agent | 1/1 | — | 129.7s | 3× 目录搜索 0 结果 + 1× 事务绑定歧义 |

### hard case（70 节点）双口径

- 编译器口径：5/5 成功、首过 4/5、均时 65.5s、均 68.6 节点
- M2 加强口径：5/5 成功、首过 4/5、均时 70.6s、均 62.4 节点；type_mismatch/schema_invalid 零触发

### conformance 实锤（15 节点，编译图 POST 到真实 apply_subgraph_transaction）

- 修复前接受率 **60%** → 暴露编译器缺口：LLM 幻觉参数（如 `prompt` 而非 `positive_prompt`）编译器未拦，后端以 `config_field_not_declared` 拒绝
- 补齐 `unknown_parameter` + `config_type_mismatch` 后接受率 **100%**，零误伤（修复前失败 DSL 重编译恰好命中与后端一致的 4 处）

### token 归因（15 节点，真实 usage，2026-08-06）

| 指标 | DSL 臂（5 轮均值） | JSON 臂（2 轮成功均值） | 倍数 |
|---|---|---|---|
| totalTokens | 13,948 | 141,089 | **10.1×** |
| input（未缓存） | 2,189 | 21,803 | **10.0×** |
| output | 1,929 | 7,069 | 3.7× |
| cacheRead | 9,830 | 112,217 | **11.4×** |
| 耗时 | 35.9s | 127.4s | 3.5× |
| 成功率 | 5/5 | 2/3（1 轮 900s 超时） | — |
| 事务失败率 | 0 | 5/10（50%） | — |

**归因结论**：
1. Token 压缩是主导（~10×）——DSL 输出紧凑代码、一次编译全图；JSON 输出冗长工具参数、多轮增量事务。
2. 失败率是放大器——JSON 50% 事务失败率 → 重试 → 每轮重放全部历史（cacheRead 占 79.5%）；失败轮 token 是干净轮的 2.6×。
3. 两者互为因果，根因是"**一次编译全图 vs 多轮增量事务**"的形态差异。
4. 成本口径：cacheRead 计费远低于普通 input，实际金钱差距 < token 差距。

## 7. 经验教训（坑）

1. **数据必须与产品同源**：harness 早期从 spec 拉数据导致可选输入误判必填，系统性偏严——实验数据 bug 比模型 bug 更致命。
2. **LLM 会写 Python 式布局**：多行参数 → 78 处 syntax。解法：单行格式警示 + 缺左括号 hint。
3. **LLM 会幻觉合理参数名**：`prompt` vs `positive_prompt`。解法：`unknown_parameter` 编译期拒绝（校验前移），代价是首过率降、修复轮增，但后端不再拒。
4. **编译器校验必须与后端对齐**：compiler 全绿 ≠ 后端接受。conformance 实锤（60%→100%）是唯一验证手段。
5. **修到绿硬约束消除提前放弃**：soft-incomplete 后模型直接结束回合 → "任何诊断必须修订重提"。
6. **类型校验用 `Value.Errors()[0]` 的 message 而非 path**（path 可能不存在）。

## 8. 向新 demo 的映射（Agent Execution DSL）

当前 DSL 是"画布语义图"专用（workflow 节点 + 字面量/引用）。新 demo 要上升一层为**通用异构执行图**：

| 当前 Canvas DSL | 新 Agent Execution DSL |
|---|---|
| workflow / text / asset 节点 | `tool`（外部工具/API）、`agent`（LLM/sub-agent）、`compute`（确定性程序）、`control`（branch/parallel/retry/join） |
| `SemanticCanvasGraphV1` 输出 | 通用 graph template / dynamic dataflow program（`map` 运行时展开 N 个节点） |
| 参数路由 inputs/config | 值类型体系（primitive/object/list/optional/reference）+ 管道符 `\|>`（filter/sort/take/map 全确定性、不经过 LLM） |
| 编译器骨架（tokenizer/parser/诊断/错误恢复） | **可直接复用** |
| 目录自动翻译 | 工具签名渲染（同类机制） |
| 8+ 个 construct 目标 | `let` / `call`(tool) / `agent` / `compute` / `if` / `parallel` / `map` / `return` |

核心设计原则（新 demo 保持）：
- **agent 是一等 primitive**：和 tool 一样出现在程序里（`let x = agent researcher { task, input }`），多智能体 = 图 + agent 节点，而非另一套系统。
- **compute 是关键**：数据搬运/过滤/排序/聚合不经过 LLM，才真正减少 agent loop。
- **源码不像图**：变量引用定义边，编译器产生图——LLM 不管理 node ID/edge/引用一致性。
- **第一版刻意不用 `workflow` 关键字**：避免被理解成 Zapier/Temporal/n8n 的又一 DSL；定位是"LLM 生成 execution graph 的语言"。
- **动态展开图**（第二阶段）：`while agent.should_continue(state)` 进入动态控制流。

## 9. 建议的三个 demo 案例（差异最大化）

- **案例 A 工具编排**：`search → fetch×N → extract → rank`——测 token/latency
- **案例 B 多智能体**：`researcher / critic / engineer → judge`——agent/program 同图
- **案例 C Agent+程序混合**：`SQL → deterministic aggregation → agent interpretation → tool side effect`——LLM 不再承担数据搬运与普通计算
