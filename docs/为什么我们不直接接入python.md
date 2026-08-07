我也倾向于这个折中，而且我觉得这可能比“设计一套完全陌生的 DSL 语法”更合理：

> **做一门 Python-shaped、但语义远小于 Python 的 Agent Language。**

关键是“像 Python”，而不是“Python 的受限运行环境”。

两者差别很大。

如果直接执行 Python，再通过 sandbox 禁止危险行为，你仍然背负 Python 的完整语义复杂度；如果只是借用 Python 已经被 LLM 学得非常好的表面语法，而你自己定义 AST 和语义，那么可以同时获得 **LLM 先验 + 编译器确定性**。

### 我会让它看起来像这样

```python
repos = github.search_repositories(
    query="agent framework",
    limit=10,
)

details = map(
    repos,
    github.get_repository,
    key="full_name",
    concurrency=5,
)

active = filter(
    details,
    lambda repo: repo.archived == False and repo.stars > 100,
)

top = take(
    sort(active, by="stars", order="desc"),
    5,
)

result = agent.analyze(
    input=top,
    task="Compare these repositories and rank the most promising ones.",
)

return result
```

模型看到以后几乎不需要学习：

* assignment
* function call
* keyword arguments
* list
* object
* lambda
* boolean expression
* attribute access

全部都是训练数据里极高频的模式。

但你的 Harness 看到的不是 Python，而是：

```text
Assign
Call(tool)
Map
Filter(predicate)
Sort
Take
Call(agent)
Return
```

然后直接编译成 Execution IR。

这就很漂亮。

---

## 但我会非常严格地切掉 Python 的能力

第一版甚至可以规定只有这些语法：

```text
assignment
function call
keyword arguments

string / int / float / bool / null
list
dict

attribute access
comparison
and / or / not

lambda（受限）
return
```

没有：

```text
class
def
import
while
try
raise
yield
async / await
with
global
nonlocal
decorator
reflection
exec
eval
arbitrary method calls
```

甚至 `if` 我一开始都不一定放进去。

因为：

```python
result = if_else(
    condition=score > 80,
    then=...,
    otherwise=...,
)
```

虽然没有 Python 那么漂亮，但对 Execution Graph 来说非常明确。

以后真的需要，可以加：

```python
if score > 80:
    ...
else:
    ...
```

但这一步应该由真实 use case 驱动。

---

# 最重要的是：不要允许普通 Python 函数

比如这段：

```python
def score(repo):
    x = repo.stars * 0.5
    if repo.archived:
        x -= 100
    return x
```

一旦允许，你马上就进入 general-purpose language。

更安全的方案是允许**表达式级 computation**：

```python
scored = map(
    repos,
    lambda r: {
        "repo": r,
        "score": r.stars * 0.5 + r.forks * 0.2,
    },
)
```

Harness 可以把 lambda 编译成纯 expression AST。

于是仍然知道：

```text
no IO
no mutation
no hidden tool calls
terminates
deterministic
```

这对 runtime 非常有价值。

---

# 我甚至建议采用 SSA-ish 风格

也就是变量尽量只赋值一次：

```python
repos = ...
details = ...
active = ...
top = ...
result = ...
```

禁止：

```python
x = 1
x = x + 1
x = foo(x)
```

为什么？

因为：

> **assignment 本身就是 graph node binding。**

如果一个变量只有一个 producer，那么：

```python
a = tool_a()
b = tool_b(a)
c = tool_c(a)
d = tool_d(b, c)
```

几乎直接就是：

```text
    a
   / \
  b   c
   \ /
    d
```

这其实很接近 SSA / dataflow IR，而模型又会觉得自己只是在写普通 Python。

这个折中非常适合你。

---

# `for` 也可以借 Python 外形，但换语义

比如模型很自然会写：

```python
details = [
    github.get_repository(repo.full_name)
    for repo in repos
]
```

这对 LLM 来说极其熟悉。

但你的 compiler 可以规定：

> tool call 出现在 comprehension 中时，comprehension 编译为一个 `MapNode`，而不是 Python 顺序循环。

也就是说：

```python
details = [
    github.get_repository(repo.full_name)
    for repo in repos
]
```

编译成：

```text
map
  source = repos
  body = github.get_repository(repo.full_name)
```

Runtime 自动并行。

甚至可以：

```python
details = parallel([
    github.get_repository(repo.full_name)
    for repo in repos
], concurrency=5)
```

这样 Python familiarity 和你的 runtime semantics 就结合起来了。

---

# 这可能比你现在的 `map(source=..., tool=..., key=...)` 更强

现在这种：

```text
details = map(
    source=repos,
    tool="github.get_repository",
    key="full_name"
)
```

对 compiler 很简单，但有一个缺陷：

> 模型必须学习你的 map 参数协议。

而 Python-shaped 写法：

```python
details = map(
    repos,
    lambda repo: github.get_repository(repo.full_name),
)
```

或者：

```python
details = [
    github.get_repository(repo.full_name)
    for repo in repos
]
```

模型天然知道：

```text
repo.full_name
```

怎么流进：

```text
github.get_repository(...)
```

你不再需要：

```text
key="full_name"
```

这其实是一次很大的表达能力提升。

而 compiler 仍然完全可以静态理解它。

---

## `filter` 同理

现在：

```python
active = filter(
    source=details,
    where="archived == false && stars > 100",
)
```

这里 `where` 又变成了一门“字符串里的小语言”。

这是应该避免的。

改成：

```python
active = filter(
    details,
    lambda repo: not repo.archived and repo.stars > 100,
)
```

明显更好。

因为你不用再设计第二套 expression parser。

语言统一成一个 AST：

```text
Attribute
Compare
BooleanOp
Literal
```

---

# 最终可能形成一个很漂亮的语言边界

我会把语言分成三个层次。

### 纯表达式

```python
repo.stars > 100
repo.name
x + y
{"name": repo.name, "score": score}
```

保证：

```text
pure
deterministic
terminating
```

### Runtime operators

```python
map(...)
filter(...)
sort(...)
take(...)
parallel(...)
branch(...)
```

负责构造图。

### Effectful callables

```python
github.search_repositories(...)
agent.analyze(...)
email.send(...)
human.approve(...)
```

这些调用被 registry 控制。

所以从 compiler 角度：

```text
Python-like syntax
       ↓
restricted AST
       ↓
pure expression / control operator / callable
       ↓
Execution IR
```

这比设计很多特殊 DSL 语法干净。

---

# 一个很关键的安全规则：所有可调用名称必须来自 Catalog

也就是说，即使语法长得像 Python：

```python
github.get_repository(...)
```

也不代表可以：

```python
os.system(...)
requests.get(...)
open(...)
__import__(...)
```

Compiler 根本不知道这些符号，因此直接：

```text
UNKNOWN_CALLABLE
```

同样：

```python
repo.delete_everything()
```

不应该具有普通 Python method dispatch 语义。

Attribute access 只能用于：

```text
读取结构化值字段
```

不能拿到 callable。

这一下就砍掉了 Python 很大一部分危险动态能力。

---

# 我会避免直接使用 Python 自己的运行时

即便语法兼容 Python 子集，也建议：

```text
source
 ↓
Python parser / your parser
 ↓
validate allowed AST
 ↓
your Execution IR
 ↓
your Runtime
```

而不是：

```text
source
 ↓
sandboxed Python exec()
```

这两个架构完全不同。

前者的安全边界是：

> **非法程序根本无法编译。**

后者是：

> 程序可以执行，但我们努力阻止它做坏事。

对于 Agent 来说，我明显更偏向前者。

---

# 甚至可以直接借 Python AST，而不自己造 tokenizer

这是下一步值得认真评估的。

如果你决定语法高度 Python-like，可以考虑：

```text
LLM 输出 Python subset
        ↓
Python parser
        ↓
AST whitelist validator
        ↓
Agent compiler
        ↓
ExecutionIR
```

比如输入：

```python
repos = github.search_repositories(query="agent framework")
top = take(repos, 5)
return top
```

现成 parser 给你的就是：

```text
Module
 ├ Assign
 │  └ Call
 ├ Assign
 │  └ Call
 └ Return
```

然后你只接受有限节点。

这样项目重点完全回到：

* type system
* graph semantics
* callable/effect model
* runtime
* LLM generation

而不是花大量时间维护 lexer/parser。

当然，如果你希望语言未来明显偏离 Python，就继续自己的 parser。

---

## 我现在甚至会重新考虑这个项目的语言定位

与其说：

> 我们发明了一门 Agent DSL。

不如说：

> **我们定义了一个 Python-like agent programming subset，编译到可验证的 execution graph。**

这个故事可能更容易解释。

它回答了刚才那个“为什么不用 Python”的质疑：

> 我们确实利用 Python。
> 但利用的是 Python 已被模型充分学习的**语法先验**，而不是接受 Python 完整的**运行时语义**。

我觉得这是一个相当稳的架构方向。

如果继续推进，我甚至建议下一次实验不要先加更多 GitHub Tool，而是做一次很小的 **语法 A/B**：

```text
现有 DSL
vs
Python-shaped DSL
```

用完全相同的 ExecutionIR 和 benchmark，让模型完成 20~30 个程序生成任务，比较：

```text
output tokens
syntax validity
semantic conformance
catalog prompt tokens
repair rate
```

如果 Python-shaped syntax 在几乎不牺牲 token efficiency 的情况下明显提高 zero-shot conformance，那基本就能确定语言的表面形态了。
