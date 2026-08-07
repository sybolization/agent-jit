# P1+P2 最小闭环：解耦 Parser + 定义 ExecutionIR

> 状态：待执行（Plan Mode）
> 日期：2026-08-07
> 依据：`.trae/plan/github-demo-roadmap-matrix.md`（P1/P2 阶段）+ `docs/任务短期目标.md` + `docs/关键判断.md`
> 已确认决策：范围 P1+P2（四行 DSL → IR，不执行）；沿用现有语法 `<name> = <callee>(key=value, ...)`；装 vitest + 补 `semanticGraph.ts` 让现有测试成为可运行防护网。

---

## 1. 目标（Summary）

让项目从"canvas 专用编译器"跨出第一步，形成**独立 Agent Execution DSL 的骨架**：

1. **P1**：把 [canvasDsl.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/domain/canvas/canvasDsl.ts)（913 行单文件）中的 tokenizer / parser / AST / 诊断泛化为通用语言前端 `src/language/`，canvas 语义编译层留在原文件并复用前端。对外 API 不变，旧测试零改动全绿。
2. **P2**：定义通用 `ExecutionIR`（`src/compiler/`），让下面四行示例 DSL 编译出 IR（**不执行**）：

```text
repos = github.search_repositories(query="agent framework", limit=10)
details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)
top = take(source=details, count=5)
return(value=top)
```

完成后：`DSL → Parser → ExecutionIR` 链路成立，为 P3（runtime）铺路。

---

## 2. 现状分析（Current State Analysis）

| 事实 | 位置 | 影响 |
|---|---|---|
| tokenizer（`tokenize`，纯函数）与 `Parser`（产出中性 `ParsedStatement { line, name, callee, args }`）**不含 canvas 概念**，已可复用 | [canvasDsl.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/domain/canvas/canvasDsl.ts#L96-L456) | P1 基本是"搬移 + 泛化诊断"，不是重写 |
| 13 种诊断码 `CanvasDslDiagnosticCode` 硬编码在 canvas 文件，是前端唯一 canvas 耦合点 | [canvasDsl.ts#L37-L50](file:///Users/apple/Documents/agent-execution-dsl-seed/src/domain/canvas/canvasDsl.ts#L37-L50) | 需泛化为 `DslDiagnostic`（`code: string`），canvas 侧保留常量并重新导出 |
| 语义编译层（`buildNode`、`workflowArgSpecs`、`literalKindError` 等）是 canvas 专属，不动 | [canvasDsl.ts#L458-L912](file:///Users/apple/Documents/agent-execution-dsl-seed/src/domain/canvas/canvasDsl.ts#L458-L912) | P1 只动前端；P2 新建独立 compiler，不碰 canvas 语义 |
| 测试框架为 **vitest**，但**未安装**；无 `tsconfig`、`package.json` 无 `scripts` | [tests/canvasDsl.test.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/tests/canvasDsl.test.ts) / [package.json](file:///Users/apple/Documents/agent-execution-dsl-seed/package.json) | 测试当前**不可运行**，必须先修基建 |
| `tests/canvasDsl.test.ts` import 了 **不存在的 `../domain/canvas/semanticGraph.js`**（`toSemanticCanvasGraph` 用于 DSL 结果与手写 JSON 对照） | 测试 L6 | 需补最小实现 |
| 依赖已装：`@earendil-works/pi-agent-core` + `typebox`（Node v22，npm 可用） | package.json | P2 用 typebox 定义 IR schema |
| `src/node_modules/` 有一整套依赖树（zod/openai 等），**来源不明**，被 .gitignore 忽略 | src/node_modules | 外部状态，计划**不触碰** |

---

## 3. 具体改动（Proposed Changes）

### 阶段 A：测试基建修复（前置，先让防护网可用）

| # | 文件 | 做什么 | 为什么 |
|---|---|---|---|
| A1 | `package.json` | `npm install -D vitest`；新增 `"scripts": { "test": "vitest run", "test:watch": "vitest" }` | 让测试可运行、可重复 |
| A2 | `src/domain/canvas/semanticGraph.ts`（新增） | 实现 `toSemanticCanvasGraph(canvasGraph, { canvasVersion, workflowTools }) → SemanticCanvasGraphV1`：把 `{ nodes: [{id, type, data:{workflowId, inputValues}}], edges: [{id, source, target, data:{parameterKey}}] }` 翻译成语义图（workflow 节点 → `kind:"workflow"` + `inputs/config/input_ports/outputs/readiness`；edge → `node_output` binding；输出 `output` 取源节点 `outputs[0].name`） | 补测试缺失依赖；结构须与 `buildNode` 输出**逐字段对齐**（测试用 `toEqual` 断言） |
| A3 | 基线验证 | `npm test` | 21 个用例全绿 = 防护网基线 |

> 兜底：若 vitest 解析 `import "../x.js"`（指向 `.ts`）失败，新增 `vitest.config.ts` 配置 `resolve` 处理该映射。

### 阶段 B：P1 解耦 parser（通用语言前端）

| # | 文件 | 做什么 | 为什么 |
|---|---|---|---|
| B1 | `src/language/diagnostics.ts`（新增） | 定义 `DslDiagnostic { line, code: string, message, suggestion? }` | 前端不再绑定 canvas 诊断码 |
| B2 | `src/language/ast.ts`（新增） | 定义 `Token / TokenType / LiteralValue / ParsedValue / ParsedArg / ParsedStatement / TokenizeResult / ParseResult` | 前端数据结构中性化 |
| B3 | `src/language/tokenizer.ts`（新增） | 搬移 `tokenize`（现 L96-193），签名改为使用 `DslDiagnostic` | 纯搬移，行为不变 |
| B4 | `src/language/parser.ts`（新增） | 搬移 `Parser` 类（现 L226-456），诊断改用 `DslDiagnostic` | 纯搬移，行为不变 |
| B5 | `src/domain/canvas/canvasDsl.ts`（修改） | 删除已搬走的代码，改为 `import` 前端；**对外 API 不变**：`compileCanvasDsl / CanvasDslCompileError` 保持，`CanvasDslDiagnostic` 重新导出为 `DslDiagnostic` 别名，`CanvasDslDiagnosticCode` 保留为 canvas 侧常量 union | 兼容旧测试，零测试改动 |
| B6 | 验证 | `npm test` | 21 用例全绿，证明解耦无行为变化 |

### 阶段 C：P2 通用 ExecutionIR（新编译器）

| # | 文件 | 做什么 | 为什么 |
|---|---|---|---|
| C1 | `src/compiler/ir.ts`（新增） | 用 typebox 定义并导出（TS 类型 + schema）：`ValueExpr`（literal/ref）、`ToolNode`、`MapNode`、`ComputeNode`（op 预留 `take/filter/sort`）、`ReturnNode`、`ExecutionGraph { schema_version: "1", nodes }` | IR 是编译器与 runtime 的契约，延续 typebox 惯例（LLM 不该写 IR，但 IR 是确定结构） |
| C2 | `src/compiler/registry.ts`（新增） | 定义 `ToolSpec { id, label, parameters: [{key, kind, required}], outputKind }`；手写 4 个 GitHub tool spec（search_repositories / get_repository / get_languages / list_contributors）| P2 只做"签名描述"，真实 API 调用留 P4 |
| C3 | `src/compiler/compiler.ts`（新增） | `compileExecutionDsl(source, { tools }) → { graph, diagnostics }`：复用 P1 tokenizer/parser，语义编译规则：tool callee → `ToolNode`（参数校验：`unknown_parameter / config_type_mismatch / duplicate_argument / invalid_reference`，沿用 canvas 已验证经验）；`map` → `MapNode`（`source` 必须为 ref、`tool` 必须在 registry、`key` 必填、`concurrency` 默认 5）；`take` → `ComputeNode`（`source` ref + `count`）；`return` → `ReturnNode`；未注册 callee → `unknown_tool`；输出用 `Value.Check(ExecutionGraphSchema)` 自校验；硬错误抛 `ExecutionDslCompileError`（与 canvas 同构） | 四行示例的最小闭环；filter/sort/agent 留 P3+ |
| C4 | `tests/executionDsl.test.ts`（新增） | 用例：① 四行示例编译成功（4 节点、节点类型正确、`source/details/top` 引用边正确、schema 校验通过）② 确定性（两次编译 JSON 相同）③ 诊断：`unknown_tool`（未注册 callee）、`undefined_reference`（前向引用）、`duplicate_name`、`unknown_parameter`（tool 参数幻觉） | 新编译器自己的防护网，继承"编译期拒绝"经验 |
| C5 | 验证 | `npm test` | 21 旧用例 + 新用例全绿 |

### 阶段 D：收尾

| # | 文件 | 做什么 |
|---|---|---|
| D1 | `README.md`（可选，征求确认） | Layout 增加 `src/language/`、`src/compiler/` 两行 |
| D2 | `.trae/plan/github-demo-roadmap-matrix.md`（可选） | P1/P2 行标注"已落地" |

---

## 4. 假设与决策（Assumptions & Decisions）

1. **沿用现有语法**（用户已确认）：`<name> = <callee>(key=value, ...)` 单行 statement；`map/take/return` 作为语言级 construct（不进 tool registry）
2. **诊断码泛化**：前端 `code: string`；canvas 侧保留 13 码常量并重新导出（兼容）；P2 复用相同的码集合
3. **P2 IR 范围**：只实现 `tool / map / take / return`；`filter / sort / agent` 类型可预留但编译器不接（遇到报 `unknown_tool`），避免范围蔓延
4. **P2 不执行**：GitHub tool 只是 registry 描述，无网络调用（P4 接入）
5. **不触碰 `src/node_modules/`**（来源不明的外部状态）
6. **不自动 commit / push**：变更留待用户确认（遵循既有约定）
7. **暂不引入 tsconfig**：vitest 自带转译即可跑测试；类型检查体系后续阶段再配（避免本次范围扩大）

## 5. 验证步骤（Verification）

1. 阶段 A：`npm test` → canvas 21 用例全绿（基线）
2. 阶段 B：`npm test` → 全绿，**测试文件零改动**（API 兼容证明）
3. 阶段 C：`npm test` → 全绿（含新增 executionDsl 用例）
4. 手动冒烟：`node --experimental-strip-types` 或 vitest 内打印四行示例的 IR JSON，人工确认节点/引用结构符合预期
5. 汇报 git 变更清单（未提交）

---

## 6. 风险与兜底

| 风险 | 兜底 |
|---|---|
| vitest 无法解析 `.js` 后缀 → `.ts` 的 ESM import | 新增 `vitest.config.ts` 配置 `resolve` |
| `toSemanticCanvasGraph` 与 `buildNode` 输出结构不一致（toEqual 失败） | 以测试逐个对齐；实现只覆盖测试实际用到的 workflow/edge 形态 |
| P1 搬移时误改行为 | 以"测试零改动 + 全绿"为硬性验收 |
| IR 范围蔓延（想加 filter/while 等） | 只实现四行示例所需 4 类节点，其余明确报 `unknown_tool` |
