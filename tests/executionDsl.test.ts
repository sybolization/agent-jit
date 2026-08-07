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
      key: "full_name",
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
  test("reports unknown tool for an unregistered callee (filter/sort/agent are future constructs)", () => {
    const codes = collectCodes(() =>
      compileExecutionDsl('out = filter(source=repos, where="stars > 100")', { tools: githubTools }),
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
      key: "full_name",
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
      key: "full_name",
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
