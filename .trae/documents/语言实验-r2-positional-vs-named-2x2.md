# R2 语言实验：Positional vs Named invocation（2×2 factorial）

日期：2026-08-07 ｜ 状态：待执行 ｜ 前置：R1（callable reference 三臂）已完成

## Summary

R1 的 friction 数据显示模型摩擦点不是 `tool="..."` 引号，而是 **function invocation shape**（位置参数、无括号 return、参数名幻觉）。R2 用 2×2 factorial 严格测这个新假设：

> **H5：positional 调用形态（map(repos, ...) / take(details, 3) / return top）比 named（map(source=..., ...)）更贴合模型先验，能提升 first-attempt conformance，且不与 few-shot 效应混淆。**

四个臂 = syntax（named / positional）× scaffolding（zero-shot / few-shot），其他一切不变（任务、IR、runtime、tool 表达均用字符串）。

## Current State Analysis

- [parser.ts#L167-L189](file:///Users/apple/Documents/agent-execution-dsl-seed/src/language/parser.ts#L167-L189) `parseArg` 只支持 `<key>=<value>`，位置参数直接 syntax 错误
- [ast.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/language/ast.ts) `ParsedArg.key` 必填，无位置参数概念
- [compiler.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/compiler/compiler.ts) map/take 用 `args.find(item => item.key === key)` 取参；`allowCallableRef` 开关（R1 产物）保留
- [dslGenerationExperiment.ts](file:///Users/apple/Documents/agent-execution-dsl-seed/src/experiments/dslGenerationExperiment.ts) 是三臂结构（R1），success = compile + execute，**无 task_correctness**
- 44 测试全绿

## Proposed Changes

### 1. 语言层：位置参数支持（parser + AST + compiler，实验开关控制）

**ast.ts** — `ParsedArg.key` 改为可选 `key?: string`：位置参数的 key 为 undefined，keyword 参数保持原名。现有 `args.find(item => item.key === key)` 对 key=undefined 的参数天然不匹配，向后兼容。

**parser.ts** — `parseArg` 支持两种形态：
- `<ident>=<value>`：keyword（现状）
- `<value>`：positional（新）。识别：读第一个 token，若为 ident 且下一 token 是 `=` → keyword；否则（后接 `,` 或 `)`）→ positional，该 token 作为值的起始
- positional 的 value 解析复用 keyword 的 value 逻辑（literal / ref 均可）
- 允许 positional 与 keyword 混用（`map(repos, "x", key="full_name")`），parser 无条件支持（parser 保持中性）

**compiler.ts** — 新增 `allowPositionalArgs?: boolean`（默认 false，实验开关，与 allowCallableRef 同模式）：
- 新增诊断码 `POSITIONAL_ARG_NOT_ALLOWED`（摩擦探针）：`allowPositionalArgs=false` 时，compiler 遇到 key 为 undefined 的位置参数报此码（默认语言的拒绝行为，用于统计模型是否自发写位置参数）
- `allowPositionalArgs=true` 时，map/take/return 三个 construct 按位置语义映射：
  - map：position 0 = source（ref），position 1 = tool（literal 字符串）
  - take：position 0 = source（ref），position 1 = count（int literal）
  - return：position 0 = value（ref）
- 冲突诊断：位置参数与 keyword 提供同一槽位（如 `map(repos, "x", source=other)`）→ `duplicate_argument`（复用现有码或新增，计划用现有码 `duplicate_argument` 语义，实现时若不存在则新增 `conflicting_argument`）
- 普通 tool 调用（github.search_repositories）**不支持**位置参数（R2 控制变量：tool 调用的 friction 小，保持 keyword）

### 2. task_correctness 检查器（新文件 src/experiments/taskSpec.ts）

从 IR 层面检查程序是否真的完成任务，与执行成功解耦：
```ts
export interface TaskSpec { query: string; limit: number; mapKey: string; takeCount: number; }
export function checkTaskCorrectness(graph: ExecutionGraph, spec: TaskSpec): { pass: boolean; failures: string[] }
```
检查项：search 节点 query 含关键词 / limit=spec.limit / map 节点 key=mapKey / take 节点 count=takeCount / return 存在且引用最终节点。

### 3. harness 重构（dslGenerationExperiment.ts）

- ARMS 从三臂改为 **2×2 factorial 四臂**：
  - A = named + zero-shot ｜ B = named + few-shot ｜ C = positional + zero-shot ｜ D = positional + few-shot
- `ArmConfig` 字段改为 `{ syntax: "named"|"positional"; fewShot: boolean }`
- buildSystemPrompt：named 臂示例用 keyword，positional 臂示例用位置参数（`map(repos, "github.get_repository", key="full_name", concurrency=5)` / `take(details, 3)` / `return top`）；**四个臂 tool 一律用双引号字符串**（控制变量，避免与 R1 的裸标识符混淆；模型若自发写裸标识符，`EXPECTED_STRING_GOT_CALLABLE_REF` 探针计数）
- compileOptions：positional 臂传 `allowPositionalArgs: true`，named 臂传 false（保留 `POSITIONAL_ARG_NOT_ALLOWED` 探针）
- runOnce 返回值增加 `parse_success` / `task_correctness` 分层：
  - parse_success：parser 无 syntax 错误
  - compile_conformance：编译成功
  - execution_success：编译成功且执行成功
  - task_correctness：编译成功后过 `checkTaskCorrectness`
- summarize 输出每臂四个 metric + error 分布 + 2×2 汇总（syntax effect = (C+D)−(A+B)，few-shot effect = (B+D)−(A+C)，交互项）

### 4. 测试（tests/）

- parser：位置参数解析（`map(repos, "x", key="y")` → 3 个 ParsedArg，第一个 key undefined）
- compiler：`allowPositionalArgs=false` 报 `POSITIONAL_ARG_NOT_ALLOWED`；true 时 map/take/return 位置参数编译成与 keyword 相同 IR；冲突诊断
- taskSpec：checkTaskCorrectness 各检查项正反用例

### 5. 运行与报告

- 命令：`npm run experiment -- --arm=all --samples=10 --rounds=5`（4 臂 × 10 = 40 次 LLM 运行）
- 报告：`logs/experiments/positional-ab-*/report.json` 全量数据 + 控制台 2×2 汇总
- 结果沉淀：`docs/语言实验-第二轮结果.md`（复用第一轮模板：设计/数据表/模型输出摘录/结论/H5 评估）

## Assumptions & Decisions

1. **Positional 只作用于 map/take/return**（construct），tool 调用保持 keyword——控制变量
2. **四臂 tool 一律字符串**，不混入裸标识符——若模型自发写裸标识符，靠 `EXPECTED_STRING_GOT_CALLABLE_REF` 探针记录相关性（friction 联动测量）
3. **parser 无条件支持位置参数**，接受与否由 compiler 开关决定——parser 保持中性，实验开关集中在语义层
4. **样本量默认每臂 10**（与 R1 一致，可 --samples 调整）；4 臂共 40 次调用
5. **success 判定口径不变**（compile + execute），task_correctness 作为独立分层报告，不混入 success——避免"可执行但任务错"被算作成功
6. R1 的三臂 ARMS 结构被 2×2 取代（breaking change 于 harness，不向后兼容）

## Verification

1. `npm test`：新增 parser/compiler/taskSpec 用例 + 既有 44 用例全绿
2. 冒烟：`--samples=1 --arm=all`（4 臂各 1 次）确认 harness 无 bug、检查器工作
3. 完整跑 `--samples=10`，确认报告含四层 metric 与 2×2 汇总
4. 人工抽读模型输出，验证 task_correctness 判定合理
