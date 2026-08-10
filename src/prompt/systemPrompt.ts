import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";

/**
 * Agent JIT 的统一 DSL 系统提示词构造（DSL 臂）。
 *
 * 常驻 context 只需要：DSL 语法/原则 + 两个元工具（jit_describe_tools / jit_execute_program）。
 * 具体业务工具的 DSL 契约**不内嵌**在提示词里——模型天然知道有哪些业务工具、单次如何调用
 * （Pi 的 Tool Calling 通道以 JSON schema 注册）；当它决定把若干工具编排成程序时，按需调用
 * jit_describe_tools 获取这些工具的输入 + 输出契约，再写程序、调用 jit_execute_program 提交。
 *
 * 两通道：
 * - iterative 臂：模型直接调用业务工具 → `gateway.complete(..., { tools })` 注册；
 * - DSL 臂：模型只调两个 jit_* 元工具（见 src/tools/jitTools.ts），把业务工具当作
 *   DSL callee 写进程序 → 元工具目录经 gateway `tools` 参数动态注册。
 */

/** 语言构造条目注册表（单一事实源；各实验按需启用子集，语法说明不再各写一份）。 */
export const DSL_CONSTRUCTS: Record<string, readonly string[]> = {
  take: ["- take：第一个位置参数是源数组，第二个位置参数是截取条数", "  示例：top = take(details, 3)"],
  filter: [
    "- filter：第一个位置参数是源数组，其余参数是等值条件（<字段>=<字面量>），保留满足全部条件的元素",
    '  示例：active = filter(details, language="TypeScript")',
  ],
  sort: [
    "- sort：第一个位置参数是源数组，key=<字段名> 必填（字符串字面量），desc=true|false 可选（默认升序）",
    '  示例：ranked = sort(contribs, key="total_contributions", desc=true)',
  ],
  compute: [
    "- compute：第一个位置参数是源数组，其余参数是 <输出字段>=<算术表达式字符串>，给每个元素计算新字段",
    '  示例：ratio = compute(details, ratio="forks / stars")',
  ],
  select: [
    "- select：第一个位置参数是源数组，第二个位置参数是比较谓词字符串（> >= < <= == !=），保留满足谓词的元素",
    '  示例：high = select(ratio, "ratio > 0.15")；kept = select(merged, "score >= 100")',
  ],
  merge_by_key: [
    "- merge_by_key：位置参数全部是源数组（至少 2 个，第一个是基准 base），key=<字段名> 必填，按 key 把其余数组的字段合并进基准元素",
    "  语义：给每条基准记录附加另一批数据的字段（基准已有字段不覆盖），**不是**对称合并——需要真正把两段列表接在一起时用 concat",
    '  示例：merged = merge_by_key(details, contrib, commit, key="full_name")',
  ],
  concat: [
    "- concat：位置参数全部是源数组（至少 2 个），按顺序拼接成一个大数组，元素原样保留，不做任何字段合并",
    "  语义：真正的列表拼接——需要把两段列表接在一起时用它，不要用 merge_by_key",
    "  示例：both = concat(high, low)",
  ],
  return: ["- return：直接写要返回的变量名（如 return top）"],
  map: [
    "- map：第一个位置参数是源数组，第二个位置参数是一个“绑定调用”：<工具id>(<参数名>=_.<字段>)，表示把每个元素的 <字段> 传给该工具的 <参数名>",
    "  示例：map(repos, github.get_repository(full_name=_.full_name))",
  ],
  "map-lambda": [
    "- map：第一个位置参数是源数组，第二个位置参数是一个 lambda：lambda <元素名>: <工具id>(<参数名>=<元素名>.<字段>)",
    "  示例：map(repos, lambda repo: github.get_repository(full_name=repo.full_name))",
  ],
  "map-key": [
    '- map：第一个位置参数是源数组，第二个位置参数是工具 id（双引号字符串）；用 key="<字段名>" 指定从每个元素取哪个字段作为该工具的参数',
    '  示例：map(repos, "github.get_repository", key="full_name")',
  ],
};

/** 语言关键字（出现在 <callee> 说明中；顺序即展示顺序）。join 是 merge_by_key 的遗留别名，不再向模型公开。 */
export const LANGUAGE_KEYWORDS = ["map", "take", "filter", "sort", "compute", "select", "merge_by_key", "concat", "return"];

export interface DslSystemPromptOptions {
  /** 启用的语言构造（DSL_CONSTRUCTS 的键）；关键字列表由其与 LANGUAGE_KEYWORDS 求交得出 */
  constructs: readonly string[];
  /** 追加的硬约束（自动编号，追加在默认约束之后） */
  constraints?: readonly string[];
}

const DEFAULT_CONSTRAINTS = [
  `必须通过调用 ${EXECUTE_PROGRAM_TOOL.name} 工具提交程序（把 DSL 源码放在 source 参数里）；不要直接在回复文本中输出代码或 Markdown`,
  `编排工具前必须先调用 ${DESCRIBE_TOOLS_TOOL.name} 获取这些工具在 DSL 中的用法契约（输入参数 + 输出字段）`,
  `参数名必须与 ${DESCRIBE_TOOLS_TOOL.name} 返回的契约完全一致，不得自创参数名`,
  `引用字段（map 绑定 _.字段、sort key、filter 条件）必须来自 ${DESCRIBE_TOOLS_TOOL.name} 返回契约中的输出字段，不得编造字段名`,
  "变量必须先定义再引用（不允许前向引用）",
  `编译失败时，根据返回的诊断修正 DSL，再次调用 ${EXECUTE_PROGRAM_TOOL.name} 重新提交，直到成功为止`,
];

export function buildDslSystemPrompt(options: DslSystemPromptOptions): string {
  const { constructs, constraints = [] } = options;
  const constructKeywords = new Set(constructs.map((name) => name.split("-")[0] ?? name));
  const keywords = LANGUAGE_KEYWORDS.filter((keyword) => constructKeywords.has(keyword));
  const grammarLines = constructs.flatMap((name) => DSL_CONSTRUCTS[name] ?? []);
  const rules = [...DEFAULT_CONSTRAINTS, ...constraints].map((text, index) => `${index + 1}. ${text}`);

  return [
    "你是一名 Agent Execution DSL 编程助手。你的任务是用下面这门小语言写出程序，程序会被编译并在 Harness 上执行。",
    "",
    "## 工作方式（工具契约按需获取，提示词不内嵌工具目录）",
    "- 你（作为普通 Agent）已经知道可用业务工具及其 input contract——单次调用需要哪些参数（由 Pi 的工具注册通道提供）。",
    "- 工具名有两种等价写法，无需记忆换算：canonical（github.get_repository）与 host alias（github_get_repository）都能解析，IR 统一为 canonical。",
    "- 当需要把若干工具组合成一段程序时，用 jit_describe_tools 获取这些工具的 DSL/output contract——在程序里如何调用、输出长什么样（可引用哪些字段）。按顺序：",
    `  1. 调用 ${DESCRIBE_TOOLS_TOOL.name}(tool_names=["工具 id", ...])，一次性获取要编排的工具在 DSL 中的用法契约（输入参数 + 输出字段）；`,
    `  2. 根据返回的契约写出 DSL 程序；`,
    `  3. 调用 ${EXECUTE_PROGRAM_TOOL.name}(source="...") 提交执行。`,
    "- 契约与程序都通过工具调用传递，不要写进回复文本。",
    "",
    "## 语法（newline 分隔语句，每条独占一行）",
    "<name> = <callee>(<参数>, ...)",
    "- <name>：变量名（[a-zA-Z_][a-zA-Z0-9_]*），变量名即图中的节点",
    `- <callee>：已注册工具 id（canonical 或 host alias 均可），或语言关键字 ${keywords.join(" / ")}`,
    "- <value>：字符串（双引号）、数字、布尔、null，或先前定义的变量名（裸标识符即引用，定义数据流边）",
    ...grammarLines,
    "",
    "## 硬约束",
    ...rules,
  ].join("\n");
}
