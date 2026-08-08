# 代码规范化：统一工具注册 + Schema 契约 + 编译器结构化 Spec

## Why

实验代码已侵入核心代码（`.trae/plan/refactor.md` 的静态 review 结论）：

- 一个工具被拆成三处：`compiler/registry.ts` 的 `ToolSpec`、`runtime/runtime.ts` 的 `RuntimeTool`、`githubAdapter.ts` / `mockTools.ts` 再手工配对——没有唯一事实源。
- `outputKind: string` 对 compiler 无实际语义，导致**真实契约漂移**已经发生：registry 描述 `get_contributor_stats` / `list_commits` 返回统一 `{full_name, score}`（R4e 改写），但真实 GitHub adapter 实际返回 `{full_name, contributor_count, total_contributions}` / `{full_name, total_commits, latest_commit_at}`。
- `compiler.ts` 已约 883 行（tool call + 7 个 construct + R1/R2/R3 语言实验开关混在一起）。
- compiler import runtime（`../runtime/expr.js`），依赖方向倒置；表达式编译期 parse 一次、运行期又逐元素 parse 一次。
- runtime 同时存在 throw 与 `ok:false` 两套失败协议。

本 spec 按 refactor.md 的 5 个 commit 落地，目标：把代码库从"实验代码集合"收敛为"可接普通 Agent 的 Harness core"。

## What Changes

- **统一工具定义与注册（P0-1）**：引入 `ToolDefinition`（id / label / description / inputSchema / outputSchema / execute）与 `ToolRegistry`，Compiler、DSL catalog、Runtime 消费同一事实源；`githubTools` 以 `defineTool` 注册。
- **Schema 化契约 + 运行时输出校验（P0-2）**：`outputKind` 字符串替换为 typebox `inputSchema` / `outputSchema`；runtime 每次工具执行后校验输出，不匹配 → `TOOL_OUTPUT_SCHEMA_MISMATCH`；修复 real adapter 与 mock 的契约漂移。
- **必填参数编译期强制（P0-3）**：`buildToolNode` 处理完 args 后检查所有 `required` 参数，缺失 → 编译诊断（当前缺失的 P0 bug）。
- **运行时失败模型统一（P0-4）**：`ExecutionResult` 改为判别联合 `{status:"success"|"failed"}`；`execute()` 对节点级执行错误不再 throw，返回带完整 trace 的 failed；图结构错误（缺依赖节点等）仍 throw。
- **编译器符号类型与字段校验（P1 类型化）**：维护 SymbolTable（语句名 → 输出 schema），先实现最有价值的类型链：map 绑定的 `_.<field>` 做字段存在性校验（不存在 → `UNKNOWN_FIELD`，suggestion 列出可用字段）+ 与绑定参数的字段类型基础匹配。
- **表达式解析器解耦 + AST 进 IR（P1-6/7）**：`expr.ts` 从 runtime 迁入 `src/language/`；compute/select 的 IR 节点携带编译期解析好的 `ExprNode` AST，runtime 只 evaluate 不再 parse；保留源码字符串供诊断与图语义检查。
- **冻结 canonical 语法 + 拆分 compiler（P1-5）**：`compiler.ts` 拆分为 `compile.ts` + `builtins/*.ts` + `toolCall.ts`；从 `CompileExecutionDslOptions` 移除三个语言实验开关（`allowCallableRef` / `allowPositionalArgs` / `allowMapBinding`），冻结 canonical 语法：map 用调用绑定形态、位置参数允许、tool 必须双引号字符串 id；R1–R3 实验变体移入 `src/experiments/languageVariants/` 遗留路径（仅 `dslGenerationExperiment` 与 R3 测试使用）。
- **BREAKING**：`CompileExecutionDslOptions` 删除三个开关；`ExecutionResult.ok` → `result.status`；`ToolSpec` 迁移后删除；`expr` 导入路径变更。

## Impact

- Affected specs：`src/compiler/{registry,compiler,catalog,ir}.ts`、`src/runtime/{runtime,executor,expr,githubAdapter,mockTools}.ts`、`src/language/`（新增 expression）、`src/experiments/{taskSpec,r4eBenchmark,semanticBenchmark,programmaticBenchmark,iterativeToolCalling,dslGenerationExperiment,r3Tasks}.ts`、`tests/*`（约 10 个文件）。
- 不受影响：`src/language/{ast,parser,tokenizer,diagnostics}.ts`（语言前端中性层）、canvas 域（`src/domain/canvas`、`src/contracts`）、`dslHarness.ts`、`plotReport.ts`（读 report.json）、真实实验日志。
- 明确**不在本次范围**（refactor.md "可以逐渐收敛"部分）：物理移动 `githubAdapter.ts` / `mockTools.ts` 出 runtime 目录、MCP adapter、`execute_program` 接入普通 Agent。

## ADDED Requirements

### Requirement: 统一工具定义与注册（REQ-1）

系统 SHALL 提供唯一的 `ToolDefinition`（`{ id, label, description?, inputSchema, outputSchema, execute(input): Promise<unknown> }`）与 `ToolRegistry`（register / get / has / all / ids），作为 Compiler、DSL catalog、Runtime 的共同事实源。

#### Scenario: 一次注册，多处消费

- **WHEN** 工具以 `defineTool(...)` 声明并注册进 `ToolRegistry`
- **THEN** compiler 的工具目录、DSL 调用签名渲染、runtime 执行均从同一份定义取到签名与执行体，不存在第二处手工配对

#### Scenario: RuntimeRegistry 直接存定义

- **WHEN** 构建 `RuntimeRegistry`（`ReadonlyMap<string, ToolDefinition>`）
- **THEN** executor 的 `tool` / `map` 节点直接从定义取 `execute`，不再需要 `{ spec, execute }` 包装层

### Requirement: Schema 化契约与运行时输出校验（REQ-2）

系统 SHALL 以 typebox `inputSchema` / `outputSchema` 作为工具契约；runtime SHALL 在每次工具执行后用 `outputSchema` 校验输出，不匹配 → 节点失败并携带 `TOOL_OUTPUT_SCHEMA_MISMATCH` 错误（trace 记录）；真实 GitHub adapter 与 `createMockGithubTools` SHALL 与声明 schema 一致；R4e adversarial mock SHALL 自持契约（own ToolDefinition，schema 声明 `{full_name, score}`），不再借用 githubTools 的 spec。

#### Scenario: 真实 adapter 与声明 schema 一致

- **WHEN** 真实 GitHub adapter 的 `get_contributor_stats` 执行
- **THEN** 其输出（`{full_name, contributor_count, total_contributions}`）通过其声明 schema 的校验；R4d 依赖的 `total_contributions` / `total_commits` 排序键保持可用

#### Scenario: 未来契约漂移被立即暴露

- **WHEN** 某工具输出与声明 outputSchema 不匹配（如多返回、缺字段、字段类型错）
- **THEN** 运行时报 `TOOL_OUTPUT_SCHEMA_MISMATCH`，节点 trace 记 error，整体结果 failed——不再静默发生

#### Scenario: R4e adversarial 自持契约

- **WHEN** `createAdversarialGithubTools()` 构建工具
- **THEN** 其 stats / commits 工具使用自己的定义（schema 为 `{full_name, score}`，id 仍为 `github.get_contributor_stats` / `github.list_commits`），`r4eBenchmark` 的 `task.tools` / iterative 臂工具目录使用 adversarial 定义而非 githubTools 过滤结果

### Requirement: 必填参数编译期强制（REQ-3）

系统 SHALL 在 `buildToolNode` 处理完参数后，检查 `inputSchema` 声明的全部 `required` 参数是否已提供，缺失 → `syntax` 诊断（`<tool> 缺少必填参数“<key>”`）。

#### Scenario: 缺必填参数编译失败

- **WHEN** DSL 书写 `x = github.search_repositories()`（`query` 为 required）
- **THEN** 编译诊断包含"缺少必填参数 query"，编译抛 `ExecutionDslCompileError`

### Requirement: 运行时失败模型统一（REQ-4）

系统 SHALL 将 `ExecutionResult` 定义为判别联合 `{ status: "success", result, trace, totalDurationMs } | { status: "failed", error, trace, totalDurationMs }`；`execute()` SHALL 对节点级执行错误返回 failed 结果（trace 完整包含出错节点），不向上 throw；图结构错误（缺依赖节点、未知节点）仍 throw。

#### Scenario: 节点执行失败不抛出

- **WHEN** 图中某工具执行抛错（如 schema 不匹配、上游非数组）
- **THEN** `execute()` 返回 `{ status: "failed", error, trace, totalDurationMs }`，trace 中对应节点 status=error；调用方（实验与测试）不再捕获 throw

#### Scenario: 调用方迁移到 status

- **WHEN** 实验代码与测试读取执行结果
- **THEN** 使用 `result.status === "success"`，不再使用 `result.ok`

### Requirement: 编译器符号类型与字段校验（REQ-5）

系统 SHALL 在编译期维护 SymbolTable（语句名 → 输出 schema，数组取元素 schema）；`map` 绑定引用 `_.<field>` SHALL 校验字段存在性（不存在 → `UNKNOWN_FIELD` 诊断，suggestion 列出元素 schema 的可用字段）与字段类型对绑定参数的基础匹配（string / number / int / boolean）。

#### Scenario: 绑定不存在的字段

- **WHEN** DSL 书写 `map(repos, github.get_repository(full_name=_.repo_name))` 而 repos 元素 schema 无 `repo_name`
- **THEN** 编译报 `UNKNOWN_FIELD`，suggestion 列出可用字段（`full_name` / `stars` / ...）

#### Scenario: 绑定字段类型与参数不匹配

- **WHEN** 绑定字段是 string 而参数 schema 要求 number
- **THEN** 编译诊断字段类型不匹配（`config_type_mismatch` 语义）

### Requirement: 表达式解析器解耦与 AST-IR（REQ-6）

系统 SHALL 将表达式解析器（`parseExpr` / `evalExpr` / `isComparisonExpr` / `ExprNode`）从 `src/runtime/expr.ts` 迁入 `src/language/`（compiler 不再 import runtime）；compute / select 的 IR 节点 SHALL 携带编译期解析好的 AST（一次 parse），并保留源码字符串（供诊断与 taskSpec 图语义检查）；runtime 执行 SHALL 只 evaluate AST，不再逐元素 parseExpr。

#### Scenario: 编译一次，执行不再解析

- **WHEN** DSL 含 `compute(details, ratio="forks / stars")` 与 `select(ratio, "ratio > 0.15")` 并编译
- **THEN** IR 的 compute / select 节点携带已解析 AST；executor 执行 compute（逐元素）与 select 时直接 eval，不再调用 `parseExpr`

#### Scenario: oracle 与 executor 语义一致

- **WHEN** benchmark oracle（r4eBenchmark）与 executor 求值同一表达式
- **THEN** 两者共用 `language` 的 `evalExpr`，"执行语义 == oracle 语义"不因迁移改变

### Requirement: canonical 语法冻结与编译器拆分（REQ-7）

系统 SHALL 将 `compiler.ts` 拆分为 `src/compiler/compile.ts`（入口 + 节点派发）+ `src/compiler/builtins/{map,take,filter,sort,compute,select,join,return}.ts` + `src/compiler/toolCall.ts`（工具调用 + 参数校验）；`CompileExecutionDslOptions` SHALL 移除 `allowCallableRef` / `allowPositionalArgs` / `allowMapBinding`，冻结 canonical 语法（map 调用绑定形态、位置参数允许、tool 必须字符串字面量 id）；R1–R3 实验变体（key= / lambda / callable-ref 裸标识符）SHALL 移入 `src/experiments/languageVariants/` 遗留编译路径，仅 `dslGenerationExperiment` 与 R3 相关测试使用。

#### Scenario: production 编译无实验开关

- **WHEN** 调用 `compileExecutionDsl(source)`（无 options）
- **THEN** 以 canonical 语法编译：`map(xs, github.get_repository(full_name=_.full_name))`、`take(x, 3)`、`return x` 通过；`map(repos, tool="...", key="full_name")` 或 lambda 形态报专用诊断

#### Scenario: R3 实验可复现

- **WHEN** `dslGenerationExperiment`（R3 各臂）与 `r3Binding.test.ts` 编译 key / call / lambda / callable-ref 形态
- **THEN** 通过 `src/experiments/languageVariants/` 遗留路径获得与原实验一致的诊断码与 IR

## REMOVED Requirements

### Requirement: outputKind 字符串（P0-2）

**Reason**: 对 compiler 无语义（不知道字段形状），无法做字段检查；已造成 real/mock 契约漂移。由 `outputSchema` 取代，catalog 与 pi 工具定义从 schema 渲染输出类型。
**Migration**: `renderExecutionToolCatalog` 与 `toPiTools` 改为消费 `ToolDefinition` / schema。

### Requirement: 三个语言实验开关（allowCallableRef / allowPositionalArgs / allowMapBinding）

**Reason**: R1–R3 已给出结论，canonical 语法冻结后开关不再属于 production API（refactor.md P1-5）。
**Migration**: canonical 固定为"map 调用绑定 + 位置参数允许 + 字符串 tool id"；R3 变体移入 `src/experiments/languageVariants/` 遗留路径。

### Requirement: ExecutionResult.ok 布尔协议（P0-4）

**Reason**: 与 throw 并存形成两套失败协议，`ok:false` 分支实际不可达。
**Migration**: 判别联合 `status: "success" | "failed"`；实验与测试全部迁移。

### Requirement: ToolSpec 类型

**Reason**: 统一 ToolDefinition 后不再需要并列的 spec 类型（refactor.md P0-1"一次注册，多处消费"）。
**Migration**: Task 1 保留 adapter 过渡；Task 2 完成后删除 `ToolSpec` 及 `mockDomainToolSpecs` 的 ToolSpec 形态（改为 ToolDefinition）。
