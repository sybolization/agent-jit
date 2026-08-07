import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compiler.js";
import type { ExecutionGraph } from "../src/compiler/ir.js";
import { githubTools } from "../src/compiler/registry.js";
import { createAdversarialGithubTools, createMockGithubTools, createMockDomainTools, mockDomainToolSpecs } from "../src/runtime/mockTools.js";
import { execute, type RuntimeRegistry, type RuntimeTool } from "../src/runtime/runtime.js";
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

describe("runtime — R3 map bindings 多字段与异名展开", () => {
  const domainRegistry = (): RuntimeRegistry =>
    new Map(createMockDomainTools().map((tool) => [tool.spec.id, tool]));

  test("bindings 多字段：email/name → email.prepare(to, name)", async () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, email.prepare(to=_.email, name=_.name))",
      "return m",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: mockDomainToolSpecs, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = await execute(graph, domainRegistry());
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ to: "user1@example.com", name: "User 1" });
  });

  test("bindings 异名：id → customer_id（工具收到参数名 customer_id）", async () => {
    const dsl = [
      "cs = crm.search_customers(limit=10)",
      "m = map(cs, crm.get_customer(customer_id=_.id))",
      "return m",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: mockDomainToolSpecs, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = await execute(graph, domainRegistry());
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ id: "cust-1", name: "Customer 1" });
  });

  test("lambda 臂多字段绑定执行结果一致", async () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, lambda u: email.prepare(to=u.email, name=u.name))",
      "return m",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: mockDomainToolSpecs, allowPositionalArgs: true, allowMapBinding: "lambda" }).graph;
    const result = await execute(graph, domainRegistry());
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ to: "user1@example.com", name: "User 1" });
  });
});

describe("runtime — R4c compute filter/sort", () => {
  const specOf = (id: string): RuntimeTool["spec"] => githubTools.find((tool) => tool.id === id)!;

  function literalSourceRegistry(items: unknown[]): RuntimeRegistry {
    return new Map<string, RuntimeTool>([
      ["github.search_repositories", { spec: specOf("github.search_repositories"), execute: async () => items }],
    ]);
  }

  test("filter 等值条件：多条件 AND，缺字段/非对象丢弃", async () => {
    const dsl = [
      'src = github.search_repositories(query="x", limit=10)',
      'active = filter(src, archived=false, language="TypeScript")',
      "return active",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true }).graph;
    const result = await execute(graph, literalSourceRegistry([
      { full_name: "a", archived: false, language: "TypeScript" },
      { full_name: "b", archived: false, language: "Python" }, // language 不符
      { full_name: "c", archived: true, language: "TypeScript" }, // archived 不符
      { full_name: "d" }, // 缺字段
      "not-an-object", // 非对象
    ]));
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
    expect(items.map((item) => item.full_name)).toEqual(["a"]);
  });

  test("sort：数值降序，缺失字段排末尾（desc），稳定且不改源数组", async () => {
    const dsl = [
      'src = github.search_repositories(query="x", limit=10)',
      'ranked = sort(src, key="forks", desc=true)',
      "return ranked",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true }).graph;
    const source = [
      { full_name: "a", forks: 5 },
      { full_name: "b", forks: 1 },
      { full_name: "c" }, // 缺字段 → -Infinity，desc 时最后
      { full_name: "d", forks: 5 },
      { full_name: "e", forks: 3 },
    ];
    const result = await execute(graph, literalSourceRegistry(source));
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
    // forks 相等时保持原序（a 在 d 前）；c（缺字段）排最后
    expect(items.map((item) => item.full_name)).toEqual(["a", "d", "e", "b", "c"]);
    // 源数组未被修改
    expect(source.map((item) => item.full_name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("sort：字符串字典序升序（缺 desc 默认 false）", async () => {
    const dsl = [
      'src = github.search_repositories(query="x", limit=10)',
      'ranked = sort(src, key="name")',
      "return ranked",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true }).graph;
    const result = await execute(graph, literalSourceRegistry([
      { full_name: "b", name: "beta" },
      { full_name: "a", name: "alpha" },
      { full_name: "c", name: "gamma" },
    ]));
    const items = result.result as Array<Record<string, unknown>>;
    expect(items.map((item) => item.full_name)).toEqual(["a", "b", "c"]);
  });

  test("filter+sort+take 端到端：语义依赖任务（forks 只来自 get_repository）", async () => {
    const details = [
      { full_name: "owner/a", stars: 1, forks: 10, archived: false, language: "TypeScript" },
      { full_name: "owner/b", stars: 2, forks: 30, archived: false, language: "TypeScript" },
      { full_name: "owner/c", stars: 3, forks: 20, archived: true, language: "TypeScript" },
      { full_name: "owner/d", stars: 4, forks: 5, archived: false, language: "JavaScript" },
    ];
    const registry = new Map<string, RuntimeTool>([
      ["github.search_repositories", { spec: specOf("github.search_repositories"), execute: async () => details }],
      [
        "github.get_repository",
        {
          spec: specOf("github.get_repository"),
          execute: async (args) => details.find((d) => d.full_name === (args as { full_name: string }).full_name),
        },
      ],
    ]);
    const dsl = [
      'repos = github.search_repositories(query="agent framework language:typescript", limit=20)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'active = filter(details, archived=false, language="TypeScript")',
      'ranked = sort(active, key="forks", desc=true)',
      "top = take(ranked, 3)",
      "return top",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = await execute(graph, registry);
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
    expect(items.map((item) => item.full_name)).toEqual(["owner/b", "owner/a"]);
    expect(result.trace.find((entry) => entry.id === "active")).toMatchObject({ kind: "compute.filter", inputSize: 4, outputSize: 2 });
    expect(result.trace.find((entry) => entry.id === "ranked")).toMatchObject({ kind: "compute.sort", inputSize: 2, outputSize: 2 });
  });
});

describe("runtime — R4e compute/select/join 执行", () => {
  const registry = new Map(createAdversarialGithubTools().map((tool) => [tool.spec.id, tool]));

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
    const graph = compileExecutionDsl(DSL, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = await execute(graph, registry);
    expect(result.ok).toBe(true);
    const items = result.result as Array<Record<string, unknown>>;
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
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = await execute(graph, registry);
    const items = result.result as Array<Record<string, unknown>>;
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
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = await execute(graph, registry);
    const items = result.result as Array<Record<string, unknown>>;
    const byName = new Map(items.map((item) => [item.full_name, item]));
    // repo-0（contributors 路径）score=801；repo-1（commits 路径）score=750；repo-3（commits）score=80
    expect(byName.get("adv/org-repo-0")).toMatchObject({ score: 801 });
    expect(byName.get("adv/org-repo-1")).toMatchObject({ score: 750 });
    expect(byName.get("adv/org-repo-3")).toMatchObject({ score: 80 });
    // 两路都写 score，但同一 repo 只命中一条路径
    expect(byName.get("adv/org-repo-0")!.score).toBe(801);
  });
});
