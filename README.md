# Agent JIT

**A DeepSeek Harness plugin that compiles deterministic execution paths out of the LLM agent loop.**

Agent JIT 把 agent loop 中已确定的确定性执行路径（多步工具编排、状态维护、中间数据流转）编译成受限 DSL 程序，交给 schema-validated graph runtime 确定性执行——**把"数据怎么流通"从模型手里拿走**，让 Agent 不再为不需要智能的步骤付 token。

Agent 仍是 planner；Agent JIT 是执行 offload 层。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-community-4b32c3)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 安装

本仓库即一个 DeepSeek Harness **bundle**（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）。预构建产物 `dist/` 随仓库分发，git 安装无需任何构建授权：

```sh
dsh plugin --profile agentjit add github:sybolization/agent-jit
dsh --profile agentjit --dump-config    # 验证：应出现 agent-jit-dsl 行
```

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
npm test        # 541 个单测，含真实 DSH 服务树 smoke 测试（挂载 + 执行路径压缩断言）
```

开发环（在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout 内）：

```sh
pnpm dsh web --patch <本仓库>/cordis.dev.patch.yml --port 3081
```

## 许可证

[MIT](LICENSE)
