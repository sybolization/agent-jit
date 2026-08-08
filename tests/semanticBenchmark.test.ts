import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import type { RegisteredTool } from "../src/tools/definition.js";
import {
  buildR4dTasks,
  computeD2Answer,
  computeD3Answer,
  computeDeterministicAnswer,
  fetchR4dGroundTruth,
  type ContributorStats,
  type CommitStats,
  type RepoDetail,
} from "../src/experiments/semanticBenchmark.js";

describe("buildR4dTasks — 顺序依赖深度梯度（D1/D2/D3 × N=10/30）", () => {
  const tasks = buildR4dTasks();

  test("生成 6 cells", () => {
    expect(tasks.map((task) => `${task.depth}|${task.n}`)).toEqual([
      "D1|10",
      "D1|30",
      "D2|10",
      "D2|30",
      "D3|10",
      "D3|30",
    ]);
  });

  test("k/takeCount 恒 3，sort 恒降序，sortKey 随 depth 变化", () => {
    const sortKeyByDepth = { D1: "forks", D2: "total_contributions", D3: "total_commits" };
    for (const task of tasks) {
      expect(task.k).toBe(3);
      expect(task.takeCount).toBe(3);
      expect(task.sortDesc).toBe(true);
      expect(task.sortKey).toBe(sortKeyByDepth[task.depth]);
    }
  });

  test("filter 条件：D1 无，D2/D3 为 language=TypeScript；D3 带 midTake=5 与 takeCounts=[3,5]", () => {
    const d1 = tasks.find((task) => task.depth === "D1")!;
    const d2 = tasks.find((task) => task.depth === "D2")!;
    const d3 = tasks.find((task) => task.depth === "D3")!;
    expect(d1.filterConditions).toBeUndefined();
    expect(d2.filterConditions).toEqual({ language: "TypeScript" });
    expect(d3.filterConditions).toEqual({ language: "TypeScript" });
    expect(d3.midTake).toBe(5);
    expect(d3.takeCounts).toEqual([3, 5]);
    expect(d2.takeCounts).toBeUndefined();
  });

  test("stageTools 按 return 数据流顺序（return 侧在前）", () => {
    const byDepth = {
      D1: ["github.get_repository"],
      D2: ["github.get_contributor_stats", "github.get_repository"],
      D3: ["github.list_commits", "github.get_contributor_stats", "github.get_repository"],
    };
    for (const task of tasks) {
      expect(task.stageTools).toEqual(byDepth[task.depth]);
    }
  });

  test("工具集随 depth 逐步增加（D1=2 / D2=3 / D3=4）", () => {
    const toolIds = (task: { tools: readonly { id: string }[] }) => task.tools.map((tool) => tool.id).sort();
    expect(toolIds(tasks[0]!)).toEqual(["github.get_repository", "github.search_repositories"]);
    expect(toolIds(tasks[2]!)).toEqual([
      "github.get_contributor_stats",
      "github.get_repository",
      "github.search_repositories",
    ]);
    expect(toolIds(tasks[4]!)).toEqual([
      "github.get_contributor_stats",
      "github.get_repository",
      "github.list_commits",
      "github.search_repositories",
    ]);
  });

  test("prompt 含排序键与 submit_answer（iterative）/ filter（D2/D3）", () => {
    for (const task of tasks) {
      expect(task.dslPrompt).toContain(task.sortKey);
      expect(task.iterativePrompt).toContain("submit_answer");
    }
    const d2 = tasks.find((task) => task.depth === "D2")!;
    expect(d2.dslPrompt).toContain('language="TypeScript"');
    expect(d2.iterativePrompt).toContain("get_contributor_stats");
    const d3 = tasks.find((task) => task.depth === "D3")!;
    expect(d3.dslPrompt).toContain("list_commits");
    expect(d3.iterativePrompt).toContain("list_commits");
  });
});

describe("oracle 纯逻辑（各 depth 确定性答案）", () => {
  const details: RepoDetail[] = [
    { full_name: "owner/a", stars: 1, forks: 10, archived: false, language: "TypeScript" },
    { full_name: "owner/b", stars: 2, forks: 30, archived: false, language: "TypeScript" },
    { full_name: "owner/c", stars: 3, forks: 20, archived: false, language: "TypeScript" },
    { full_name: "owner/d", stars: 4, forks: 5, archived: false, language: "JavaScript" },
    { full_name: "owner/e", stars: 5, forks: 50, archived: false, language: "Python" },
  ];
  const statsMap: Record<string, ContributorStats> = {
    "owner/a": { full_name: "owner/a", contributor_count: 5, total_contributions: 100 },
    "owner/b": { full_name: "owner/b", contributor_count: 20, total_contributions: 300 },
    "owner/c": { full_name: "owner/c", contributor_count: 10, total_contributions: 200 },
    "owner/d": { full_name: "owner/d", contributor_count: 2, total_contributions: 30 },
    "owner/e": { full_name: "owner/e", contributor_count: 15, total_contributions: 250 },
  };
  const commitMap: Record<string, CommitStats> = {
    "owner/a": { full_name: "owner/a", total_commits: 80, latest_commit_at: "2026-01-01T00:00:00Z" },
    "owner/b": { full_name: "owner/b", total_commits: 100, latest_commit_at: "2026-02-01T00:00:00Z" },
    "owner/c": { full_name: "owner/c", total_commits: 50, latest_commit_at: "2026-03-01T00:00:00Z" },
  };
  const d2Spec = { filterConditions: { language: "TypeScript" }, sortDesc: true, takeCount: 3 };
  const d3Spec = { ...d2Spec, midTake: 5 };

  test("D1：按 forks 降序取前 3（含非 TypeScript 仓库）", () => {
    expect(computeDeterministicAnswer(details, { sortKey: "forks", sortDesc: true, takeCount: 3 })).toEqual([
      "owner/e",
      "owner/b",
      "owner/c",
    ]);
  });

  test("D1 升序", () => {
    expect(computeDeterministicAnswer(details, { sortKey: "forks", sortDesc: false, takeCount: 3 })).toEqual([
      "owner/d",
      "owner/a",
      "owner/c",
    ]);
  });

  test("D2：filter(TypeScript) → 按 total_contributions 降序取前 3（淘汰 d/e）", () => {
    expect(computeD2Answer(details, statsMap, d2Spec)).toEqual(["owner/b", "owner/c", "owner/a"]);
  });

  test("D2 filter 后不足 3 → 全返回", () => {
    expect(
      computeD2Answer(details, statsMap, { filterConditions: { language: "JavaScript" }, sortDesc: true, takeCount: 3 }),
    ).toEqual(["owner/d"]);
  });

  test("D3：filter → contributors 排序 → take 5 → commits 排序 → take 3", () => {
    expect(computeD3Answer(details, statsMap, commitMap, d3Spec)).toEqual(["owner/b", "owner/a", "owner/c"]);
  });

  test("D3 midTake 影响阶段 3 输入（只取 contributors 前 2）", () => {
    expect(computeD3Answer(details, statsMap, commitMap, { ...d3Spec, midTake: 2 })).toEqual([
      "owner/b",
      "owner/c",
    ]);
  });
});

describe("fetchR4dGroundTruth — 确定性基准（search + 并行 get_repository + 阶段工具）", () => {
  const d3task = buildR4dTasks().find((task) => task.depth === "D3" && task.n === 10)!;

  const detailByRepo: Record<string, RepoDetail> = {
    "owner/a": { full_name: "owner/a", stars: 1, forks: 10, archived: false, language: "TypeScript" },
    "owner/b": { full_name: "owner/b", stars: 2, forks: 30, archived: false, language: "TypeScript" },
    "owner/c": { full_name: "owner/c", stars: 3, forks: 20, archived: false, language: "TypeScript" },
    "owner/d": { full_name: "owner/d", stars: 4, forks: 5, archived: false, language: "JavaScript" },
    "owner/e": { full_name: "owner/e", stars: 5, forks: 50, archived: false, language: "Python" },
  };
  const statsByRepo: Record<string, ContributorStats> = {
    "owner/a": { full_name: "owner/a", contributor_count: 5, total_contributions: 100 },
    "owner/b": { full_name: "owner/b", contributor_count: 20, total_contributions: 300 },
    "owner/c": { full_name: "owner/c", contributor_count: 10, total_contributions: 200 },
    "owner/d": { full_name: "owner/d", contributor_count: 2, total_contributions: 30 },
    "owner/e": { full_name: "owner/e", contributor_count: 15, total_contributions: 250 },
  };
  const commitsByRepo: Record<string, CommitStats> = {
    "owner/a": { full_name: "owner/a", total_commits: 80, latest_commit_at: null },
    "owner/b": { full_name: "owner/b", total_commits: 100, latest_commit_at: null },
    "owner/c": { full_name: "owner/c", total_commits: 50, latest_commit_at: null },
  };

  const searchTool: RegisteredTool = {
    id: "github.search_repositories",
    label: "Search",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    execute: async (args) => {
      expect((args as { limit?: number }).limit).toBe(10);
      return Object.keys(detailByRepo).map((full_name) => ({ full_name }));
    },
  };
  const repoTool: RegisteredTool = {
    id: "github.get_repository",
    label: "Get",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    execute: async (args) => detailByRepo[(args as { full_name: string }).full_name]!,
  };
  const statsTool: RegisteredTool = {
    id: "github.get_contributor_stats",
    label: "Stats",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    execute: async (args) => statsByRepo[(args as { full_name: string }).full_name]!,
  };
  const commitTool: RegisteredTool = {
    id: "github.list_commits",
    label: "Commits",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    execute: async (args) => commitsByRepo[(args as { full_name: string }).full_name]!,
  };
  const statsTools = { "github.get_contributor_stats": statsTool, "github.list_commits": commitTool };

  test("D3 全链：search → details → filter → stats → take 5 → commits → 答案", async () => {
    const truth = await fetchR4dGroundTruth(searchTool, repoTool, statsTools, d3task);
    // filter(TypeScript) 剩 a/b/c → contributors 排序 b(300)/c(200)/a(100) → take 5 全进 →
    // commits 排序 b(100)/a(80)/c(50) → [owner/b, owner/a, owner/c]
    expect(truth).toEqual(["owner/b", "owner/a", "owner/c"]);
  });

  test("空 search 结果 → 空数组", async () => {
    const emptySearch: RegisteredTool = {
      id: "github.search_repositories",
      label: "Search",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => [],
    };
    expect(await fetchR4dGroundTruth(emptySearch, repoTool, statsTools, d3task)).toEqual([]);
  });
});
