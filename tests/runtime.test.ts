import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compiler.js";
import type { ExecutionGraph } from "../src/compiler/ir.js";
import { githubTools } from "../src/compiler/registry.js";
import { createMockGithubTools } from "../src/runtime/mockTools.js";
import { execute, type RuntimeRegistry } from "../src/runtime/runtime.js";
import { renderTraceText } from "../src/runtime/trace.js";

const FOUR_LINE = [
  'repos = github.search_repositories(query="agent framework", limit=10)',
  'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
  "top = take(source=details, count=5)",
  "return(value=top)",
].join("\n");

function fourLineWithConcurrency(concurrency: number): string {
  return [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    `details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=${concurrency})`,
    "top = take(source=details, count=5)",
    "return(value=top)",
  ].join("\n");
}

function mockRegistry(repositoryCount = 10): RuntimeRegistry {
  return new Map(createMockGithubTools({ repositoryCount }).map((tool) => [tool.spec.id, tool]));
}

describe("runtime — four-line end to end", () => {
  test("executes search -> dynamic map -> take -> return", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: githubTools }).graph;
    const result = await execute(graph, mockRegistry());

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.result)).toBe(true);
    expect(result.result as unknown[]).toHaveLength(5);
    expect((result.result as Array<Record<string, unknown>>)[0]).toMatchObject({ full_name: expect.any(String) });

    expect(result.trace).toHaveLength(4);
    const byId = new Map(result.trace.map((entry) => [entry.id, entry]));
    expect(byId.get("repos")).toMatchObject({ kind: "tool", status: "success", outputSize: 10 });
    expect(byId.get("details")).toMatchObject({ kind: "map", status: "success", fanout: 10, concurrency: 5, outputSize: 10 });
    expect(byId.get("top")).toMatchObject({ kind: "compute.take", status: "success", inputSize: 10, outputSize: 5 });
    expect(byId.get("return")).toMatchObject({ kind: "return", status: "success", outputSize: 5 });
  });

  test("execution is independent of node order (scheduler scans dependencies)", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: githubTools }).graph;
    const reversed: ExecutionGraph = { schema_version: "1", nodes: [...graph.nodes].reverse() };

    const ordered = await execute(graph, mockRegistry());
    const unordered = await execute(reversed, mockRegistry());

    expect(unordered.ok).toBe(true);
    expect(JSON.stringify(unordered.result)).toBe(JSON.stringify(ordered.result));
  });

  test("renders a readable trace text", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: githubTools }).graph;
    const result = await execute(graph, mockRegistry());
    const text = renderTraceText(result.trace, result.totalDurationMs, "run_001");

    expect(text).toContain("run_001");
    expect(text).toContain("details");
    expect(text).toContain("fanout: 10");
    expect(text).toContain("concurrency: 5");
    expect(text).toContain("compute.take");
    expect(text).toContain("total:");
  });

  test("rejects an unregistered tool at runtime", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: githubTools }).graph;
    await expect(execute(graph, new Map())).rejects.toThrow(/未注册的工具/);
  });
});

describe("runtime — map concurrency", () => {
  function probeRegistry(concurrency: number): { registry: RuntimeRegistry; peak: () => number } {
    let active = 0;
    let peak = 0;
    const registry = mockRegistry();
    const original = registry.get("github.get_repository");
    if (!original) throw new Error("mock registry missing get_repository");
    registry.set("github.get_repository", {
      spec: original.spec,
      execute: async (args) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { full_name: String((args as Record<string, unknown>).full_name ?? ""), stars: 100 };
      },
    });
    return { registry, peak: () => peak };
  }

  test.each([1, 2, 5, 10])("DSL 描述逻辑并行度，runtime 实际限制并发（concurrency=%i）", async (concurrency) => {
    const graph = compileExecutionDsl(fourLineWithConcurrency(concurrency), { tools: githubTools }).graph;
    const { registry, peak } = probeRegistry(concurrency);
    const result = await execute(graph, registry);

    expect(result.ok).toBe(true);
    expect(result.trace.find((entry) => entry.id === "details")?.concurrency).toBe(concurrency);
    expect(peak()).toBeLessThanOrEqual(concurrency);
    if (concurrency > 1) {
      expect(peak()).toBeGreaterThan(1); // 确实并行（而非逐个串行）
    } else {
      expect(peak()).toBe(1);
    }
  });
});
