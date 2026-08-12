import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { compileExecutionDsl } from "../src/compiler/compile.js";
import { compileExecutionDslLegacy } from "../src/experiments/languageVariants/legacyCompile.js";
import type { ExecutionGraph } from "../src/compiler/ir.js";
import { githubTools } from "../src/tools/providers/github/contracts.js";
import type { RegisteredTool, ToolContract } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createAdversarialGithubTools, createMockGithubTools } from "../src/tools/providers/github/mock.js";
import { createMockDomainTools, mockDomainToolSpecs } from "../src/tools/providers/domain/mock.js";
import { execute, type RuntimeRegistry } from "../src/runtime/runtime.js";
import { renderTraceText } from "../src/runtime/trace.js";

const FOUR_LINE = [
  'repos = github.search_repositories(query="agent framework", limit=10)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  "top = take(details, 5)",
  "return top",
].join("\n");

function fourLineWithConcurrency(concurrency: number): string {
  return [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    `details = map(repos, github.get_repository(full_name=_.full_name), concurrency=${concurrency})`,
    "top = take(details, 5)",
    "return top",
  ].join("\n");
}

function mockRegistry(repositoryCount = 10): ToolRegistry<RegisteredTool> {
  return new ToolRegistry(createMockGithubTools({ repositoryCount }));
}

describe("runtime — four-line end to end", () => {
  test("executes search -> dynamic map -> take -> return", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) }).graph;
    const result = await execute(graph, mockRegistry());
    const output = result.status === "success" ? result.result : undefined;

    expect(result.status).toBe("success");
    expect(Array.isArray(output)).toBe(true);
    expect(output as unknown[]).toHaveLength(5);
    expect((output as Array<Record<string, unknown>>)[0]).toMatchObject({ full_name: expect.any(String) });

    expect(result.trace).toHaveLength(4);
    const byId = new Map(result.trace.map((entry) => [entry.id, entry]));
    expect(byId.get("repos")).toMatchObject({ kind: "tool", status: "success", outputSize: 10 });
    expect(byId.get("details")).toMatchObject({ kind: "map", status: "success", fanout: 10, concurrency: 5, outputSize: 10 });
    expect(byId.get("top")).toMatchObject({ kind: "compute.take", status: "success", inputSize: 10, outputSize: 5 });
    expect(byId.get("return")).toMatchObject({ kind: "return", status: "success", outputSize: 5 });
  });

  test("execution is independent of node order (scheduler scans dependencies)", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) }).graph;
    const reversed: ExecutionGraph = { schema_version: "1", nodes: [...graph.nodes].reverse() };

    const ordered = await execute(graph, mockRegistry());
    const unordered = await execute(reversed, mockRegistry());

    expect(unordered.status).toBe("success");
    const orderedOutput = ordered.status === "success" ? ordered.result : undefined;
    const unorderedOutput = unordered.status === "success" ? unordered.result : undefined;
    expect(JSON.stringify(unorderedOutput)).toBe(JSON.stringify(orderedOutput));
  });

  test("renders a readable trace text", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) }).graph;
    const result = await execute(graph, mockRegistry());
    const text = renderTraceText(result.trace, result.totalDurationMs, "run_001");

    expect(text).toContain("run_001");
    expect(text).toContain("details");
    expect(text).toContain("fanout: 10");
    expect(text).toContain("concurrency: 5");
    expect(text).toContain("compute.take");
    expect(text).toContain("total:");
  });

  test("rejects an unregistered tool at runtime → status=failed（不向上 throw）", async () => {
    const graph = compileExecutionDsl(FOUR_LINE, { tools: new ToolRegistry(githubTools) }).graph;
    const result = await execute(graph, new ToolRegistry());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("未注册的工具");
    }
    expect(result.trace.find((entry) => entry.id === "repos")).toMatchObject({ status: "error" });
  });
});

describe("runtime — map concurrency", () => {
  function probeRegistry(concurrency: number): { registry: RuntimeRegistry; peak: () => number } {
    let active = 0;
    let peak = 0;
    const tools = createMockGithubTools({ repositoryCount: 10 }).map((tool) => {
      if (tool.id !== "github.get_repository") return tool;
      return {
        ...tool,
        execute: async (args: unknown) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active -= 1;
          // 输出必须匹配 get_repository 的 outputSchema（REQ-2 运行时校验）
          return {
            full_name: String((args as Record<string, unknown>).full_name ?? ""),
            stars: 100,
            forks: 200,
            archived: false,
            language: "TypeScript",
          };
        },
      };
    });
    return { registry: new ToolRegistry<RegisteredTool>(tools), peak: () => peak };
  }

  test.each([1, 2, 5, 10])("DSL 描述逻辑并行度，runtime 实际限制并发（concurrency=%i）", async (concurrency) => {
    const graph = compileExecutionDsl(fourLineWithConcurrency(concurrency), { tools: new ToolRegistry(githubTools) }).graph;
    const { registry, peak } = probeRegistry(concurrency);
    const result = await execute(graph, registry);

    expect(result.status).toBe("success");
    expect(result.trace.find((entry) => entry.id === "details")?.concurrency).toBe(concurrency);
    expect(peak()).toBeLessThanOrEqual(concurrency);
    if (concurrency > 1) {
      expect(peak()).toBeGreaterThan(1); // 确实并行（而非逐个串行）
    } else {
      expect(peak()).toBe(1);
    }
  });
});

describe("runtime — R3 map bindings 多字段与异名展开", () => {
  const domainRegistry = (): RuntimeRegistry => new ToolRegistry(createMockDomainTools());

  test("bindings 多字段：email/name → email.prepare(to, name)", async () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, email.prepare(to=_.email, name=_.name))",
      "return m",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(mockDomainToolSpecs)}).graph;
    const result = await execute(graph, domainRegistry());
    const output = result.status === "success" ? result.result : undefined;
    expect(result.status).toBe("success");
    const items = output as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ to: "user1@example.com", name: "User 1" });
  });

  test("bindings 异名：id → customer_id（工具收到参数名 customer_id）", async () => {
    const dsl = [
      "cs = crm.search_customers(limit=10)",
      "m = map(cs, crm.get_customer(customer_id=_.id))",
      "return m",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(mockDomainToolSpecs)}).graph;
    const result = await execute(graph, domainRegistry());
    const output = result.status === "success" ? result.result : undefined;
    expect(result.status).toBe("success");
    const items = output as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ id: "cust-1", name: "Customer 1" });
  });

  test("lambda 臂多字段绑定执行结果一致", async () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, lambda u: email.prepare(to=u.email, name=u.name))",
      "return m",
    ].join("\n");
    const graph = compileExecutionDslLegacy(dsl, { tools: mockDomainToolSpecs, allowMapBinding: "lambda" }).graph;
    const result = await execute(graph, domainRegistry());
    const output = result.status === "success" ? result.result : undefined;
    expect(result.status).toBe("success");
    const items = output as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ to: "user1@example.com", name: "User 1" });
  });
});

describe("runtime — R4c compute filter/sort", () => {
  const specOf = (id: string): ToolContract => githubTools.find((tool) => tool.id === id)!;

  function literalSourceRegistry(items: unknown[]): RuntimeRegistry {
    return new ToolRegistry<RegisteredTool>([
      { ...specOf("github.search_repositories"), execute: async () => items },
    ]);
  }

  test("filter 等值条件：多条件 AND，任一条件不匹配即丢弃", async () => {
    const dsl = [
      'src = github.search_repositories(query="x", limit=10)',
      'active = filter(src, archived=false, language="TypeScript")',
      "return active",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
    // 输出须匹配 search 的 outputSchema（full_name/stars/archived/pushed_at/language）——缺字段/非对象已被 schema 校验在上游拦截
    const result = await execute(graph, literalSourceRegistry([
      { full_name: "a", stars: 1, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "b", stars: 2, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "Python" }, // language 不符
      { full_name: "c", stars: 3, archived: true, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" }, // archived 不符
      { full_name: "d", stars: 4, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "Java" }, // language 不符
    ]));
    expect(result.status).toBe("success");
    const output = result.status === "success" ? result.result : undefined;
    const items = output as Array<Record<string, unknown>>;
    expect(items.map((item) => item.full_name)).toEqual(["a"]);
  });

  test("sort：数值降序，稳定且不改源数组", async () => {
    const dsl = [
      'src = github.search_repositories(query="x", limit=10)',
      'ranked = sort(src, key="stars", desc=true)',
      "return ranked",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
    const source = [
      { full_name: "a", stars: 5, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "b", stars: 1, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "c", stars: 0, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" }, // 最小 → desc 最后
      { full_name: "d", stars: 5, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "e", stars: 3, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
    ];
    const result = await execute(graph, literalSourceRegistry(source));
    const output = result.status === "success" ? result.result : undefined;
    expect(result.status).toBe("success");
    const items = output as Array<Record<string, unknown>>;
    // stars 相等时保持原序（a 在 d 前）；c（最小）排最后
    expect(items.map((item) => item.full_name)).toEqual(["a", "d", "e", "b", "c"]);
    // 源数组未被修改
    expect(source.map((item) => item.full_name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("sort：字符串字典序升序（缺 desc 默认 false）", async () => {
    const dsl = [
      'src = github.search_repositories(query="x", limit=10)',
      'ranked = sort(src, key="full_name")',
      "return ranked",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
    const result = await execute(graph, literalSourceRegistry([
      { full_name: "b", stars: 1, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "a", stars: 2, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "c", stars: 3, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
    ]));
    const output = result.status === "success" ? result.result : undefined;
    const items = output as Array<Record<string, unknown>>;
    expect(items.map((item) => item.full_name)).toEqual(["a", "b", "c"]);
  });

  test("filter+sort+take 端到端：语义依赖任务（forks 只来自 get_repository）", async () => {
    const details = [
      { full_name: "owner/a", stars: 1, forks: 10, archived: false, language: "TypeScript" },
      { full_name: "owner/b", stars: 2, forks: 30, archived: false, language: "TypeScript" },
      { full_name: "owner/c", stars: 3, forks: 20, archived: true, language: "TypeScript" },
      { full_name: "owner/d", stars: 4, forks: 5, archived: false, language: "JavaScript" },
    ];
    const registry = new ToolRegistry<RegisteredTool>([
      {
        ...specOf("github.search_repositories"),
        // search 输出必须匹配其 outputSchema（无 forks）——forks 只来自 get_repository（REQ-2 校验）
        execute: async () =>
          details.map(({ full_name, stars, archived, language }) => ({
            full_name,
            stars,
            archived,
            pushed_at: "2026-01-01T00:00:00Z",
            language,
          })),
      },
      {
        ...specOf("github.get_repository"),
        execute: async (args) => details.find((d) => d.full_name === (args as { full_name: string }).full_name),
      },
    ]);
    const dsl = [
      'repos = github.search_repositories(query="agent framework language:typescript", limit=20)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'active = filter(details, archived=false, language="TypeScript")',
      'ranked = sort(active, key="forks", desc=true)',
      "top = take(ranked, 3)",
      "return top",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
    const result = await execute(graph, registry);
    expect(result.status).toBe("success");
    const output = result.status === "success" ? result.result : undefined;
    const items = output as Array<Record<string, unknown>>;
    expect(items.map((item) => item.full_name)).toEqual(["owner/b", "owner/a"]);
    expect(result.trace.find((entry) => entry.id === "active")).toMatchObject({ kind: "compute.filter", inputSize: 4, outputSize: 2 });
    expect(result.trace.find((entry) => entry.id === "ranked")).toMatchObject({ kind: "compute.sort", inputSize: 2, outputSize: 2 });
  });
});

describe("runtime — R4e compute/select/join 执行", () => {
  const registry = new ToolRegistry(createAdversarialGithubTools());

  const DSL = [
    'repos = github.search_repositories(query="agent framework", limit=15)',
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

  test("端到端：compute→分支→两路 map→join→阈值→sort→take 与 oracle 一致", async () => {
    const graph = compileExecutionDsl(DSL, { tools: new ToolRegistry(githubTools)}).graph;
    const result = await execute(graph, registry);
    expect(result.status).toBe("success");
    const output = result.status === "success" ? result.result : undefined;
    const items = output as Array<Record<string, unknown>>;
    // N=15：阈值后仅 repo-0（contrib）与 repo-1（commits）通过 → 混合两路的正确答案
    expect(items.map((item) => item.full_name)).toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("compute 给每个元素计算 ratio 字段（浅拷贝，不改上游）", async () => {
    const dsl = [
      'repos = github.search_repositories(query="x", limit=2)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="forks / stars")',
      "return ratio",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
    const result = await execute(graph, registry);
    const output = result.status === "success" ? result.result : undefined;
    const items = output as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ full_name: "adv/org-repo-0", ratio: 80 / 530 });
    expect(items[0]).toHaveProperty("forks");
  });

  test("join 基准优先：两路都含同名字段 score，互斥路径不冲突", async () => {
    const dsl = [
      'repos = github.search_repositories(query="x", limit=4)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="forks / stars")',
      'high = select(ratio, "ratio > 0.15")',
      'low = select(ratio, "ratio <= 0.15")',
      "contrib = map(high, github.get_contributor_stats(full_name=_.full_name))",
      "commit = map(low, github.list_commits(full_name=_.full_name))",
      'merged = join(ratio, contrib, commit, key="full_name")',
      "return merged",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
    const result = await execute(graph, registry);
    const output = result.status === "success" ? result.result : undefined;
    const items = output as Array<Record<string, unknown>>;
    const byName = new Map(items.map((item) => [item.full_name, item]));
    // repo-0（contributors 路径）score=801；repo-1（commits 路径）score=750；repo-3（commits）score=80
    expect(byName.get("adv/org-repo-0")).toMatchObject({ score: 801 });
    expect(byName.get("adv/org-repo-1")).toMatchObject({ score: 750 });
    expect(byName.get("adv/org-repo-3")).toMatchObject({ score: 80 });
    // 两路都写 score，但同一 repo 只命中一条路径
    expect(byName.get("adv/org-repo-0")!.score).toBe(801);
  });
});

describe("runtime — REQ-2/REQ-4 输出 schema 校验与失败模型", () => {
  const specOf = (id: string): ToolContract => githubTools.find((tool) => tool.id === id)!;

  test("工具 execute 抛错 → status=failed 不向上 throw，trace 记 error", async () => {
    const registry = new ToolRegistry<RegisteredTool>([
      {
        ...specOf("github.search_repositories"),
        execute: async () => {
          throw new Error("boom");
        },
      },
    ]);
    const graph = compileExecutionDsl('repos = github.search_repositories(query="x")\nreturn repos', { tools: new ToolRegistry(githubTools) }).graph;
    const result = await execute(graph, registry);
    // execute() 不向上抛：await 正常返回，status=failed
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("boom");
    }
    expect(result.trace.find((entry) => entry.id === "repos")).toMatchObject({
      status: "error",
      error: expect.stringContaining("boom"),
    });
  });

  test("工具输出与 outputSchema 不匹配 → status=failed，error 含 TOOL_OUTPUT_SCHEMA_MISMATCH", async () => {
    const registry = new ToolRegistry<RegisteredTool>([
      {
        id: "github.search_repositories",
        label: "Search GitHub repositories",
        description: "按查询条件搜索仓库。",
        inputSchema: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
        outputSchema: Type.Object({ full_name: Type.String() }, { additionalProperties: false }),
        execute: async () => ({ full_name: 123 }),
      },
    ]);
    const graph = compileExecutionDsl('repos = github.search_repositories(query="x")\nreturn repos', { tools: new ToolRegistry(githubTools) }).graph;
    const result = await execute(graph, registry);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("TOOL_OUTPUT_SCHEMA_MISMATCH");
    }
    expect(result.trace.find((entry) => entry.id === "repos")).toMatchObject({ status: "error" });
  });

  test("工具入参与 inputSchema 不匹配 → status=failed，execute 未被调用，error 含 TOOL_INPUT_SCHEMA_MISMATCH", async () => {
    let executed = false;
    const registry = new ToolRegistry<RegisteredTool>([
      {
        ...specOf("github.search_repositories"),
        execute: async () => {
          executed = true;
          return [];
        },
      },
    ]);
    // 外部构造 graph：query 为数字字面量（编译器本会拦截，runtime 是最终防线）
    const graph: ExecutionGraph = {
      schema_version: "1",
      nodes: [
        {
          id: "repos",
          kind: "tool",
          tool: "github.search_repositories",
          args: { query: { kind: "literal", value: 123 } },
        },
      ],
    };
    const result = await execute(graph, registry);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("TOOL_INPUT_SCHEMA_MISMATCH");
    }
    expect(executed).toBe(false);
    expect(result.trace.find((entry) => entry.id === "repos")).toMatchObject({ status: "error" });
  });

  test("map 绑定入参与 inputSchema 不匹配 → TOOL_INPUT_SCHEMA_MISMATCH，目标 execute 未被调用", async () => {
    let bCalled = false;
    const registry = new ToolRegistry<RegisteredTool>([
      {
        id: "src.a",
        label: "A",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Array(Type.Object({ count: Type.Integer() }, { additionalProperties: false })),
        execute: async () => [{ count: 1 }],
      },
      {
        id: "dst.b",
        label: "B",
        inputSchema: Type.Object({ count: Type.String() }, { additionalProperties: false }),
        outputSchema: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          bCalled = true;
          return {};
        },
      },
    ]);
    const graph: ExecutionGraph = {
      schema_version: "1",
      nodes: [
        { id: "src", kind: "tool", tool: "src.a", args: {} },
        { id: "m", kind: "map", source: "src", tool: "dst.b", bindings: { count: "count" }, concurrency: 2 },
      ],
    };
    const result = await execute(graph, registry);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("TOOL_INPUT_SCHEMA_MISMATCH");
    }
    expect(bCalled).toBe(false);
  });

  test("同批兄弟节点不被取消：A 失败后 B 仍执行到稳定结束，trace 完整记录 B", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry<RegisteredTool>([
      {
        id: "t.a",
        label: "A",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          order.push("a:start");
          throw new Error("A 失败");
        },
      },
      {
        id: "t.b",
        label: "B",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          order.push("b:start");
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push("b:end");
          return {};
        },
      },
    ]);
    const graph: ExecutionGraph = {
      schema_version: "1",
      nodes: [
        { id: "a", kind: "tool", tool: "t.a", args: {} },
        { id: "b", kind: "tool", tool: "t.b", args: {} },
      ],
    };
    const result = await execute(graph, registry);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("A 失败");
    }
    expect(order).toEqual(["a:start", "b:start", "b:end"]);
    expect(result.trace.find((entry) => entry.id === "b")).toMatchObject({ status: "success" });
  });

  test("人工构造的环不静默结束 → GRAPH_CYCLE_OR_UNRESOLVED_DEPENDENCY", async () => {
    const registry = new ToolRegistry<RegisteredTool>();
    const graph: ExecutionGraph = {
      schema_version: "1",
      nodes: [
        { id: "a", kind: "tool", tool: "x", args: { b: { kind: "ref", name: "b" } } },
        { id: "b", kind: "tool", tool: "x", args: { a: { kind: "ref", name: "a" } } },
      ],
    };
    const result = await execute(graph, registry);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("GRAPH_CYCLE_OR_UNRESOLVED_DEPENDENCY");
    }
  });
});
