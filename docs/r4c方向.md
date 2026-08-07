是的，这一轮 **正确率维度基本被 ceiling effect 顶死了**。最新完整 R4 是每档 10 次，DSL 和 iterative 在 `N=2/5/10/20` 上都没有出现 `task_pass=false`。([GitHub][1])

但我看完实现和日志以后，判断比“任务太简单”更具体：

> **R4 不是没结果。它已经测出了效率 scaling；只是当前任务几乎不具备“正确性 scaling”。**
>
> 而且目前 benchmark 里还有几个设计因素，会主动把正确率差异压平。

## 最关键的问题：`get_repository` 对最终答案其实没用

现在任务要求：

```text
search 前 N 个 repo
↓
对 N 个 repo 都 get_repository
↓
最后返回前 3 个 repo 的 full_name
```

但是 ground truth 是直接这样生成的：

```ts
search(query, limit=N)
→ items.slice(0, K)
→ full_name
```

而且 `K = min(3, N)`。所以 `N=5/10/20` 最终要答的始终是相同的前三个名字。([GitHub][2])

也就是说，模型其实在第一次：

```text
github.search_repositories(...)
```

之后就已经知道正确答案了。

后面的：

```text
20 × github.get_repository(...)
```

对被评分的答案没有增加任何信息。

所以即使任务从：

```text
N=2
```

变成：

```text
N=20
```

真正的“答题难度”几乎没有增加，只是**执行工作量**增加了。

这就是为什么 accuracy 很容易一直 100%。

---

## 而且两臂的 correctness checker 还不完全对称

DSL 臂的最终 `task_pass` 是：

```text
最终答案正确
AND
DSL computation graph 语义正确
```

也就是说它会检查 `search → map → take → return` 这张程序图。([GitHub][2])

但 iterative 臂最终主要检查：

```text
模型最后输出的 repo names
是否命中 ground truth
```

并没有验证：

> 它是不是真的对前 N 个仓库都完成了 `get_repository`。

([GitHub][3])

所以理论上 iterative 模型只要：

```text
search
↓
直接回答前三个 full_name
```

也可以得到：

```text
task_pass = true
```

这会进一步压平正确率。

---

# 不过 R4 已经出现了非常明显的效率结果

这个不要忽略。

DSL 的 token 基本不随 N 增长：

```text
N=2   ≈ 941 tokens
N=5   ≈ 941
N=10  ≈ 941
N=20  ≈ 941
```

因为模型只负责生成一次程序。

而 iterative 到 N=20 时，大多数 run 已经在：

```text
≈ 9,100–9,300 tokens
```

有一个较低的异常样本约 5,982。

所以虽然：

```text
accuracy:
DSL       100%
Iterative 100%
```

但是实际发生的是：

```text
             N ↑

DSL:
LLM → 写程序
      ↓
   Runtime 扩展工作
      ↓
模型 token 基本不变


Iterative:
LLM → search result
      ↓
LLM → get_repository × N
      ↓
中间结果重新进入 context
      ↓
token 随 N 增加
```

这个结果其实正中项目最初的核心假设：

> **工具图复杂度应该增长在 runtime，而不是增长在 model context 里。**

所以我不会把 R4 判定成失败。

我会说：

> **R4 成功展示了 efficiency scaling，但没有成功制造 correctness scaling。**

---

# 还有一个意外发现：round trip 并没有随着 N 增长

这也很有意思。

你最初可能想象 iterative 是：

```text
LLM
→ tool 1
→ LLM
→ tool 2
→ LLM
→ tool 3
...
```

所以 N=20 应该需要很多 LLM round trips。

实际上不是。

当前 gateway 可以一次返回多个 tool calls，而 `runIterativeToolCalling()` 会把该 completion 返回的所有 calls 一次处理掉，然后才重新调用 LLM。([GitHub][3])

所以 N=20 日志基本还是：

```text
4 round trips
```

并没有变成 22 次。

大概是：

```text
Round 1
LLM → search

Round 2
LLM → 一口气发出很多 get_repository calls

Round 3
LLM → 最终答案

Round 4
LLM → 再一次无 tool completion
```

最后那个 Round 4 其实还有点人为。

因为你现在规定：

```ts
minConsecutiveNoTool = 2
```

要连续两轮没有 tool call 才结束。([GitHub][3])

正常 agent loop 很可能第一次：

```text
没有 tool call + 给出最终答案
```

就应该结束。

所以公平 benchmark 我建议改成：

```text
minConsecutiveNoTool = 1
```

这样真正比较可能变成：

```text
DSL:       1 LLM call
Iterative: 3 LLM calls
```

而不是现在的 1 vs 4。

这反而更可信。

---

# 当前 latency 比较也有一个比较大的公平性问题

DSL 的：

```text
map(...)
```

默认：

```text
concurrency = 5
```

Runtime 用 `mapLimit()` 并发执行 fan-out。

但是 iterative arm 收到一批 tool calls 后，现在代码是：

```ts
for (const call of toolCalls) {
    await tool.execute(...)
}
```

也就是**顺序执行**。([GitHub][3])

因此 N=20 时 iterative 出现：

```text
tool_ms ≈ 11–14 秒
```

而 DSL runtime 大约几秒。

这里不能全部归功于：

> DSL vs Tool Calling。

一部分其实是：

> **并发 scheduler vs 顺序 scheduler。**

如果我们想让 R4 有说服力，traditional baseline 也应该：

```text
同一 completion 发出的独立 tool calls
→ Promise.all / concurrency=5
```

跟 DSL 完全相同并发限制。

这样还能剩下的 latency 差距，才是 architecture 本身的差距。

---

# `exposed_bytes` 目前也需要重新定义

现在 iterative 的 `exposed_bytes` 很合理：

```text
tool result
↓
放回 LLM context

累计这些 JSON bytes
```

代码确实在每次 tool result 后累加。([GitHub][3])

但是 DSL 的 `exposed_bytes` 算的是：

```text
DSL source bytes
+
最终 runtime result bytes
```

([GitHub][2])

这两个其实不是同一个概念。

如果我们真正要测：

> **有多少 intermediate data 被重新送进模型？**

那么 DSL 在没有 final synthesis LLM 的情况下应该近似：

```text
0 bytes
```

因为：

```text
search result
get_repository results
```

全部停留在 Runtime。

所以建议以后拆成：

```text
model_ingress_bytes
model_egress_bytes
runtime_internal_bytes
```

不要一个 `exposed_bytes` 全包。

---

# 所以我不会直接把 R4 加难一点重新跑

我会做一个 **R4c**，解决“语义难度没有增长”的问题。

核心原则：

> **后续 tool 的返回值必须改变最终答案。**

现在：

```text
search
↓
get details
↓
返回 search 原本就知道的 full_name
```

不行。

应该改成比如：

```text
search N repos
↓
get_repository × N
↓
根据 detail 中只有 get_repository 才知道的字段进行 filter/rank
↓
返回 Top K
```

例如假设 detail 有：

```text
open_issues
forks
updated_at
size
archived
```

任务改成：

> 搜索前 N 个 TypeScript agent framework 仓库；获取所有详情；排除 archived；然后选出 `forks` 最大的 3 个。

这时候：

```text
search result
```

不足以直接得到答案。

必须真的：

```text
get_repository × N
```

然后比较、筛选。

---

# 再进一步，我建议设计三个难度层级

不要只是 N 变大。

现在 R4 实际只有：

```text
fanout size ↑
```

下一版同时增加**计算深度**。

### Level 1：单字段聚合

```text
search
→ details × N
→ max(forks)
→ top 3
```

### Level 2：多条件确定性决策

```text
search
→ details × N
→ languages × N
→ filter:
   archived=false
   AND TypeScript > 50%
→ sort stars
→ top 3
```

这已经要求：

```text
2N 个 downstream calls
+
join/filter/sort
```

### Level 3：多阶段 dependent fanout

比如：

```text
search repos
   ↓
get details × N
   ↓
根据 details 筛选 M 个
   ↓
get contributors × M
   ↓
根据 contributor 数据再次排序
   ↓
top 3
```

这样第二批工具调用依赖第一批结果。

这就很关键。

Traditional Tool Calling 必须：

```text
LLM
→ 第一批 calls
→ 看结果
→ 决定第二批 calls
→ 看结果
→ 最终答案
```

而 DSL 可以：

```text
LLM
→ 一次写完整 computation
→ runtime 自己跑 graph
```

这才真正把两种架构拉开。

---

## 我最推荐的 R4c 任务

可以继续 GitHub，但改成：

> 搜索前 N 个 TypeScript agent framework 仓库；获取每个仓库详情和语言信息；只保留主要语言为 TypeScript 且未 archived 的仓库；按 `forks_count / stargazers_count` 排序，返回最高的 3 个完整仓库名。

概念上：

```text
search(N)
   ↓
 ┌──────────────┐
 ↓              ↓
details × N   languages × N
 ↓              ↓
 └────── join ──┘
          ↓
        filter
          ↓
        compute
          ↓
         sort
          ↓
        take(3)
          ↓
        return
```

这个任务才开始真正测试：

> **当 computation graph 变复杂以后，谁更容易遗漏步骤、错接数据、提前停止、浪费 context？**

当然目前 DSL 还没有 `filter / sort / join`，所以也可以把 R4c 当成下一阶段语言能力的压力测试——这反而很有价值。

---

# 所以这轮 R4 我的结论不是“没有正确率差异”

而是：

### 已经得到的信号

**正确率：**

```text
DSL        = 100%
Iterative  = 100%
```

说明至少目前 DSL 没有为了效率牺牲正确性。([GitHub][1])

**LLM token scaling：**

```text
DSL       ≈ constant
Iterative ↑ with N
```

信号已经很明显。

**Intermediate-context scaling：**

iterative 随 N 明显增加；DSL 的中间 tool data 留在 runtime，不过当前指标定义需要修正。

### 还没有测到的东西

> **随着 computation complexity 上升，两种架构的 task correctness 是否开始分叉。**

这个才应该是 R4c 的目标。

所以我会保留这次 R4 数据，不覆盖它。它其实是一份很好的 **easy-regime / scaling baseline**。

然后把下一轮明确命名为：

> **R4c — Semantic Dependency Scaling**

不是单纯把：

```text
N=20 → N=100
```

而是增加：

```text
工具结果之间的依赖深度
+
必须使用 intermediate data 才能得到答案
+
分支/filter/rank
```

我认为这样比单纯追求“让模型做错”更有研究价值。

[1]: https://github.com/sybolization/agent-dsl/blob/main/logs/experiments/programmatic-benchmark-2026-08-07T08-11-18-243Z/report.json "agent-dsl/logs/experiments/programmatic-benchmark-2026-08-07T08-11-18-243Z/report.json at main · sybolization/agent-dsl · GitHub"
[2]: https://github.com/sybolization/agent-dsl/blob/main/src/experiments/programmaticBenchmark.ts "agent-dsl/src/experiments/programmaticBenchmark.ts at main · sybolization/agent-dsl · GitHub"
[3]: https://github.com/sybolization/agent-dsl/blob/main/src/experiments/iterativeToolCalling.ts "agent-dsl/src/experiments/iterativeToolCalling.ts at main · sybolization/agent-dsl · GitHub"
