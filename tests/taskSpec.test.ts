import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compile.js";
import { githubTools } from "../src/tools/providers/github/contracts.js";
import { mockDomainToolSpecs } from "../src/tools/providers/domain/mock.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { checkTaskCorrectness, type TaskSpec } from "../src/experiments/taskSpec.js";

const SPEC: TaskSpec = { query: "agent framework", limit: 10, mapKey: "full_name", takeCount: 3 };

function compile(dsl: string) {
  const { graph } = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools) });
  return graph;
}

const CORRECT = [
  'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  "top = take(details, 3)",
  "return top",
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
    // key 需是 repos 元素上真实存在的 string 字段（pushed_at），否则 REQ-5 编译期就报 UNKNOWN_FIELD
    const dsl = CORRECT.replace("_.full_name", "_.pushed_at");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("map 的 key"))).toBe(true);
  });

  test("take count 不是 3 → 失败", () => {
    const dsl = CORRECT.replace("take(details, 3)", "take(details, 5)");
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
      "repos_taken = take(repos, 10)",
      "details = map(repos_taken, github.get_repository(full_name=_.full_name))",
      "top = take(details, 3)",
      "return top",
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
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      "return details",
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
    const graph = compileExecutionDsl(githubBindingDsl, { tools: new ToolRegistry(githubTools)}).graph;
    const result = checkTaskCorrectness(graph, { ...SPEC, bindings: { full_name: "full_name" } });
    expect(result.bindingPass).toBe(true);
    expect(result.pass).toBe(true);
  });

  test("绑定错字段（_.language 而非 _.full_name）→ bindingFailures 且 pass 失败", () => {
    // 用 repos 元素上真实存在的 string 字段 language（否则 REQ-5 编译期就报错，测不到 bindingFailures）
    const dsl = githubBindingDsl.replace("_.full_name", "_.language");
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;
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
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(mockDomainToolSpecs)}).graph;
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
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(mockDomainToolSpecs)}).graph;
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
    const graph = compileExecutionDsl(dsl, { tools: new ToolRegistry(mockDomainToolSpecs)}).graph;
    const result = checkTaskCorrectness(graph, { sourceTool: "users.list_users", takeCount: 3, bindings: { to: "email" } });
    expect(result.bindingPass).toBe(false);
    expect(result.bindingFailures?.some((item) => item.includes("多余绑定 name"))).toBe(true);
  });
});

describe("checkTaskCorrectness — R4d filter/sort 语义检查（D2 风格）", () => {
  const CORRECT_D2 = [
    'repos = github.search_repositories(query="agent framework", limit=20)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'active = filter(details, language="TypeScript")',
    "contribs = map(active, github.get_contributor_stats(full_name=_.full_name))",
    'ranked = sort(contribs, key="total_contributions", desc=true)',
    "top = take(ranked, 3)",
    "return top",
  ].join("\n");
  const d2Spec: TaskSpec = {
    query: "agent framework",
    queryTokens: ["agent framework"],
    limit: 20,
    takeCount: 3,
    bindings: { full_name: "full_name" },
    filterConditions: { language: "TypeScript" },
    sortKey: "total_contributions",
    sortDesc: true,
    stageTools: ["github.get_contributor_stats", "github.get_repository"],
  };
  const compileD2 = (dsl: string) =>
    compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;

  test("D2 正确程序通过 filter/sort/stageTools 检查", () => {
    const result = checkTaskCorrectness(compileD2(CORRECT_D2), d2Spec);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("缺少 filter 节点 → 失败", () => {
    const dsl = CORRECT_D2.replace('active = filter(details, language="TypeScript")\n', "").replace(
      "sort(contribs",
      "sort(details",
    ).replace("map(active", "map(details");
    const result = checkTaskCorrectness(compileD2(dsl), d2Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("filter"))).toBe(true);
  });

  test("filter 条件值不符（language 写成 Python）→ 失败", () => {
    const dsl = CORRECT_D2.replace('language="TypeScript"', 'language="Python"');
    const result = checkTaskCorrectness(compileD2(dsl), d2Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("language"))).toBe(true);
  });

  test("filter 多余条件 → 失败", () => {
    const dsl = CORRECT_D2.replace('language="TypeScript"', 'language="TypeScript", stars=100');
    const result = checkTaskCorrectness(compileD2(dsl), d2Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("多余条件"))).toBe(true);
  });

  test("sort key 错误（forks 而非 total_contributions）→ 失败", () => {
    const dsl = CORRECT_D2.replace('key="total_contributions"', 'key="forks"');
    const result = checkTaskCorrectness(compileD2(dsl), d2Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("sort 的 key"))).toBe(true);
  });

  test("sort desc 错误（升序）→ 失败", () => {
    const dsl = CORRECT_D2.replace("desc=true", "desc=false");
    const result = checkTaskCorrectness(compileD2(dsl), d2Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("sort 的 desc"))).toBe(true);
  });

  test("stageTools 缺失（跳过了 get_contributor_stats）→ 失败", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=20)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'active = filter(details, language="TypeScript")',
      "commits = map(active, github.list_commits(full_name=_.full_name))",
      'ranked = sort(commits, key="total_commits", desc=true)',
      "top = take(ranked, 3)",
      "return top",
    ].join("\n");
    const result = checkTaskCorrectness(compileD2(dsl), d2Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("阶段工具顺序"))).toBe(true);
  });

  test("D1 任务（无 filterConditions/stageTools）不要求 filter 节点存在", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=20)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ranked = sort(details, key="forks", desc=true)',
      "top = take(ranked, 3)",
      "return top",
    ].join("\n");
    const spec: TaskSpec = {
      query: "agent framework",
      queryTokens: ["agent framework"],
      limit: 20,
      takeCount: 3,
      bindings: { full_name: "full_name" },
      sortKey: "forks",
      sortDesc: true,
    };
    expect(checkTaskCorrectness(compileD2(dsl), spec).pass).toBe(true);
  });
});

describe("checkTaskCorrectness — R4d 多阶段图检查（D3：双 take / 阶段工具按序）", () => {
  const CORRECT_D3 = [
    'repos = github.search_repositories(query="agent framework", limit=30)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'active = filter(details, language="TypeScript")',
    "contribs = map(active, github.get_contributor_stats(full_name=_.full_name))",
    'ranked = sort(contribs, key="total_contributions", desc=true)',
    "cands = take(ranked, 5)",
    "commits = map(cands, github.list_commits(full_name=_.full_name))",
    'final = sort(commits, key="total_commits", desc=true)',
    "top = take(final, 3)",
    "return top",
  ].join("\n");
  const d3Spec: TaskSpec = {
    query: "agent framework",
    queryTokens: ["agent framework"],
    limit: 30,
    takeCount: 3,
    bindings: { full_name: "full_name" },
    filterConditions: { language: "TypeScript" },
    sortKey: "total_commits",
    sortDesc: true,
    stageTools: ["github.list_commits", "github.get_contributor_stats", "github.get_repository"],
    takeCounts: [3, 5],
  };
  const compileD3 = (dsl: string) =>
    compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;

  test("D3 正确程序通过（双 take 序列 + 阶段工具按序）", () => {
    const result = checkTaskCorrectness(compileD3(CORRECT_D3), d3Spec);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("缺少中间 take(5) → take 序列不匹配", () => {
    const dsl = CORRECT_D3.replace("cands = take(ranked, 5)\n", "").replace("map(cands", "map(ranked");
    const result = checkTaskCorrectness(compileD3(dsl), d3Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("take 序列"))).toBe(true);
  });

  test("中间 take 数量错（6 而非 5）→ take 序列不匹配", () => {
    const dsl = CORRECT_D3.replace("take(ranked, 5)", "take(ranked, 6)");
    const result = checkTaskCorrectness(compileD3(dsl), d3Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("take 序列"))).toBe(true);
  });

  test("缺少 final take(3)（return 直接引用 final sort）→ 缺少 take 节点", () => {
    const dsl = CORRECT_D3.replace("top = take(final, 3)\n", "").replace("return top", "return final");
    const result = checkTaskCorrectness(compileD3(dsl), d3Spec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("take"))).toBe(true);
  });
});

describe("checkTaskCorrectness — R4e 分支重组图检查（compute/select/join）", () => {
  const CORRECT_R4E = [
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
  const r4eSpec: TaskSpec = {
    query: "agent framework",
    queryTokens: ["agent framework"],
    limit: 30,
    takeCount: 3,
    bindings: { full_name: "full_name" },
    sortKey: "score",
    sortDesc: true,
    computeExprs: { ratio: "forks / stars" },
    selectPreds: ["ratio > 0.15", "ratio <= 0.15", "score >= 100"],
    mergeSpec: { key: "full_name", sourceCount: 3, extraTools: ["github.get_contributor_stats", "github.list_commits"] },
  };
  const compileR4e = (dsl: string) =>
    compileExecutionDsl(dsl, { tools: new ToolRegistry(githubTools)}).graph;

  test("R4e 正确程序通过（compute/select×3/join 全检查）", () => {
    const result = checkTaskCorrectness(compileR4e(CORRECT_R4E), r4eSpec);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("缺少 compute(ratio) → computeExprs 失败", () => {
    const dsl = CORRECT_R4E
      .replace('ratio = compute(details, ratio="forks / stars")\n', "")
      .replace('select(ratio, "ratio > 0.15")', 'select(details, "ratio > 0.15")')
      .replace('select(ratio, "ratio <= 0.15")', 'select(details, "ratio <= 0.15")')
      .replace("join(ratio, contrib, commit", "join(details, contrib, commit");
    const result = checkTaskCorrectness(compileR4e(dsl), r4eSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("compute 缺少字段 ratio"))).toBe(true);
  });

  test("分支谓词缺一个（少 low）→ selectPreds 失败", () => {
    const dsl = CORRECT_R4E.replace('low = select(ratio, "ratio <= 0.15")\n', "").replace("map(low", "map(high");
    const result = checkTaskCorrectness(compileR4e(dsl), r4eSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes('select 缺少谓词 "ratio <= 0.15"'))).toBe(true);
  });

  test("阈值谓词写错（>= 100 写成 > 50）→ selectPreds 失败", () => {
    const dsl = CORRECT_R4E.replace('"score >= 100"', '"score > 50"');
    const result = checkTaskCorrectness(compileR4e(dsl), r4eSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("score >= 100"))).toBe(true);
  });

  test("merge_by_key 缺一个分支 source（只 merge contrib）→ mergeSpec.extraTools 失败", () => {
    const dsl2 = CORRECT_R4E.replace("merged = join(ratio, contrib, commit, key=\"full_name\")", "merged = join(ratio, contrib, key=\"full_name\")");
    const result = checkTaskCorrectness(compileR4e(dsl2), r4eSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("分支工具") && item.includes("github.list_commits"))).toBe(true);
  });

  test("merge_by_key 的 key 不是 full_name → 失败", () => {
    const dsl = CORRECT_R4E.replace('key="full_name"', 'key="name"');
    const result = checkTaskCorrectness(compileR4e(dsl), r4eSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("merge_by_key") && item.includes("key"))).toBe(true);
  });

  test("用 concat 拼接分支列表（语义错误地代替 merge_by_key）→ mergeSpec 失败", () => {
    const dsl = CORRECT_R4E.replace(
      'merged = join(ratio, contrib, commit, key="full_name")',
      "merged = concat(contrib, commit)",
    );
    const result = checkTaskCorrectness(compileR4e(dsl), r4eSpec);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("merge_by_key"))).toBe(true);
  });
});
