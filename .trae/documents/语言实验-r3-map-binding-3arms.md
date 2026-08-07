# R3 语言实验：map data binding 三臂（key= / 占位符调用 / lambda）

日期：2026-08-07 ｜ 状态：计划 ｜ 前置：R2（positional vs named 2×2，修复后重跑 H5 获强支持）已完成

## Summary

R2 剩下的主要摩擦点是 `map` 的 `key="full_name"` 配置协议——模型想表达"对每个 repo 调用 `get_repository(repo.full_name)`"，却被要求"配置一个 MapNode"。R3 不再研究 named vs positional，专测 **map 的 element→argument 数据绑定语法**：

> **H5（R3）：显式的数据流表达（`_.field → callable argument`）相比元数据式 binding（`key="field"`），能提高模型的 zero-shot binding correctness 与 compiler-guided repairability，而无需引入完整 lambda/control-flow semantics。**

三臂（全部 zero-shot + repair，few-shot 留 R3b）：

| 臂 | 语法形态 | 哲学 | 实现位置 |
|---|---|---|---|
| A | `map(repos, "github.get_repository", key="full_name")` | 配置 Map 节点（当前 DSL 基线） | 现有语法 |
| B | `map(repos, github.get_repository(full_name=_.full_name))` | 描述数据怎么流入调用 | parser 新增 call 表达式 |
| C | `map(repos, lambda repo: github.get_repository(full_name=repo.full_name))` | 描述一个真正的小程序（上限组） | parser 新增受限 lambda |

任务：**5 个**（3 GitHub + 2 mock），binding 形态覆盖"单字段同名 / 单字段异名 / 多字段"。样本：**3 臂 × 5 任务 × 10 样本 = 150**（用户已明确不考虑调用成本）。核心指标：**binding correctness**（编译成功 + 绑定映射正确才算），保留 repair conversion / avg repair rounds / tokens per success / error 分布。

## Current State Analysis

- **tokenizer**（`src/language/tokenizer.ts`）：标识符规则允许点号（`github.get_repository`、`repo.full_name`、`_.full_name` 均天然成为**单 ident**，L69-77）；符号集 `=(),[]` **无冒号**（lambda 需要加 `:`）。
- **parser**（`src/language/parser.ts`）：`parseValue` 只支持 string/number/bool/null/array/ident-ref（L208-285），**不支持嵌套 call 表达式与 lambda**；`parseArg` 双形态（keyword/positional）已就绪（R2 遗产）。
- **AST**（`src/language/ast.ts`）：`ParsedValue.kind = "literal" | "ref"`，需要扩展 `"call" | "lambda"`。
- **compiler**（`src/compiler/compiler.ts`）：`buildMapNode` 从 `key=` 取单字段（L259-319）；`allowPositionalArgs` / `allowCallableRef` 开关模式已确立（实验开关集中在语义层）；`buildToolNode` 的 `unknown_parameter` / `config_type_mismatch` 校验可复用。
- **IR**（`src/compiler/ir.ts`）：`MapNode = { id, kind:"map", source, tool, key: string, concurrency }`——`key: string` 是**单字段绑定**，B/C 臂的多字段需要改为 `bindings: Record<string, string>`。
- **runtime**（`src/runtime/executor.ts`）：map 分支 `tool.execute({ [node.key]: itemRecord[node.key] })`（L82-85），单字段消费，需改为遍历 `bindings`。
- **mockTools**（`src/runtime/mockTools.ts`）：仅 4 个 GitHub 工具，需新增 mock 域（crm / email）支撑任务 4/5。
- **harness**（`src/experiments/dslGenerationExperiment.ts`）：2×2 四臂单任务；`summarize` / `computeEffects` / 修复循环（已修复 gateway）可直接继承。
- **taskSpec**（`src/experiments/taskSpec.ts`）：沿 return 数据流路径检查（R2 修复），需新增 binding 检查维度。
- 现有测试 59 全绿；`MapNode.key` 迁移会影响现有测试与 taskSpec。

## Proposed Changes

### 1. 语言层：parser 中性支持三种 binding 形态

**tokenizer.ts**：符号集 `"=(),[]"` → `"=(),[]:"`（仅 lambda 的冒号）。

**ast.ts** — `ParsedValue` 扩展两种 kind：
```ts
{ kind: "call", callee: string, args: ParsedArg[] }      // B 臂：github.get_repository(full_name=_.full_name)
{ kind: "lambda", param: string, body: ParsedValue }     // C 臂：lambda repo: <call>
```
`ParsedValue` 是递归类型，`ParsedArg.value` 可承载任意 kind。

**parser.ts** — `parseValue` 增加两个分支（在现有 literal/ref/array 之前判断）：
- ident 后紧跟 `(` → **call 表达式**：`callee = ident.value`，`parseArgsAndEnd` 复用（吃 `(`、参数、`)`、行尾）。
- ident 为 `lambda` → **lambda 表达式**：吃 `lambda`，读参数 ident，确认下一个 token 是 `:`（吃掉），`body = parseValue()`（递归，期望 call）。
- 其余分支不变；错误恢复沿用 `skipToNewline`。

> 说明：`_.full_name` / `repo.full_name` 已天然是单 ident，属性访问无需新语法，靠**约定前缀**（`_.` → 元素本身；`<param>.` → 元素本身）在编译器层展开。

### 2. IR：MapNode key → bindings（breaking）

**ir.ts** — `MapNodeSchema` 的 `key: Type.String()` 改为 `bindings: Type.Record(Type.String(), Type.String())`：
```ts
// A 臂 key="full_name"            → bindings: { full_name: "full_name" }
// B 臂 full_name=_.full_name      → bindings: { full_name: "full_name" }
// C 臂 full_name=repo.full_name   → bindings: { full_name: "full_name" }
// 多字段 B/C                     → bindings: { to: "email", name: "name" }
```
同步更新 `ExecutionNodeSchema` 引用与现有测试（R2 已有 breaking 先例：harness 三臂→2×2 取代）。

### 3. Compiler：三开关 + bindings 构建

**compiler.ts**：
- `CompileExecutionDslOptions` 新增 `allowMapBinding?: "key" | "call" | "lambda"`（默认 `"key"`，保持当前 DSL 行为）。
- 专用诊断码（摩擦探针，不自动 normalize）：
  - 第二参数是 call 但 `allowMapBinding !== "call"` → `MAP_BINDING_CALL_NOT_ALLOWED`
  - 第二参数是 lambda 但 `allowMapBinding !== "lambda"` → `MAP_BINDING_LAMBDA_NOT_ALLOWED`
  - `_.` 前缀属性但当前臂不是 call → 同上探针覆盖（`_.x` 在 key 臂会作为普通 ref 报 `undefined_reference`，可接受）
- `buildMapNode` 重写：
  1. 位置参数映射保持（R2 遗产，`applyPositionalArgs(["source","tool","binding"])`）。
  2. 按 `allowMapBinding` 分支解析第二个语义参数：
     - `"key"`：`key="full_name"` 字面量 → `bindings = { full_name: "full_name" }`（参数名 == 字段名，当前行为）。
     - `"call"`：第二参数为 call 表达式 → `callee` 必须是注册工具（`unknown_tool` 复用）；每个 call arg：key 必须是工具已声明参数（`unknown_parameter` 复用）；value 为 ref 时要求 `_.` 前缀 → `bindings[key] = value.name.slice(2)`；value 为字面量 → 常量绑定（暂支持，字段路径为空串标记常量）。
     - `"lambda"`：第二参数为 lambda → body 必须是 call（否则报错）；call args 里 value 为 ref 且以 `param.` 开头 → `bindings[key] = value.name.slice(param.length + 1)`；其余同 call 分支。
  3. 工具注册校验沿用 `toolRegistered` 逻辑（不叠加误导性 `unknown_tool`）。
- `buildToolNode` 不变。

### 4. Runtime：bindings 多字段展开

**executor.ts** — map 分支改为：
```ts
const args: Record<string, unknown> = {};
for (const [param, field] of Object.entries(node.bindings)) {
  args[param] = field === "" ? /* 常量 */ : itemRecord[field];
}
return tool.execute(args);
```
（`field === ""` 表示常量绑定，值为编译期字面量——IR 需在小范围内承载：bindings 值为 `"=literal"` 前缀约定，或暂不支持常量绑定。**决策：第一版不支持常量绑定，lambda/call 内只接受 `_.field` / `<param>.field` 引用**，简化 IR 与 runtime。）

**mockTools.ts** — 新增非 GitHub mock 域：
- `crm.get_customer(customer_id: string)` → 单字段异名任务（任务 4）。
- `email.prepare(to: string, name: string)` → 多字段任务（任务 5）。
- 两个都并入 `createMockGithubTools` 或新增 `createMockDomainTools()`，harness 按任务组装 registry。mock 数据确定性 + 随机延迟（沿用现有模式）。

### 5. TaskSpec：binding correctness 指标

**taskSpec.ts**：
- `TaskSpec` 增加 `bindings: Record<string, string>`（期望 map 的绑定映射，如 `{ full_name: "full_name" }`）。
- `checkTaskCorrectness` 沿 return 数据流找到 map 节点后，逐一比对 `node.bindings` 与 `spec.bindings`：
  - 缺/多/错字段 → `binding_failures: string[]`（核心指标，与编译/执行成功解耦）。
- 返回值增加 `bindingPass: boolean`。

### 6. Harness：三臂 × 五任务 × repair

**dslGenerationExperiment.ts**：
- **任务集**（`src/experiments/r3Tasks.ts` 新建，含 TaskSpec + prompt 描述 + mock registry 组装）：
  1. `repo → github.get_repository(full_name)`（单字段同名）
  2. `repo → github.get_languages(full_name)`（单字段同名）
  3. `repo → github.list_contributors(full_name)`（单字段同名）
  4. `customer.id → crm.get_customer(customer_id)`（单字段**异名**，测命名映射）
  5. `user {email,name} → email.prepare(to, name)`（**多字段**，A 臂不可表达 → 预期 0%，作为"key= 扩展性不足"证据）
- **ARMS** 改为三臂：A `allowMapBinding:"key"` / B `"call"` / C `"lambda"`，全部 zero-shot；`allowPositionalArgs: true`（继承 R2 结论，map 第一参数位置化是模型先验，避免语法形态混淆）；`allowCallableRef: false`。
- `syntaxGuide(arm)` / 无 few-shot；修复循环保留（rounds=5，含空输出反馈与 R2 的 gateway 修复）。
- `runOnce` 增加 `binding_pass` / `binding_failures`。
- `summarize`：per-task + 总体汇总；指标 = first-attempt conformance / first-attempt task / **binding correctness** / repair conversion rate / avg repair rounds / tokens per successful task / error 分布。`computeEffects` 改为三臂逐指标对比（不再 2×2）。
- CLI：`--arm=A|B|C|all`、`--tasks=1..5|all`、`--samples`、`--rounds`。

### 7. 测试（tests/）

- **parser**：call 表达式（`github.get_repository(full_name=_.full_name)`）、lambda（`lambda repo: ...`）、嵌套组合解析用例。
- **compiler**：三开关分别接受对应形态；不匹配报专用诊断码；A/B/C 三种写法对同一任务产出**相同 bindings IR**（核心一致性断言）；未知工具/参数幻觉在 call/lambda 内同样被拒。
- **taskSpec**：binding correctness 正反用例（同名/异名/多字段/错字段）。
- **runtime**：bindings 多字段展开 + 异名字段取值正确。
- **回归**：更新受 `MapNode.key → bindings` 影响的现有用例（executionDsl.test.ts / taskSpec.test.ts / runtime.test.ts）。

### 8. 运行与报告

- 冒烟：`npm run experiment -- --arm=all --tasks=all --samples=1 --rounds=5`（3 臂 × 5 任务各 1 次，验证 harness/mock/binding 判定）。
- 完整：`--samples=10`（150 样本）。
- 报告 `experiment_result/语言实验-第三轮结果.md`：per-task 表（3 臂 × 5 任务 × 各指标）、binding correctness 对比、B vs C（若 B≈C → 选 B，免 lambda）、A 在多字段任务的扩展性证据、模型输出摘录。
- 矩阵表新增 E3 行。

## Assumptions & Decisions

1. **成本不敏感**：直接跑 3×5×10=150；若 B≈C 需要更高置信度，可扩到每臂每任务 15-20（不设降级 R3a/75）。
2. **MapNode key→bindings 直接迁移**（breaking），不做双字段兼容——保持单一概念；现有测试同步更新（R2 已有 breaking 先例）。
3. **C 臂 lambda 是受限形式**：单参数 + 单调用体，无任意表达式/控制流/嵌套 lambda——目的只是测"接近 Python 先验"的上限组，不是引入完整 lambda。
4. **B/C 臂 call 内只接受 `_.field` / `<param>.field` 引用**，第一版**不支持常量绑定**（简化 IR 与 runtime；`bindings` 值恒为元素字段路径）。
5. **多字段任务三臂都跑**：A 臂预期 0%（当前 `key=` 无多字段表达 → 编译必失败 → 修复循环必耗尽），作为"key= 从根本上扩展性不足"的量化证据；B/C 正常参与。
6. **全部 zero-shot + repair（R3a）**：few-shot 留 R3b（用非 GitHub 示例防答案泄漏，教语法不教答案）。
7. **binding correctness 是核心指标**：编译成功 + 绑定映射与 spec 一致才算 task pass；映射错（如 `repo.name`）即使执行成功也判错。
8. `allowPositionalArgs: true` 三臂统一（R2 结论：位置化是模型先验），避免把调用形态差异混入 binding 差异。

## Verification

1. `npx vitest run`：新增用例 + 迁移后全量回归（预期 59 → ~80 全绿）。
2. 冒烟 `--samples=1`：3 臂 × 5 任务 harness 无 bug、mock 工具全注册、binding 判定可运行。
3. 完整 `--samples=10`（150 样本），确认报告含 per-task 表与 binding correctness。
4. 人工抽读模型输出，验证 binding correctness 判定合理（含异名映射 `customer_id ← id` 与多字段 `to ← email, name ← name`）。
5. 产出 `experiment_result/语言实验-第三轮结果.md` + 矩阵 E3 行，询问 commit/push。
