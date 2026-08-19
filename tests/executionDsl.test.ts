import { describe, expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { compileExecutionDsl, ExecutionDslCompileError } from "../src/compiler/compile.js";
import { compileExecutionDslLegacy } from "../src/experiments/languageVariants/legacyCompile.js";
import { ExecutionGraphSchema, type ComputeNode, type ExecutionNode } from "../src/compiler/ir.js";
import { defineTool } from "../src/tools/definition.js";
import { githubTools } from "../src/tools/providers/github/contracts.js";
import { ToolRegistry } from "../src/tools/registry.js";

const FOUR_LINE = [
  'repos = github.search_repositories(query="agent framework", limit=10)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  "top = take(details, 5)",
  "return top",
].join("\n");

const byId = (nodes: ExecutionNode[]): Map<string, ExecutionNode> => new Map(nodes.map((node) => [node.id, node]));

function collectCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExecutionDslCompileError) return error.diagnostics.map((item) => item.code);
  }
  throw new Error("expected ExecutionDslCompileError");
}

describe("compileExecutionDsl — R4c filter/sort closed operators", () => {
  const FILTER_SORT = [
    'repos = github.search_repositories(query="agent framework language:typescript", limit=20)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'active = filter(details, archived=false, language="TypeScript")',
    'ranked = sort(active, key="forks", desc=true)',
    "top = take(ranked, 3)",
    "return top",
  ].join("\n");
  const compileR4c = (dsl: string) => compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) });

  test("filter/sort 编译为 compute 节点（等值条件 args + desc 恒写入）", () => {
    const { graph, diagnostics } = compileR4c(FILTER_SORT);
    expect(diagnostics).toEqual([]);
    const nodes = byId(graph.nodes);
    expect(nodes.get("active")).toEqual({
      id: "active",
      kind: "compute",
      op: "filter",
      source: "details",
      args: { archived: false, language: "TypeScript" },
    });
    expect(nodes.get("ranked")).toEqual({
      id: "ranked",
      kind: "compute",
      op: "sort",
      source: "active",
      args: { key: "forks", desc: true },
    });
  });

  test("sort 缺 desc → 默认 false（升序）且恒写入", () => {
    const dsl = FILTER_SORT.replace(', desc=true', "");
    const nodes = byId(compileR4c(dsl).graph.nodes);
    expect(nodes.get("ranked")).toEqual({
      id: "ranked",
      kind: "compute",
      op: "sort",
      source: "active",
      args: { key: "forks", desc: false },
    });
  });

  test("sort 缺 key → 编译失败（syntax：缺少必填参数）", () => {
    const dsl = FILTER_SORT.replace('key="forks"', "");
    expect(collectCodes(() => compileR4c(dsl))).toContain("syntax");
  });

  test("sort 的 desc 非布尔 → config_type_mismatch", () => {
    const dsl = FILTER_SORT.replace("desc=true", 'desc="yes"');
    expect(collectCodes(() => compileR4c(dsl))).toContain("config_type_mismatch");
  });

  test("sort 未知参数 → unknown_parameter", () => {
    const dsl = FILTER_SORT.replace('key="forks"', 'field="forks"');
    expect(collectCodes(() => compileR4c(dsl))).toContain("unknown_parameter");
  });

  test("filter 条件引用节点 → invalid_reference（条件必须是字面量）", () => {
    const dsl = FILTER_SORT.replace('language="TypeScript"', "language=other");
    expect(collectCodes(() => compileR4c(dsl))).toContain("invalid_reference");
  });

  test("filter 多余位置参数 → TOO_MANY_POSITIONAL_ARGS", () => {
    const dsl = FILTER_SORT.replace('language="TypeScript"', 'false, language="TypeScript"');
    expect(collectCodes(() => compileR4c(dsl))).toContain("TOO_MANY_POSITIONAL_ARGS");
  });
});

describe("compileExecutionDsl — four-line minimal closed loop", () => {
  test("compiles search -> map -> take -> return into 4 typed nodes", () => {
    const { graph, diagnostics } = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) });
    expect(diagnostics).toEqual([]);
    expect(graph.nodes).toHaveLength(4);
    expect(Value.Check(ExecutionGraphSchema, graph)).toBe(true);

    const nodes = byId(graph.nodes);
    expect(nodes.get("repos")).toEqual({
      id: "repos",
      kind: "tool",
      tool: "github.search_repositories",
      args: {
        query: { kind: "literal", value: "agent framework" },
        limit: { kind: "literal", value: 10 },
      },
    });
    expect(nodes.get("details")).toEqual({
      id: "details",
      kind: "map",
      source: "repos",
      tool: "github.get_repository",
      bindings: { full_name: "full_name" },
      concurrency: 5,
    });
    expect(nodes.get("top")).toEqual({
      id: "top",
      kind: "compute",
      op: "take",
      source: "details",
      args: { count: 5 },
    });
    expect(nodes.get("return")).toEqual({ id: "return", kind: "return", value: "top" });
  });

  test("is deterministic: two compilations produce identical JSON", () => {
    const first = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) });
    const second = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) });
    expect(JSON.stringify(first.graph)).toBe(JSON.stringify(second.graph));
  });

  test("map concurrency defaults to 5 when omitted", () => {
    const source = ['repos = github.search_repositories(query="x")', "details = map(repos, github.get_repository(full_name=_.full_name))", "return details"].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry(githubTools) });
    expect(graph.nodes.find((node) => node.kind === "map")).toMatchObject({ concurrency: 5 });
  });
});

describe("compileExecutionDsl — diagnostics", () => {
  test("reports unknown tool for an unregistered callee (agent 仍是未来 construct)", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('out = agent(source=repos, role="assistant")', { tools: new ToolRegistry(githubTools) }),
    );
    expect(codes).toContain("unknown_tool");
  });

  test("rejects forward references with undefined_reference", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl("details = map(repos, github.get_repository(full_name=_.full_name))", {
        tools: new ToolRegistry(githubTools),
      }),
    );
    expect(codes).toContain("undefined_reference");
  });

  test("rejects duplicate variable names", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="a")', 'repos = github.search_repositories(query="b")'].join("\n"),
        { tools: new ToolRegistry(githubTools) },
      ),
    );
    expect(codes).toContain("duplicate_name");
  });

  test("rejects hallucinated tool parameters with unknown_parameter", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('repos = github.search_repositories(query="x", imaginary="y")', { tools: new ToolRegistry(githubTools) }),
    );
    expect(codes).toContain("unknown_parameter");
  });

  test("rejects a tool literal type mismatch with config_type_mismatch", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('repos = github.search_repositories(query="x", limit="ten")', { tools: new ToolRegistry(githubTools) }),
    );
    expect(codes).toContain("config_type_mismatch");
  });

  test("rejects map referencing an unregistered tool", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="x")', "m = map(repos, github.nope(id=_.id))"].join("\n"),
        { tools: new ToolRegistry(githubTools) },
      ),
    );
    expect(codes).toContain("unknown_tool");
  });

  test("unknown_tool 诊断带 Did you mean（host alias + canonical）", () => {
    try {
      compileExecutionDsl('x = github_get_repositry(query="a")', { tools: new ToolRegistry(githubTools) });
      throw new Error("expected ExecutionDslCompileError");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionDslCompileError);
      const diagnostics = (error as ExecutionDslCompileError).diagnostics;
      const diag = diagnostics.find((item) => item.code === "unknown_tool");
      expect(diag?.message).toContain("github_get_repositry");
      expect(diag?.suggestion).toContain("github_get_repository");
      expect(diag?.suggestion).toContain("github.get_repository");
    }
  });

  test("DSL callee 接受 host alias，IR 永远保存 canonical id", () => {
    const source = [
      'repos = github_search_repositories(query="x")',
      "details = map(repos, github_get_repository(full_name=_.full_name))",
      "return details",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry(githubTools) });
    expect(graph.nodes.find((node) => node.kind === "tool")).toMatchObject({ tool: "github.search_repositories" });
    expect(graph.nodes.find((node) => node.kind === "map")).toMatchObject({ tool: "github.get_repository" });
  });

  test("rejects map source given as a literal (must be a variable reference)", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('m = map("repos", github.get_repository(full_name=_.full_name))', {
        tools: new ToolRegistry(githubTools),
      }),
    );
    expect(codes).toContain("invalid_reference");
  });
});

describe("compileExecutionDslLegacy — callable reference（R2 语言实验变体）", () => {
  const DSL = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    "details = map(source=repos, tool=github.get_repository, key=\"full_name\", concurrency=5)",
    "top = take(source=details, count=3)",
    "return(value=top)",
  ].join("\n");
  // 字符串 tool + key= 写法（legacy key 臂），供"字符串写法不受影响"用例使用
  const KEY_FOUR_LINE = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
    "top = take(source=details, count=3)",
    "return(value=top)",
  ].join("\n");

  test("legacy 默认拒绝裸标识符，报专用诊断码 EXPECTED_STRING_GOT_CALLABLE_REF", () => {
    const codes = collectCodes(() => compileExecutionDslLegacy(DSL, { tools: githubTools }));
    expect(codes).toContain("EXPECTED_STRING_GOT_CALLABLE_REF");
    // 不叠加误导性的 unknown_tool
    expect(codes).not.toContain("unknown_tool");
  });

  test("allowCallableRef=true 时裸标识符编译成与字符串相同的 IR", () => {
    const { graph, diagnostics } = compileExecutionDslLegacy(DSL, { tools: githubTools, allowCallableRef: true });
    expect(diagnostics).toEqual([]);
    const mapNode = byId(graph.nodes).get("details");
    expect(mapNode).toEqual({
      id: "details",
      kind: "map",
      source: "repos",
      tool: "github.get_repository",
      bindings: { full_name: "full_name" },
      concurrency: 5,
    });
    expect(Value.Check(ExecutionGraphSchema, graph)).toBe(true);
  });

  test("字符串写法在 allowCallableRef=true 下不受影响", () => {
    const { diagnostics } = compileExecutionDslLegacy(KEY_FOUR_LINE, { tools: githubTools, allowCallableRef: true });
    expect(diagnostics).toEqual([]);
  });
});

describe("compileExecutionDsl — positional args（canonical：位置参数永远允许）", () => {
  const POSITIONAL_DSL = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    "details = map(repos, github.get_repository(full_name=_.full_name), concurrency=5)",
    "top = take(details, 3)",
    "return top",
  ].join("\n");
  // 命名参数写法（canonical：tool 用嵌套调用命名参数）
  const NAMED_FOUR_LINE = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    "details = map(source=repos, tool=github.get_repository(full_name=_.full_name), concurrency=5)",
    "top = take(source=details, count=5)",
    "return(value=top)",
  ].join("\n");

  test("位置参数编译成与命名参数相同的 IR", () => {
    const { graph, diagnostics } = compileExecutionDsl(POSITIONAL_DSL, { tools: new ToolRegistry(githubTools) });
    expect(diagnostics).toEqual([]);
    expect(graph.nodes).toHaveLength(4);

    const nodes = byId(graph.nodes);
    expect(nodes.get("details")).toEqual({
      id: "details",
      kind: "map",
      source: "repos",
      tool: "github.get_repository",
      bindings: { full_name: "full_name" },
      concurrency: 5,
    });
    expect(nodes.get("top")).toEqual({ id: "top", kind: "compute", op: "take", source: "details", args: { count: 3 } });
    expect(nodes.get("return")).toEqual({ id: "return", kind: "return", value: "top" });
    expect(Value.Check(ExecutionGraphSchema, graph)).toBe(true);
  });

  test("命名写法不受影响", () => {
    const { diagnostics } = compileExecutionDsl(NAMED_FOUR_LINE, { tools: new ToolRegistry(githubTools) });
    expect(diagnostics).toEqual([]);
  });

  test("位置参数与命名参数冲突报 duplicate_argument", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="x")', "m = map(repos, github.get_repository(full_name=_.full_name), source=repos)"].join("\n"),
        { tools: new ToolRegistry(githubTools) },
      ),
    );
    expect(codes).toContain("duplicate_argument");
  });

  test("位置参数过多报 TOO_MANY_POSITIONAL_ARGS", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="x")', 't = take(repos, 3, 4)'].join("\n"),
        { tools: new ToolRegistry(githubTools) },
      ),
    );
    expect(codes).toContain("TOO_MANY_POSITIONAL_ARGS");
  });

  test("tool 调用不支持位置参数（仅 construct 支持）", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('r = github.search_repositories("agent framework", 10)', { tools: new ToolRegistry(githubTools) }),
    );
    expect(codes).toContain("unknown_parameter");
  });
});

describe("compileExecutionDsl — R4e compute/select/join", () => {
  const compileR4e = (dsl: string) => compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) });

  const CORRECT = [
    'repos = github.search_repositories(query="agent framework", limit=30)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'ratio = compute(details, ratio="forks / stars")',
    'high = select(ratio, "ratio > 0.15")',
    'low = select(ratio, "ratio <= 0.15")',
    "contrib = map(high, github.get_contributor_stats(full_name=_.full_name))",
    "commit = map(low, github.list_commits(full_name=_.full_name))",
    'merged = join(ratio, contrib, commit, key="full_name")',
    'kept = select(merged, "score >= 100")',
    'ranked = sort(kept, key="score", desc=true)',
    "top = take(ranked, 3)",
    "return top",
  ].join("\n");

  test("compute/select/join 编译为正确 IR 节点", () => {
    const { graph, diagnostics } = compileR4e(CORRECT);
    expect(diagnostics).toEqual([]);
    const nodes = graph.nodes;
    expect(nodes.find((n) => n.id === "ratio")).toMatchObject({ kind: "compute", op: "compute", args: { ratio: "forks / stars" } });
    expect((nodes.find((n) => n.id === "ratio")! as ComputeNode).expr).toEqual({ ratio: expect.objectContaining({ kind: "binary", op: "/" }) });
    expect(nodes.find((n) => n.id === "high")).toMatchObject({ kind: "compute", op: "select", args: { pred: "ratio > 0.15" } });
    expect((nodes.find((n) => n.id === "high")! as ComputeNode).expr).toEqual({ pred: expect.objectContaining({ kind: "binary", op: ">" }) });
    expect(nodes.find((n) => n.id === "merged")).toMatchObject({
      kind: "join",
      key: "full_name",
      sources: ["ratio", "contrib", "commit"],
    });
  });

  test("compute 表达式非法 → expression_invalid", () => {
    const dsl = CORRECT.replace('ratio="forks / stars"', 'ratio="forks / (stars"');
    const codes = collectCodes(() => compileR4e(dsl));
    expect(codes).toContain("expression_invalid");
  });

  test("select 谓词不是比较 → expression_invalid", () => {
    const dsl = CORRECT.replace('"ratio > 0.15"', '"forks + stars"');
    const codes = collectCodes(() => compileR4e(dsl));
    expect(codes).toContain("expression_invalid");
  });

  test("join 少于 2 个 source → syntax", () => {
    const dsl = CORRECT.replace('join(ratio, contrib, commit', 'join(ratio');
    const codes = collectCodes(() => compileR4e(dsl));
    expect(codes).toContain("syntax");
  });

  test("join 缺 key → 缺必填参数", () => {
    const dsl = CORRECT.replace(', key="full_name"', "");
    const codes = collectCodes(() => compileR4e(dsl));
    expect(codes.some((code) => code === "syntax" || code === "config_type_mismatch" || code === "invalid_reference")).toBe(true);
  });

  test("join 的 source 未定义 → undefined_reference", () => {
    const dsl = CORRECT.replace("join(ratio, contrib, commit", "join(ratio, ghost, commit");
    const codes = collectCodes(() => compileR4e(dsl));
    expect(codes).toContain("undefined_reference");
  });
});

describe("compileExecutionDsl — REQ-3 required 参数强制", () => {
  test("required 参数缺失 → 编译失败（缺少必填参数）", () => {
    let caught: unknown;
    try {
      compileExecutionDsl("x = github.search_repositories()", { tools: new ToolRegistry(githubTools) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    expect(diagnostics.some((item) => item.message === 'github.search_repositories 缺少必填参数“query”')).toBe(true);
  });

  test("required 参数提供了但值非法 → 只报 config_type_mismatch，不叠加缺少必填参数", () => {
    // 注：string kind 参数接受数字/布尔字面量（Task 1 宽松语义），故用数组字面量构造真正的类型错误；
    // key 已出现（seenArgs），required 检查不再叠加"缺少必填参数"
    const codes = collectCodes(() => compileExecutionDsl('x = github.search_repositories(query=["x"])', { tools: new ToolRegistry(githubTools) }));
    expect(codes).toEqual(["config_type_mismatch"]);
    expect(codes).not.toContain("syntax");
  });
});

describe("compileExecutionDsl — REQ-5 map 绑定字段校验（符号表）", () => {
  const compileR5 = (dsl: string) => compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) });

  test("绑定 source 元素上不存在的字段 → UNKNOWN_FIELD，suggestion 列出可用字段，line 指向 map 语句", () => {
    const dsl = [
      'repos = github.search_repositories(query="a")',
      "details = map(repos, github.get_repository(full_name=_.repo_name))",
    ].join("\n");
    let caught: unknown;
    try {
      compileR5(dsl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    const diag = diagnostics.find((item) => item.code === "UNKNOWN_FIELD");
    expect(diag).toBeDefined();
    expect(diag?.message).toContain("repo_name");
    expect(diag?.suggestion).toContain("full_name");
    expect(diag?.line).toBe(2);
  });

  test("字段类型与参数不匹配（integer 字段 → string 参数）→ config_type_mismatch", () => {
    const dsl = [
      'repos = github.search_repositories(query="a")',
      "details = map(repos, github.get_repository(full_name=_.stars))",
    ].join("\n");
    let caught: unknown;
    try {
      compileR5(dsl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    const diag = diagnostics.find((item) => item.code === "config_type_mismatch");
    expect(diag).toBeDefined();
    expect(diag?.message).toContain("_.stars");
    expect(diag?.message).toContain("期望 string");
  });

  test("合法绑定（string 字段 → string 参数，full_name=_.full_name）→ 无诊断", () => {
    const dsl = [
      'repos = github.search_repositories(query="a")',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      "return details",
    ].join("\n");
    const { diagnostics } = compileR5(dsl);
    expect(diagnostics).toEqual([]);
  });

  test("integer 字段 → integer 参数（query=_.full_name, limit=_.stars）→ 通过（integer/number 互配）", () => {
    const dsl = [
      'repos = github.search_repositories(query="a")',
      "m = map(repos, github.search_repositories(query=_.full_name, limit=_.stars))",
      "return m",
    ].join("\n");
    const { graph, diagnostics } = compileR5(dsl);
    expect(diagnostics).toEqual([]);
    expect(graph.nodes.find((node) => node.kind === "map")).toMatchObject({
      bindings: { query: "full_name", limit: "stars" },
    });
  });

  test("compute 产物作为 map source → 元素形状未知，跳过校验不误报（_.ratio）", () => {
    const dsl = [
      'repos = github.search_repositories(query="a")',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="stars / 100")',
      "m = map(ratio, github.get_repository(full_name=_.ratio))",
      "return m",
    ].join("\n");
    const { diagnostics } = compileR5(dsl);
    expect(diagnostics).toEqual([]);
  });

  test("join 结果的元素 schema 取基准 source：基准存在字段通过，未知字段报 UNKNOWN_FIELD", () => {
    const dsl = [
      'repos = github.search_repositories(query="a")',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'merged = join(details, details, key="full_name")',
      "bad = map(merged, github.get_repository(full_name=_.missing))",
    ].join("\n");
    const codes = collectCodes(() => compileR5(dsl));
    expect(codes).toContain("UNKNOWN_FIELD");
  });
});

describe("compileExecutionDsl — canonical 冻结（REQ-7）", () => {
  test("旧 A 臂写法（字符串 tool + key= 元数据）在 canonical 下被拒绝 → MAP_BINDING_EXPECTED_CALL", () => {
    const dsl = [
      'repos = github.search_repositories(query="x")',
      'details = map(repos, "github.get_repository", key="full_name")',
    ].join("\n");
    const codes = collectCodes(() => compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) }));
    expect(codes).toContain("MAP_BINDING_EXPECTED_CALL");
  });
});

describe("结构化诊断 payload（R6.1 error-directed disclosure）", () => {
  test("unknown_tool：未注册 callee → tool + suggestions 结构化字段", () => {
    let caught: unknown;
    try {
      compileExecutionDsl('x = github.nope(query="a")', { tools: new ToolRegistry(githubTools) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    const diag = diagnostics[0]!;
    expect(diag.code).toBe("unknown_tool");
    expect(diag.tool).toBe("github.nope");
    expect(Array.isArray(diag.suggestions)).toBe(true);
  });

  test("unknown_parameter：幻觉参数名 → tool + argument + legalArguments", () => {
    let caught: unknown;
    try {
      compileExecutionDsl('x = github.get_repository(fullname="adv/org-repo-0")', {
        tools: new ToolRegistry(githubTools),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    const diag = diagnostics.find((item) => item.code === "unknown_parameter");
    expect(diag).toBeDefined();
    expect(diag?.tool).toBe("github.get_repository");
    expect(diag?.argument).toBe("fullname");
    expect(diag?.legalArguments).toContain("full_name");
  });

  test("UNKNOWN_FIELD：map 绑定字段不在 source 元素 schema → tool + field + availableFields", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=30)',
      "details = map(repos, github.get_repository(full_name=_.repo_name))",
    ].join("\n");
    let caught: unknown;
    try {
      compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    const diag = diagnostics.find((item) => item.code === "UNKNOWN_FIELD");
    expect(diag).toBeDefined();
    expect(diag?.tool).toBe("github.get_repository");
    expect(diag?.field).toBe("repo_name");
    expect(diag?.availableFields).toContain("full_name");
  });

  test("config_type_mismatch：字面量类型错误 → tool + argument + expected + actual", () => {
    let caught: unknown;
    try {
      compileExecutionDsl('x = github.search_repositories(query="q", limit="thirty")', {
        tools: new ToolRegistry(githubTools),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    const diag = diagnostics.find((item) => item.code === "config_type_mismatch");
    expect(diag).toBeDefined();
    expect(diag?.tool).toBe("github.search_repositories");
    expect(diag?.argument).toBe("limit");
    expect(diag?.expected).toBe("int");
    expect(diag?.actual).toBe("string");
  });
});

describe("compileExecutionDsl — terminal return 完整性校验", () => {
  const compileWithGithub = (dsl: string) => compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) });

  test("无 return 程序（不完整程序）→ missing_return", () => {
    let caught: unknown;
    try {
      compileWithGithub('repos = github.search_repositories(query="x")');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diagnostics = (caught as ExecutionDslCompileError).diagnostics;
    expect(diagnostics.some((item) => item.code === "missing_return")).toBe(true);
  });

  test("两条 return（第二条因 name 占位 return 重名）→ duplicate_return", () => {
    const codes = collectCodes(() => compileWithGithub('a = github.search_repositories(query="x")\nreturn a\nreturn a'));
    expect(codes).toContain("duplicate_return");
  });

  test("return 引用未定义变量 → undefined_reference", () => {
    const codes = collectCodes(() => compileWithGithub('a = github.search_repositories(query="x")\nreturn unknown_var'));
    expect(codes).toContain("undefined_reference");
  });
});

describe("compileExecutionDsl — enum 参数字面量成员校验", () => {
  const editTool = defineTool({
    id: "demo.edit",
    label: "Edit",
    description: "编辑文件",
    inputSchema: Type.Object(
      { sandbox_permissions: Type.Optional(Type.Enum(["workspace-write", "danger-full-access"])) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
  });
  const enumTools = new ToolRegistry([editTool]);
  const compileEnum = (dsl: string) => compileExecutionDsl(dsl, { tools: enumTools });

  test("非法枚举值 → config_type_mismatch，expected 列出合法取值", () => {
    let caught: unknown;
    try {
      compileEnum('r = demo.edit(sandbox_permissions="full-access")\nreturn r');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutionDslCompileError);
    const diag = (caught as ExecutionDslCompileError).diagnostics.find((item) => item.code === "config_type_mismatch");
    expect(diag).toBeDefined();
    expect(diag?.tool).toBe("demo.edit");
    expect(diag?.argument).toBe("sandbox_permissions");
    expect(diag?.expected).toBe('"workspace-write" | "danger-full-access"');
    expect(diag?.message).toContain('"full-access"');
  });

  test("合法枚举值 → 编译通过、零诊断", () => {
    const { diagnostics } = compileEnum('r = demo.edit(sandbox_permissions="workspace-write")\nreturn r');
    expect(diagnostics).toEqual([]);
  });

  test("数值枚举：字符串字面量拒绝、数值字面量通过", () => {
    const levelTool = defineTool({
      id: "demo.level",
      label: "Level",
      inputSchema: Type.Object({ level: Type.Enum([1, 2, 3]) }, { additionalProperties: false }),
      outputSchema: Type.Boolean(),
    });
    const levelTools = new ToolRegistry([levelTool]);
    const compileLevel = (dsl: string) => compileExecutionDsl(dsl, { tools: levelTools });
    expect(collectCodes(() => compileLevel('r = demo.level(level="2")\nreturn r'))).toContain("config_type_mismatch");
    expect(compileLevel("r = demo.level(level=2)\nreturn r").diagnostics).toEqual([]);
  });

  test("map 绑定 enum 兼容规则：enum 字段与 string 字段（字符串枚举）通过；string 字段 → 数值枚举拒绝", () => {
    const sourceTool = defineTool({
      id: "demo.sources",
      label: "Sources",
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Array(
        Type.Object(
          { mode: Type.Enum(["a", "b"]), name: Type.String() },
          { additionalProperties: false },
        ),
      ),
    });
    const stringEnumSink = defineTool({
      id: "demo.string_enum_sink",
      label: "Sink",
      inputSchema: Type.Object({ mode: Type.Enum(["a", "b"]) }, { additionalProperties: false }),
      outputSchema: Type.Boolean(),
    });
    const numericEnumSink = defineTool({
      id: "demo.numeric_enum_sink",
      label: "Sink",
      inputSchema: Type.Object({ mode: Type.Enum([1, 2]) }, { additionalProperties: false }),
      outputSchema: Type.Boolean(),
    });
    const mapTools = new ToolRegistry([sourceTool, stringEnumSink, numericEnumSink]);
    const compileMap = (dsl: string) => compileExecutionDsl(dsl, { tools: mapTools });

    // enum 字段 → 字符串枚举参数：兼容
    expect(compileMap("x = demo.sources()\ny = map(x, demo.string_enum_sink(mode=_.mode))\nreturn y").diagnostics).toEqual([]);
    // string 字段 → 字符串枚举参数：超集方向保守放行（与 int/number 先例一致）
    expect(compileMap("x = demo.sources()\ny = map(x, demo.string_enum_sink(mode=_.name))\nreturn y").diagnostics).toEqual([]);
    // string 字段 → 数值枚举参数：值域无交集 → config_type_mismatch
    const codes = collectCodes(() =>
      compileMap("x = demo.sources()\ny = map(x, demo.numeric_enum_sink(mode=_.name))\nreturn y"),
    );
    expect(codes).toContain("config_type_mismatch");
  });
});
