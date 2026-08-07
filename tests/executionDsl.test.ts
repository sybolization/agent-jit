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
  function collectCodes(fn: () => unknown): string[] {
    try {
      fn();
    } catch (error) {
      if (error instanceof ExecutionDslCompileError) return error.diagnostics.map((item) => item.code);
    }
    throw new Error("expected ExecutionDslCompileError");
  }

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
