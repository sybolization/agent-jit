# Agent JIT

**A DeepSeek Harness plugin that compiles deterministic execution paths out of the LLM agent loop.**

Agent JIT 把 agent loop 中已确定的确定性执行路径（多步工具编排、状态维护、中间数据流转）编译成受限 DSL 程序，交给 schema-validated graph runtime 确定性执行——**把"数据怎么流通"从模型手里拿走**，让 Agent 不再为不需要智能的步骤付 token。

Agent 仍是 planner；Agent JIT 是执行 offload 层。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-community-4b32c3)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 安装

本仓库即一个 DeepSeek Harness **bundle**（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）。预构建产物 `dist/` 随仓库分发，git 安装无需任何构建授权。

装进 **web profile** 后，每次 `dsh web` 启动都会自动加载（`dsh web` 是 `--profile web` 的别名；`npx @deepseek-ai/dsh web` 同样生效）：

```sh
# npm（推荐；发布的是预构建产物，无构建授权）
dsh plugin --profile web add agent-jit
# 或从 GitHub 安装（dist/ 随仓库分发，同样无构建授权）
dsh plugin --profile web add github:sybolization/agent-jit

dsh web --dump-config    # 验证：应出现 agent-jit-dsl 行
dsh web                  # 之后每次启动都带插件
```

要装进其他 profile（headless / 自定义组合）同理换 profile 名；注意**自定义 profile 默认只含 `dsh-base`（无 Web UI）**，需要 UI 请同时加装 `@deepseek-ai/dsh-web-app`。卸载：`dsh plugin --profile web remove agent-jit`。

## 工具

插件向 harness 注册三组工具（均走标准 `ctx.tools` 注册，遵守完整执行策略管线）：

| 工具 | 作用 |
| --- | --- |
| `github_*` ×6、`crm_*`、`users_*`、`email_*` | 业务工具（默认 mock，github 可切 real/`GITHUB_TOKEN`） |
| `jit_describe_tools` | 点名工具 → 确定性函数式契约；首次调用附带 DSL 语言参考 |
| `jit_execute_program` | DSL 源码 → 编译 → schema-validated IR → graph runtime 执行 |

每个业务工具的 description 注入实验验证的函数式 DSL 签名：

```text
github_get_repository — 获取单个仓库的详细信息。
DSL: github.get_repository(full_name: str) -> {full_name: str, forks: int, stars: int}
```

普通调用看 `parameters`，JIT 编程看 `DSL:` 签名——两个接口来自同一个 ToolContract。失败严格语义：未知工具 / 编译失败 / 执行失败整体报错，不允许 partial success。

## 一个例子

```text
repos = github.search_repositories(query="dsl", limit=5)
details = map(repos, github.get_repository(full_name=_.full_name))
active = filter(details, archived=false)
top = take(active, 3)
return top
```

逐工具执行需要 **11 次** agent loop 往返；`jit_execute_program` **1 次**调用返回相同结果（有测试断言保护）。

## 为什么有效：实验数据

完整实验报告见 `experiment_result/`。核心结论：**对可提前表达为确定性程序的执行路径，把 orchestration state 从 LLM loop 迁移到 compiler/runtime，任务质量不变，token / 上下文暴露 / 往返轮次显著下降。**

### R4b：一次程序提交 vs 迭代工具调用（真实 GitHub 工具，N=20）

| 指标 | DSL/JIT | 迭代工具调用 | 差距 |
| --- | ---: | ---: | ---: |
| tokens | 941 | 8,904 | **9.5×** |
| 模型往返轮次 | 1.0 | 4.0 | **4.0×** |
| 暴露给模型的中间数据 | ~460 B | 4,196 B | **9.1×** |
| 端到端延迟 | 4,711 ms | 18,844 ms | **4.0×** |

### R4e：分支 + 重组（adversarial 数据集，N=15/30）

token 差距 **6.9× / 8.1×**；工具契约完整时两臂 correctness 均为 100%。

### R5：自主 offload（模型自己决定是否使用 JIT）

| 臂 | adoption | offload precision | task 完成率 | tokens |
| --- | ---: | ---: | ---: | ---: |
| Control B（不提供 JIT） | — | — | 100% | 24,151 |
| Treatment B（提供 JIT） | **90%** | **100%** | **100%** | **14,976（-38%）** |

- 在"明显值得程序化"的任务上，模型自主选择 offload 9/10，且全部语义正确；
- 在"不值得 JIT"的简单任务上 unnecessary offload 为 **0%**——DSL 参考按需加载，不使用 JIT 的成本接近零。

机制不是"模型更聪明"，而是：**确定性数据流由 runtime 消费，而不是由 LLM context 消费。**

## 配置

插件行 config（可被用户 patch 层覆盖）：

```yaml
providers:
  github: mock   # mock | real（GITHUB_TOKEN）| none
  domain: mock   # mock | none
dsl:
  signatureInDescription: inline   # 业务工具 description 注入 DSL 签名（inline | none）
  systemPrompt: true               # 常驻 DSL 语言参考 system prompt section
  guidance: primitive              # primitive | patterns | full-example
  describeTools: true              # 是否注册 jit_describe_tools
hostTools: []   # 可被 DSL 编排的 DSH 宿主工具名（如 run_bash），经嵌套分发走完整策略管线
```

## 开发

```sh
npm run build   # 构建 dist/（bundle 入口 dist/integrations/dsh/index.js）
npm test        # 544 个单测，含真实 DSH 服务树 smoke 测试（挂载 + 执行路径压缩断言）
```

开发环（在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout 内）：

```sh
pnpm dsh web --patch <本仓库>/cordis.dev.patch.yml --port 3081
```

## 许可证

[MIT](LICENSE)
