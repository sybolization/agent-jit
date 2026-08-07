# R4 实验：真实 GitHub Adapter + B 臂语言验证（mock → real）

日期：2026-08-07 ｜ 状态：计划 ｜ 前置：R3（map data binding 三臂，B=call 形态胜出）已完成；传输协议（submit_program tool envelope）已落地

## Summary

R3 用 mock GitHub 工具验证了语言方向（B 臂 `map(source, tool(param=_.field))` task/binding 双 100%）。R4 把 **mock 换成真实 GitHub REST API**（P4 adapter 的最小实现），用 **B 臂 + 真实数据**重跑 R3 的 GitHub 任务，验证：

> **R4 假设：真实 GitHub 数据下，B 臂（call 绑定形态）仍保持高 conformance 与 binding correctness，DSL → IR → 真实 API → 执行的链路端到端成立；真实数据的字段可用性 / 延迟 / rate limit 不改变语言结论。**

同时交付 P4 的 GitHub adapter（真实工具，与 mock 同 spec、可互换）。

## Current State Analysis

- **registry**（`src/compiler/registry.ts`）：4 个 GitHub 工具 spec（search_repositories / get_repository / get_languages / list_contributors）已定，参数与返回字段（full_name、stars、language 等）为编译校验与 taskSpec 检查的契约。
- **runtime**（`src/runtime/runtime.ts` / `mockTools.ts`）：`RuntimeTool = { spec, execute(args) }`，mock 实现确定性假数据；executor 的 map 分支按 `bindings` 展开（R3 已支持多字段/异名）。
- **harness**（`src/experiments/dslGenerationExperiment.ts`）：R3 三臂 × 5 任务 × 并发；`submit_program` tool envelope 传输协议已落地；`buildRuntimeRegistry` 用 `createMockGithubTools` + `createMockDomainTools` 按任务过滤。
- **taskSpec**（`src/experiments/taskSpec.ts`）：沿 return 数据流检查源工具 query/limit、map bindings、take count。
- **token 接入**：`.env` 已有 `DEEPSEEK_API_KEY` 读取模式（loadEnv）；本机无 gh CLI，用户将生成 fine-grained PAT 放入 `.env` 的 `GITHUB_TOKEN`。
- **已知约束**：GitHub search 端点认证后 30 次/分钟；其余 REST 端点 5000 次/小时（fine-grained PAT 空 scope 可读公开仓库）。实验规模（10 样本 × 1 search + map fan-out 10）在限额内。

## Proposed Changes

### 1. 真实 GitHub adapter（新文件 `src/runtime/githubAdapter.ts`）

- 导出 `createRealGithubTools(): RuntimeTool[]`——与 `githubTools` 同 spec，`execute` 用 `fetch` 调 `https://api.github.com`：
  - `search_repositories(query, limit)` → `GET /search/repositories?q={query}&per_page={limit}&sort=stars`；返回数组映射为 `{ full_name, stars, archived, pushed_at, language }`（与 mock 同字段，taskSpec 依赖）。
  - `get_repository(full_name)` → `GET /repos/{full_name}` → `{ full_name, stars, archived, language }`。
  - `get_languages(full_name)` → `GET /repos/{full_name}/languages` → 原样 object。
  - `list_contributors(full_name, per_page?)` → `GET /repos/{full_name}/contributors?per_page=` → `[{ login, contributions }]`。
- 请求头：`Authorization: Bearer ${GITHUB_TOKEN}`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent`（GitHub 强制）。
- token 读取：`process.env.GITHUB_TOKEN`（loadEnv 已从 .env 载入）；缺失时 `execute` 抛明确错误"缺少 GITHUB_TOKEN"。
- 错误处理：429/403（rate limit）→ 带 `x-ratelimit-reset` 信息；404 → 明确"资源不存在"；网络/超时（`AbortSignal.timeout(15_000)`）→ 包装错误。
- 返回字段与 mock 对齐：real/mock 互换不改变 IR 与 taskSpec。

### 2. harness 支持 backend 切换（`dslGenerationExperiment.ts`）

- CLI 加 `--backend=real|mock`（默认 `real`？**决策：默认 mock 保持实验可复现性，R4 显式传 `--backend=real`**）。
- `buildRuntimeRegistry(task, backend)`：GitHub 工具按 backend 选 real/mock；任务 4/5 的 crm/email mock 域工具不受影响（R4 只把 GitHub 数据真实化）。
- prompt 无变化（工具目录渲染自 spec，real/mock 同 spec）。

### 3. 实验运行（R4 主跑）

- 臂：**仅 B 臂（call 形态）**——R3 已选出胜者，R4 聚焦真实数据验证，不重跑 A/C（避免无意义 API 消耗）。
- 任务：5 个任务全跑（任务 1-3 GitHub real；任务 4/5 mock 域，作为对照保留）。
- 参数：`--arm=B --tasks=all --samples=10 --rounds=5 --backend=real --parallel=6`（50 样本；用户已确认不考虑调用成本）。
- 同时跑一次 `--backend=mock` 的 B 臂同参数作为基线对照（复用 R3 数据亦可，见 Verification）。

### 4. 指标与对比

- 复用 R3 指标（transport / conformance / task / binding / repair / tokens），新增：
  - `backend: "real" | "mock"` 标记写入 report.json；
  - adapter 侧统计：每工具调用次数、总延迟、rate-limit 命中次数（方便报告真实链路成本）。
- 对比维度：B 臂 real vs mock 的 task/binding/conformance 差异；真实字段可用性（如 search 返回空、语言缺失）对程序的影响。

### 5. 测试

- `tests/githubAdapter.test.ts`：注入 mock fetch（fetch 注入点：`createRealGithubTools({ fetch: customFetch })`）验证 URL 构造、token 头、返回字段映射、429/404/超时错误包装——不真实打 API。
- 回归：现有 85 用例不受影响（adapter 是新增，不替换 mock 默认路径）。

### 6. 运行与报告

- 前置：用户在 `.env` 添加 `GITHUB_TOKEN`（fine-grained PAT，只读公开仓库）；`loadEnv` 自动载入。
- 冒烟：`--arm=B --tasks=all --samples=1 --backend=real`（5 样本，验证真实链路 + rate limit）。
- 完整：`--arm=B --tasks=all --samples=10 --backend=real`（50 样本）。
- 报告 `experiment_result/语言实验-第四轮结果.md`：B 臂 real vs mock 对比表、adapter 端到端验证（字段/延迟/rate limit）、真实数据下语言结论是否维持。
- 矩阵：P4 行标注"GitHub adapter 已落地（V1 REST + token）"，或新增 E4 行。

## Assumptions & Decisions

1. **token**：用户提供 fine-grained PAT（只读公开仓库，空 scope）→ `.env` 的 `GITHUB_TOKEN`；不进 git（.env 已 gitignore）。缺失时 adapter 报错不静默。
2. **默认 backend=mock**：实验默认路径保持可复现（mock），R4 显式 `--backend=real`。**不改变现有 85 用例**。
3. **仅跑 B 臂**：R3 已确定 B 是胜者；R4 是"真实数据验证"而非"再选一次语法"。任务 4/5 的 mock 域保留（对照），GitHub 任务真实化。
4. **adapter 只读**：4 个只读工具，不做写操作（issue/PR 等留待后续）。
5. **字段对齐**：real 返回字段映射到与 mock 相同的形状（full_name/stars/language 等），taskSpec 检查不变。
6. **fetch 可注入**：adapter 构造器接受 `fetch` 覆盖（默认全局 fetch），测试不打真实 API；生产用默认 fetch。
7. **rate limit 策略**：search 每样本 1 次（10 样本/分钟在 30/min 内）；map fan-out 的 get_repository 等受 5000/h 约束（50 样本 × 10 = 500 次，安全）。若实验中途 429，adapter 抛错→样本判失败，报告记录（不自动重试，暴露真实链路行为）。

## Verification

1. `npx vitest run`：85 旧用例 + githubAdapter 新用例全绿（mock fetch，不打真实 API）。
2. 冒烟 `--arm=B --tasks=all --samples=1 --backend=real`：真实链路通、token 生效、字段可用。
3. 完整 `--arm=B --tasks=all --samples=10 --backend=real`（50 样本）→ report.json。
4. 对比基线：B 臂 mock（R3 数据 `r3-binding-ab-2026-08-07T07-21-38-565Z` 已含 B 臂全任务 100%）。
5. 抽查模型输出与 adapter 日志，确认真实数据下 binding 判定合理。
6. 报告 + 矩阵更新，询问 commit/push。
