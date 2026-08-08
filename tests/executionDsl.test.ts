import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";

import { compileExecutionDsl, ExecutionDslCompileError } from "../src/compiler/compiler.js";
import { ExecutionGraphSchema, type ExecutionNode } from "../src/compiler/ir.js";
import { githubTools } from "../src/compiler/registry.js";

const FOUR_LINE = [
  'repos = github.search_repositories(query="agent framework", limit=10)',
  'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
  "top = take(source=details, count=5)",
  "return(value=top)",
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
  const compileR4c = (dsl: string) =>
    compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" });

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
    const { graph, diagnostics } = compileExecutionDsl(FOUR_LINE, { tools: githubTools });
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
    const first = compileExecutionDsl(FOUR_LINE, { tools: githubTools });
    const second = compileExecutionDsl(FOUR_LINE, { tools: githubTools });
    expect(JSON.stringify(first.graph)).toBe(JSON.stringify(second.graph));
  });

  test("map concurrency defaults to 5 when omitted", () => {
    const source = ['repos = github.search_repositories(query="x")', "details = map(source=repos, tool=\"github.get_repository\", key=\"full_name\")"].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: githubTools });
    expect(graph.nodes.find((node) => node.kind === "map")).toMatchObject({ concurrency: 5 });
  });
});

describe("compileExecutionDsl — diagnostics", () => {
  test("reports unknown tool for an unregistered callee (agent 仍是未来 construct)", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('out = agent(source=repos, role="assistant")', { tools: githubTools }),
    );
    expect(codes).toContain("unknown_tool");
  });

  test("rejects forward references with undefined_reference", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('details = map(source=repos, tool="github.get_repository", key="full_name")', {
        tools: githubTools,
      }),
    );
    expect(codes).toContain("undefined_reference");
  });

  test("rejects duplicate variable names", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="a")', 'repos = github.search_repositories(query="b")'].join("\n"),
        { tools: githubTools },
      ),
    );
    expect(codes).toContain("duplicate_name");
  });

  test("rejects hallucinated tool parameters with unknown_parameter", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('repos = github.search_repositories(query="x", imaginary="y")', { tools: githubTools }),
    );
    expect(codes).toContain("unknown_parameter");
  });

  test("rejects a tool literal type mismatch with config_type_mismatch", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('repos = github.search_repositories(query="x", limit="ten")', { tools: githubTools }),
    );
    expect(codes).toContain("config_type_mismatch");
  });

  test("rejects map referencing an unregistered tool", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="x")', 'm = map(source=repos, tool="github.nope", key="id")'].join("\n"),
        { tools: githubTools },
      ),
    );
    expect(codes).toContain("unknown_tool");
  });

  test("rejects map source given as a literal (must be a variable reference)", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('m = map(source="repos", tool="github.get_repository", key="full_name")', {
        tools: githubTools,
      }),
    );
    expect(codes).toContain("invalid_reference");
  });
});

describe("compileExecutionDsl — callable reference（语言实验开关）", () => {
  const DSL = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    "details = map(source=repos, tool=github.get_repository, key=\"full_name\", concurrency=5)",
    "top = take(source=details, count=3)",
    "return(value=top)",
  ].join("\n");

  test("默认拒绝裸标识符，报专用诊断码 EXPECTED_STRING_GOT_CALLABLE_REF", () => {
    const codes = collectCodes(() => compileExecutionDsl(DSL, { tools: githubTools }));
    expect(codes).toContain("EXPECTED_STRING_GOT_CALLABLE_REF");
    // 不叠加误导性的 unknown_tool
    expect(codes).not.toContain("unknown_tool");
  });

  test("allowCallableRef=true 时裸标识符编译成与字符串相同的 IR", () => {
    const { graph, diagnostics } = compileExecutionDsl(DSL, { tools: githubTools, allowCallableRef: true });
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
    const { diagnostics } = compileExecutionDsl(FOUR_LINE, { tools: githubTools, allowCallableRef: true });
    expect(diagnostics).toEqual([]);
  });
});

describe("compileExecutionDsl — positional args（R2 语言实验开关）", () => {
  const POSITIONAL_DSL = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    'details = map(repos, "github.get_repository", key="full_name", concurrency=5)',
    "top = take(details, 3)",
    "return top",
  ].join("\n");

  test("默认拒绝位置参数，报 POSITIONAL_ARG_NOT_ALLOWED", () => {
    const codes = collectCodes(() => compileExecutionDsl(POSITIONAL_DSL, { tools: githubTools }));
    expect(codes).toContain("POSITIONAL_ARG_NOT_ALLOWED");
  });

  test("allowPositionalArgs=true 时位置参数编译成与命名参数相同的 IR", () => {
    const { graph, diagnostics } = compileExecutionDsl(POSITIONAL_DSL, { tools: githubTools, allowPositionalArgs: true });
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

  test("命名写法在 allowPositionalArgs=true 下不受影响", () => {
    const { diagnostics } = compileExecutionDsl(FOUR_LINE, { tools: githubTools, allowPositionalArgs: true });
    expect(diagnostics).toEqual([]);
  });

  test("位置参数与命名参数冲突报 duplicate_argument", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="x")', 'm = map(repos, "github.get_repository", source=repos, key="id")'].join("\n"),
        { tools: githubTools, allowPositionalArgs: true },
      ),
    );
    expect(codes).toContain("duplicate_argument");
  });

  test("位置参数过多报 TOO_MANY_POSITIONAL_ARGS", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl(
        ['repos = github.search_repositories(query="x")', 't = take(repos, 3, 4)'].join("\n"),
        { tools: githubTools, allowPositionalArgs: true },
      ),
    );
    expect(codes).toContain("TOO_MANY_POSITIONAL_ARGS");
  });

  test("tool 调用不支持位置参数（仅 construct 支持）", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('r = github.search_repositories("agent framework", 10)', { tools: githubTools, allowPositionalArgs: true }),
    );
    expect(codes).toContain("unknown_parameter");
  });
});

describe("compileExecutionDsl — R4e compute/select/join", () => {
  const compileR4e = (dsl: string) =>
    compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" });

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
    expect(nodes.find((n) => n.id === "high")).toMatchObject({ kind: "compute", op: "select", args: { pred: "ratio > 0.15" } });
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
      compileExecutionDsl("x = github.search_repositories()", { tools: githubTools });
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
    const codes = collectCodes(() => compileExecutionDsl('x = github.search_repositories(query=["x"])', { tools: githubTools }));
    expect(codes).toEqual(["config_type_mismatch"]);
    expect(codes).not.toContain("syntax");
  });
});
