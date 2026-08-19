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

插件向 harness 注册的工具（均走标准 `ctx.tools` 注册，遵守完整执行策略管线）：

| 工具 | 作用 | 模式 |
| --- | --- | --- |
| `jit_describe_tools` | 点名工具 → 确定性函数式契约（与 inline 签名同源渲染） | 生产默认 |
| `jit_execute_program` | DSL 源码 → 编译 → schema-validated IR → graph runtime 执行 | 生产默认 |
| `github_*` ×6、`crm_*`、`users_*`、`email_*` | 实验业务工具（默认 mock，github 可切 real/`GITHUB_TOKEN`） | 仅 `experimentMode: true` |

生产缺省**不注册实验业务工具**——插件使用者只拿到两个 JIT 元工具，自己注册进
DSH 的工具经宿主工具活视图零配置即可被 DSL 编排。`experimentMode: true` 才向
模型开放实验工具（供 benchmark / 演示任务），不会污染普通使用者的工具面。

实验模式下每个业务工具的 description 注入实验验证的函数式 DSL 签名：

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

宿主工具（bash / glob / web_search 等）多返回包装对象，可用**字段投影**与 **collect** 接进数据流：

```text
files = glob(pattern="src/**/*.ts")
top = take(files.paths, 3)          # 字段投影：对象.字段 解包数组字段
hits = web_search(query="dsh plugin")
proof = bash(command="git log --oneline -1", description="验证")
both = collect(hits, proof)         # 把两个对象结果包成一个数组
return both
```

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

### R7：工具面自描述（当前生产默认）

把 system prompt 完全关闭后，仅靠 `jit_execute_program` 工具描述中的
when/why trigger + 完整中性 DSL manual（service.* 示例），在 development
（N=20）和跨域 holdout（N=20）上均恢复 100% adoption / precision / task
completion；holdout efficiency 不劣于 system prompt 正对照。因此当前生产
默认配置为 `systemPrompt:false + routingPrompt:tool-embedded`。完整数据见
`experiment_result/r7-routing-development-report.md`。

## 配置

插件行 config（可被用户 patch 层覆盖）：

```yaml
experimentMode: false  # true = 注册实验业务工具（github_*/crm_*/users_*/email_*）；
                       # false（缺省）= 生产：只挂 jit_* 元工具
providers:             # 仅 experimentMode: true 时生效
  github: mock   # mock | real（GITHUB_TOKEN）| none
  domain: mock   # mock | none
dsl:
  signatureInDescription: inline   # 业务工具 description 注入 DSL 签名（inline | none）
  systemPrompt: false              # 生产默认不挂 DSL system prompt（R7 T3）
  systemPromptReference: neutral   # 若 systemPrompt:true，使用 service.* 中性参考
  guidance: primitive              # primitive | patterns | full-example
  describeTools: true              # 是否注册 jit_describe_tools
  routingPrompt: tool-embedded     # jit_execute_program 描述含 trigger + 完整中性 DSL manual
  describeDslReference: none       # describe 只返回契约（first-call = 历史懒加载 manual）
  routingReminder: on-list         # soft hook：工具返回列表后注入"考虑 JIT"提醒（缺省 on；none 关闭）
  routingReminderMinListLength: 2  # 触发提醒的最小列表长度（缺省 2）
# hostTools: []         # 缺省（不写）= 自动发现全部 DSH 宿主工具（describe 即用）；
#                        # [] 显式关闭；写名字数组 = 白名单
# excludeHostTools: []  # 黑名单：始终排除（如不想开放 bash 给 DSL）
```

宿主工具经 hostDiscovery 活视图在运行时自动发现：任何注册进 `ctx.tools`
的工具（其他插件 / 动态注册）**describe 即用、DSL 直接可编排，零配置零代码
修改**；执行走 `ctx.tools.execute` 嵌套分发（完整策略管线：guard /
pre-execute / post-execute / 超时 / 沙箱），scope = 调用方 agent。`jit_*`
元工具自身被排除，防递归。

## 开发

```sh
npm run build   # 构建 dist/（bundle 入口 dist/integrations/dsh/index.js）
npm test        # 642 个单测，含真实 DSH 服务树 smoke 测试（挂载 + 执行路径压缩断言）
```

开发环（在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout 内）：

```sh
pnpm dsh web --patch <本仓库>/cordis.dev.patch.yml --port 3081
```

## 许可证

[MIT](LICENSE)
