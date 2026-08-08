# Tasks

按 refactor.md 的 5 个 commit 拆分实施；每个 Task 完成后保持 `npm test` 全绿（本 task 引入的测试更新在该 task 内完成）。每个 Task 对应一个 commit。

- [x] Task 1: 引入统一 ToolDefinition 与 ToolRegistry（commit 1, P0-1）
  - [x] 新建 `src/tools/definition.ts`：`ToolDefinition` 接口（`id` / `label` / `description?` / `inputSchema` / `outputSchema` / `execute(input: unknown): Promise<unknown>`）+ `defineTool` helper（保留 schema 与 execute 同源）
  - [x] 新建 `src/tools/registry.ts`：`ToolRegistry` 类（`register` / `get` / `has` / `all` / `ids`），构造接受 `readonly ToolDefinition[]`
  - [x] `src/compiler/registry.ts`：`githubTools` 迁移为 `ToolDefinition[]`（以 `defineTool` 声明）；保留 `ToolSpec` adapter（`toolSpecOf(definition)`）过渡，compiler / catalog / runtime 迁移期间可用
  - [x] `src/runtime/runtime.ts`：`RuntimeTool` 改为直接使用 `ToolDefinition`；`RuntimeRegistry = ReadonlyMap<string, ToolDefinition>`（`{ spec, execute }` 包装层移除）
  - [x] `src/runtime/githubAdapter.ts` / `src/runtime/mockTools.ts`：构建返回 `RuntimeTool[]`（即 ToolDefinition[]），不再手工 `specOf` 配对；`mockDomainToolSpecs` 过渡期保留（Task 2 迁移为 ToolDefinition）
  - [x] 测试：`tests/registry.test.ts` 覆盖 registry 注册/查询与 `toolSpecOf` adapter；`npm test` 全绿

- [x] Task 2: Schema 化契约 + 运行时输出校验 + required 强制 + 失败模型（commit 2, P0-2/3/4）
  - [x] 为全部工具声明 typebox `inputSchema` / `outputSchema`；删除 `outputKind` 字符串；`src/compiler/catalog.ts` 从 outputSchema 渲染输出类型
  - [x] `src/experiments/iterativeToolCalling.ts` 的 `toPiTools` 改为从 `inputSchema` 渲染 pi 工具参数 schema（原 `ToolParameterSpec` 循环删除）
  - [x] `src/runtime/executor.ts`：`tool` / `map` 节点在工具执行后 `Value.Check(outputSchema, output)`，不匹配 → 抛 `TOOL_OUTPUT_SCHEMA_MISMATCH` 错误（trace 记录）
  - [x] 契约漂移修复：真实 GitHub adapter 的 stats/commits 输出与声明 schema 一致（`{full_name, contributor_count, total_contributions}` / `{full_name, total_commits, latest_commit_at}`）；`createMockGithubTools` 与之一致
  - [x] R4e adversarial 自持契约：`createAdversarialGithubTools()` 用自身 ToolDefinition（schema 为 `{full_name, score}`）；`r4eBenchmark.ts` 的 `R4E_TOOLS` / `task.tools` / iterative 臂工具目录改用 adversarial 定义
  - [x] `src/compiler/compiler.ts` `buildToolNode`：处理完 args 后按 inputSchema 的 `required` 检查缺失参数 → `syntax` 诊断（REQ-3）
  - [x] `src/runtime/runtime.ts`：`ExecutionResult` 判别联合（`status:"success"|"failed"`）；`execute()` 对节点级错误返回 failed（不 throw），图结构错误仍 throw
  - [x] 迁移 `result.ok` 调用方：`semanticBenchmark.ts` / `programmaticBenchmark.ts` / `r4eBenchmark.ts` / `tests/runtime.test.ts` / `tests/iterativeToolCalling.test.ts`（及任何残留）
  - [x] 删除 `ToolSpec` 类型与 `ToolSpec` 形态（`mockDomainToolSpecs` 改为 ToolDefinition）；`r3Tasks.ts` 相应更新
  - [x] 测试：契约漂移单测（adversarial schema 与 real schema 分离）、required 缺失报错、失败模型（节点失败 → `{status:"failed"}` + trace 含 error 节点）；`npm test` 全绿

- [x] Task 3: 编译器符号类型与字段校验（commit 3, REQ-5，可与 Task 4 并行）
  - [x] SymbolTable：编译期维护 语句名 → 输出 schema（typebox `Array` 取 `items` 为元素 schema）
  - [x] `map` 绑定校验：`_.<field>` 字段不存在 → `UNKNOWN_FIELD` 诊断（suggestion 列出元素 schema 可用字段）；字段类型与绑定参数 inputSchema 基础匹配（string / number / int / boolean）→ 不匹配 `config_type_mismatch`
  - [x] 测试：`tests/executionDsl.test.ts` 增补 `UNKNOWN_FIELD` 与字段类型不匹配用例；`npm test` 全绿

- [x] Task 4: 表达式解析器解耦 + AST 进 IR（commit 4, REQ-6，可与 Task 3 并行，依赖 Task 1 的目录/类型基调）
  - [x] `src/runtime/expr.ts` 迁入 `src/language/expression.ts`（或 `src/language/expression/{ast,parser}.ts`）；导出 `ExprNode` / `parseExpr` / `evalExpr` / `isComparisonExpr` 保持同名；compiler 不再 import runtime
  - [x] `src/compiler/ir.ts`：`ComputeNodeSchema` / `SelectNodeSchema` 增加 `expr`（编译期解析的 ExprNode AST，typebox 描述）；`args` 中保留源码字符串（诊断 + taskSpec 图语义检查用）
  - [x] `src/compiler/compiler.ts`：compute/select 编译期 parse 一次，IR 携带 AST
  - [x] `src/runtime/executor.ts`：compute（逐元素）/ select 直接 `evalExpr(AST)`，不再逐次 `parseExpr`
  - [x] 更新 `evalExpr` / oracle 消费方：`r4eBenchmark.ts` oracle、`tests/expr.test.ts` 导入路径
  - [x] 测试：`npm test` 全绿（含 R4e 端到端 DSL=adversarial oracle 用例，验证语义未变）

- [x] Task 5: 冻结 canonical 语法 + 拆分 compiler（commit 5, REQ-7，依赖 Task 1、Task 4）
  - [x] 拆分 `src/compiler/compiler.ts` → `src/compiler/compile.ts`（入口 + `buildNode` 派发）+ `src/compiler/builtins/{map,take,filter,sort,compute,select,join,return}.ts` + `src/compiler/toolCall.ts`（工具调用、参数校验、required 检查、map 绑定字段校验）
  - [x] `CompileExecutionDslOptions` 移除 `allowCallableRef` / `allowPositionalArgs` / `allowMapBinding`；canonical 语法固定（map 调用绑定、位置参数允许、tool 必须字符串字面量 id；key=/lambda/裸标识符形态报专用诊断）
  - [x] R1–R3 变体移入 `src/experiments/languageVariants/`（遗留 compile 包装，保留原诊断码与 IR 行为），仅 `dslGenerationExperiment.ts` 与 `tests/r3Binding.test.ts` 使用
  - [x] `semanticBenchmark.ts` / `programmaticBenchmark.ts` / `r4eBenchmark.ts` / `runtime.test.ts` 的编译调用移除三开关（canonical 即其当前形态）
  - [x] 测试：`npm test` 全绿（`r3Binding.test.ts` 走遗留路径）

- [x] Task 6: 全量验证（commit 6）
  - [x] `npm test` 全部通过（当前基线 211 tests，回归不得低于基线）
  - [x] grep 验证：`src/` 与 `tests/` 无 `ToolSpec` / `outputKind` / `allowCallableRef` / `allowPositionalArgs` / `allowMapBinding` / `result.ok` 残留引用（历史报告/文档除外）
  - [x] `npx tsc --noEmit`（或等效类型检查）通过
  - [x] 冒烟验证 R4e 一条完整链路：`dslGenerationExperiment` 之外至少一次 `r4eBenchmark` samples=1 冒烟跑通（可选，受 token 成本约束时以测试为准）

# Task Dependencies

- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 1]（符号表需要 outputSchema）
- [Task 4] depends on [Task 1]（目录/类型基调）
- [Task 5] depends on [Task 1]、[Task 4]
- [Task 6] depends on [Task 1]–[Task 5]
- [Task 3] 与 [Task 4] 相互独立，可并行
