import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compiler.js";
import { githubTools } from "../src/compiler/registry.js";
import { mockDomainToolSpecs } from "../src/runtime/mockTools.js";
import { checkTaskCorrectness, type TaskSpec } from "../src/experiments/taskSpec.js";

const SPEC: TaskSpec = { query: "agent framework", limit: 10, mapKey: "full_name", takeCount: 3 };

function compile(dsl: string) {
  const { graph } = compileExecutionDsl(dsl, { tools: githubTools });
  return graph;
}

const CORRECT = [
  'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
  'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
  "top = take(source=details, count=3)",
  "return(value=top)",
].join("\n");

describe("checkTaskCorrectness", () => {
  test("正确程序通过所有检查项", () => {
    const result = checkTaskCorrectness(compile(CORRECT), SPEC);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("query 不含关键词 → 失败", () => {
    const dsl = CORRECT.replace('"agent framework language:typescript"', '"python web framework"');
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("query"))).toBe(true);
  });

  test("limit 不是 10 → 失败", () => {
    const dsl = CORRECT.replace("limit=10", "limit=5");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("limit"))).toBe(true);
  });

  test("map key 不是 full_name → 失败", () => {
    const dsl = CORRECT.replace('key="full_name"', 'key="name"');
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("map 的 key"))).toBe(true);
  });

  test("take count 不是 3 → 失败", () => {
    const dsl = CORRECT.replace("count=3", "count=5");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("take 的 count"))).toBe(true);
  });

  test("缺少 return → 失败", () => {
    const dsl = CORRECT.split("\n").slice(0, 3).join("\n");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("return"))).toBe(true);
  });

  test("return 数据流中的冗余 take 不误判（count 只看最终 take）", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
      "repos_taken = take(source=repos, count=10)",
      'details = map(source=repos_taken, tool="github.get_repository", key="full_name", concurrency=5)',
      "top = take(source=details, count=3)",
      "return(value=top)",
    ].join("\n");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("query 漏掉 language:typescript → 失败（queryTokens 逐 token 检查）", () => {
    const dsl = CORRECT.replace("agent framework language:typescript", "agent framework");
    const result = checkTaskCorrectness(compile(dsl), { ...SPEC, queryTokens: ["agent framework", "language:typescript"] });
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("language:typescript"))).toBe(true);
  });

  test("return 直接引用 map 输出（数据流缺最终 take）→ 失败", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
      'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
      "return(value=details)",
    ].join("\n");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("take"))).toBe(true);
  });
});

describe("checkTaskCorrectness — binding correctness（R3 核心指标）", () => {
  const githubBindingDsl = [
    'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    "top = take(details, 3)",
    "return top",
  ].join("\n");

  test("同名绑定正确 → bindingPass 且 pass", () => {
    const graph = compileExecutionDsl(githubBindingDsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = checkTaskCorrectness(graph, { ...SPEC, bindings: { full_name: "full_name" } });
    expect(result.bindingPass).toBe(true);
    expect(result.pass).toBe(true);
  });

  test("绑定错字段（_.name 而非 _.full_name）→ bindingFailures 且 pass 失败", () => {
    const dsl = githubBindingDsl.replace("_.full_name", "_.name");
    const graph = compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = checkTaskCorrectness(graph, { ...SPEC, bindings: { full_name: "full_name" } });
    expect(result.bindingPass).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.bindingFailures?.some((item) => item.includes("full_name 应绑定 full_name"))).toBe(true);
  });

  test("异名绑定正确（id → customer_id）", () => {
    const dsl = [
      "cs = crm.search_customers(limit=10)",
      "m = map(cs, crm.get_customer(customer_id=_.id))",
      "top = take(m, 3)",
      "return top",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: mockDomainToolSpecs, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = checkTaskCorrectness(graph, { sourceTool: "crm.search_customers", limit: 10, takeCount: 3, bindings: { customer_id: "id" } });
    expect(result.bindingPass).toBe(true);
    expect(result.pass).toBe(true);
  });

  test("多字段期望，程序缺 name 绑定 → bindingFailures 记录未绑定", () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, email.prepare(to=_.email))",
      "top = take(m, 3)",
      "return top",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: mockDomainToolSpecs, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = checkTaskCorrectness(graph, { sourceTool: "users.list_users", takeCount: 3, bindings: { to: "email", name: "name" } });
    expect(result.bindingPass).toBe(false);
    expect(result.bindingFailures?.some((item) => item.includes("name"))).toBe(true);
  });

  test("程序多绑定了期望外的参数 → bindingFailures 记录多余绑定", () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, email.prepare(to=_.email, name=_.name))",
      "top = take(m, 3)",
      "return top",
    ].join("\n");
    const graph = compileExecutionDsl(dsl, { tools: mockDomainToolSpecs, allowPositionalArgs: true, allowMapBinding: "call" }).graph;
    const result = checkTaskCorrectness(graph, { sourceTool: "users.list_users", takeCount: 3, bindings: { to: "email" } });
    expect(result.bindingPass).toBe(false);
    expect(result.bindingFailures?.some((item) => item.includes("多余绑定 name"))).toBe(true);
  });
});

describe("checkTaskCorrectness — R4c filter/sort 语义检查", () => {
  const CORRECT_R4C = [
    'repos = github.search_repositories(query="agent framework language:typescript", limit=20)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'active = filter(details, archived=false, language="TypeScript")',
    'ranked = sort(active, key="forks", desc=true)',
    "top = take(ranked, 3)",
    "return top",
  ].join("\n");
  const r4cSpec: TaskSpec = {
    query: "agent framework",
    queryTokens: ["agent framework", "language:typescript"],
    limit: 20,
    takeCount: 3,
    bindings: { full_name: "full_name" },
    filterConditions: { archived: false, language: "TypeScript" },
    sortKey: "forks",
    sortDesc: true,
  };
  const compileR4c = (dsl: string) =>
    compileExecutionDsl(dsl, { tools: githubTools, allowPositionalArgs: true, allowMapBinding: "call" }).graph;

  test("L2 正确程序通过 filter/sort 检查", () => {
    const result = checkTaskCorrectness(compileR4c(CORRECT_R4C), r4cSpec);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("缺少 filter 节点 → 失败", () => {
    const dsl = CORRECT_R4C.replace('active = filter(details, archived=false, language="TypeScript")\n', "").replace(
      "sort(active",
      "sort(details",
    );
    const result = checkTaskCorrectness(compileR4c(dsl), r4cSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("filter"))).toBe(true);
  });

  test("filter 条件值不符（language 写成 Python）→ 失败", () => {
    const dsl = CORRECT_R4C.replace('language="TypeScript"', 'language="Python"');
    const result = checkTaskCorrectness(compileR4c(dsl), r4cSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("language"))).toBe(true);
  });

  test("filter 多余条件（多写了 archived=true 冲突之外的条件）→ 失败", () => {
    const dsl = CORRECT_R4C.replace('language="TypeScript"', 'language="TypeScript", stars=100');
    const result = checkTaskCorrectness(compileR4c(dsl), r4cSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("多余条件"))).toBe(true);
  });

  test("sort key 错误（stars 而非 forks）→ 失败", () => {
    const dsl = CORRECT_R4C.replace('key="forks"', 'key="stars"');
    const result = checkTaskCorrectness(compileR4c(dsl), r4cSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("sort 的 key"))).toBe(true);
  });

  test("sort desc 错误（升序）→ 失败", () => {
    const dsl = CORRECT_R4C.replace("desc=true", "desc=false");
    const result = checkTaskCorrectness(compileR4c(dsl), r4cSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("sort 的 desc"))).toBe(true);
  });

  test("L1 任务（无 filterConditions）不要求 filter 节点存在", () => {
    const dsl = CORRECT_R4C.replace('active = filter(details, archived=false, language="TypeScript")\n', "").replace(
      "sort(active",
      "sort(details",
    );
    const spec: TaskSpec = { ...r4cSpec, filterConditions: undefined };
    expect(checkTaskCorrectness(compileR4c(dsl), spec).pass).toBe(true);
  });
});
