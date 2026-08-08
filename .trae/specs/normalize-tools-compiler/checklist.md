# Checklist

按 spec.md 的 Requirement 逐项验证；通过即勾选。

## REQ-1 统一工具定义与注册（Task 1）
- [x] `src/tools/definition.ts` 定义 `ToolDefinition`（id / label / description? / inputSchema / outputSchema / execute）与 `defineTool`
- [x] `src/tools/registry.ts` 提供 `ToolRegistry`（register / get / has / all / ids）
- [x] `githubTools` 以 `defineTool` 注册；Compiler、catalog、Runtime 从同一事实源取签名与执行体，无第二处手工配对
- [x] `RuntimeRegistry = ReadonlyMap<string, ToolDefinition>`；executor 直接从定义取 `execute`，`{ spec, execute }` 包装层已移除

## REQ-2 Schema 化契约与运行时输出校验（Task 2）
- [x] 全部工具声明 typebox `inputSchema` / `outputSchema`；`outputKind` 字符串已移除；catalog 与 `toPiTools` 从 schema 渲染
- [x] runtime 工具执行后校验输出，不匹配 → `TOOL_OUTPUT_SCHEMA_MISMATCH`（trace 记 error，整体 failed）
- [x] 真实 GitHub adapter 输出与其声明 schema 一致（stats/commits 真实字段可用，R4d 排序键不破）
- [x] `createAdversarialGithubTools()` 自持契约（schema `{full_name, score}`）；`r4eBenchmark` 的 `task.tools` 与 iterative 工具目录使用 adversarial 定义

## REQ-3 必填参数编译期强制（Task 2）
- [x] `buildToolNode` 按 inputSchema 的 `required` 检查缺失参数，缺失 → `syntax` 诊断（如 `search_repositories()` 无 query）

## REQ-4 运行时失败模型统一（Task 2）
- [x] `ExecutionResult` 为判别联合 `{status:"success", result, trace, totalDurationMs} | {status:"failed", error, trace, totalDurationMs}`
- [x] `execute()` 节点级错误返回 failed（不 throw，trace 含出错节点）；图结构错误仍 throw
- [x] 实验与测试调用方全部迁移到 `result.status`，无 `result.ok` 残留

## REQ-5 编译器符号类型与字段校验（Task 3）
- [x] SymbolTable（语句名 → 输出 schema，数组取元素 schema）已实现
- [x] map 绑定字段不存在 → `UNKNOWN_FIELD`（suggestion 列出可用字段）；字段类型与参数 schema 基础匹配（string/number/int/boolean）

## REQ-6 表达式解析器解耦与 AST-IR（Task 4）
- [x] `expr.ts` 迁入 `src/language/`（compiler 不再 import runtime）；`parseExpr` / `evalExpr` / `isComparisonExpr` / `ExprNode` 同名导出
- [x] compute/select 的 IR 节点携带编译期 AST；`args` 保留源码字符串（taskSpec 图语义检查仍通过）
- [x] executor 执行 compute/select 直接 eval AST，不再逐元素 `parseExpr`；oracle 与 executor 共用 `evalExpr`（R4e 端到端用例通过）

## REQ-7 canonical 语法冻结与编译器拆分（Task 5）
- [x] `compiler.ts` 已拆分为 `compile.ts` + `builtins/*.ts` + `toolCall.ts`
- [x] `CompileExecutionDslOptions` 移除三个实验开关；canonical 语法（map 调用绑定 + 位置参数 + 字符串 tool id）编译通过，key=/lambda 形态报专用诊断
- [x] R1–R3 变体在 `src/experiments/languageVariants/` 遗留路径；`dslGenerationExperiment` 与 `tests/r3Binding.test.ts` 走该路径且行为一致

## 验证（Task 6）
- [x] `npm test` 全绿（≥ 基线 211 tests）
- [x] grep 无 `ToolSpec` / `outputKind` / `allowCallableRef` / `allowPositionalArgs` / `allowMapBinding` / `result.ok` 残留（src/ 与 tests/）
- [x] 类型检查（`npx tsc --noEmit`）通过
