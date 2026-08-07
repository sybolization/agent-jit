import { describe, expect, test } from "vitest";

import type { RuntimeTool } from "../src/runtime/runtime.js";
import {
  buildR4cTasks,
  computeDeterministicAnswer,
  fetchR4cGroundTruth,
  type RepoDetail,
} from "../src/experiments/semanticBenchmark.js";

describe("buildR4cTasks — 语义依赖梯度（深度 × 成本）", () => {
  const tasks = buildR4cTasks();

  test("生成 L1/L2 × N=5/20 四档", () => {
    expect(tasks.map((task) => `${task.level}|${task.n}`)).toEqual(["L1|5", "L1|20", "L2|5", "L2|20"]);
  });

  test("k = min(3, N)，takeCount 恒 3，sort 恒按 forks 降序", () => {
    for (const task of tasks) {
      expect(task.k).toBe(Math.min(3, task.n));
      expect(task.takeCount).toBe(3);
      expect(task.sortKey).toBe("forks");
      expect(task.sortDesc).toBe(true);
    }
  });

  test("L2 带 filterConditions（archived=false + language=TypeScript），L1 无", () => {
    const l1 = tasks.find((task) => task.level === "L1")!;
    const l2 = tasks.find((task) => task.level === "L2")!;
    expect(l1.filterConditions).toBeUndefined();
    expect(l2.filterConditions).toEqual({ archived: false, language: "TypeScript" });
    expect(l2.dslPrompt).toContain("archived=false");
    expect(l2.iterativePrompt).toContain("archived=false");
    expect(l1.dslPrompt).not.toContain("archived");
  });

  test("工具集只含 search + get_repository（两臂共用）", () => {
    for (const task of tasks) {
      expect(task.tools.map((tool) => tool.id).sort()).toEqual(["github.get_repository", "github.search_repositories"]);
    }
  });
});

describe("computeDeterministicAnswer — oracle 纯逻辑", () => {
  const details: RepoDetail[] = [
    { full_name: "owner/a", stars: 1, forks: 10, archived: false, language: "TypeScript" },
    { full_name: "owner/b", stars: 2, forks: 30, archived: false, language: "TypeScript" },
    { full_name: "owner/c", stars: 3, forks: 20, archived: true, language: "TypeScript" },
    { full_name: "owner/d", stars: 4, forks: 5, archived: false, language: "JavaScript" },
  ];
  const base = { sortKey: "forks", sortDesc: true, takeCount: 3 };

  test("L1：按 forks 降序取前 3", () => {
    expect(computeDeterministicAnswer(details, base)).toEqual(["owner/b", "owner/c", "owner/a"]);
  });

  test("L2：先 filter 再排序", () => {
    const task = { ...base, filterConditions: { archived: false, language: "TypeScript" } };
    expect(computeDeterministicAnswer(details, task)).toEqual(["owner/b", "owner/a"]);
  });

  test("filter 后不足 3 个 → 全返回", () => {
    const task = { ...base, filterConditions: { language: "JavaScript" } };
    expect(computeDeterministicAnswer(details, task)).toEqual(["owner/d"]);
  });

  test("sortDesc=false → 升序", () => {
    expect(computeDeterministicAnswer(details, { ...base, sortDesc: false })).toEqual(["owner/d", "owner/a", "owner/c"]);
  });
});

describe("fetchR4cGroundTruth — 确定性基准（search + 并行 get_repository）", () => {
  const l2task = buildR4cTasks().find((task) => task.level === "L2" && task.n === 5)!;

  function makeSearchTool(items: Array<{ full_name: string }>): RuntimeTool {
    return {
      spec: { id: "github.search_repositories", label: "Search", outputKind: "list", parameters: [] },
      execute: async (args) => {
        expect((args as { limit?: number }).limit).toBe(5);
        return items;
      },
    };
  }

  const detailByRepo: Record<string, RepoDetail> = {
    "owner/a": { full_name: "owner/a", stars: 1, forks: 10, archived: false, language: "TypeScript" },
    "owner/b": { full_name: "owner/b", stars: 2, forks: 30, archived: false, language: "TypeScript" },
    "owner/c": { full_name: "owner/c", stars: 3, forks: 20, archived: true, language: "TypeScript" },
    "owner/d": { full_name: "owner/d", stars: 4, forks: 5, archived: false, language: "JavaScript" },
    "owner/e": { full_name: "owner/e", stars: 5, forks: 50, archived: false, language: "TypeScript" },
  };

  test("search(limit=n) → get_repository × n → 确定性答案（L2 filter 后排序）", async () => {
    const repoTool: RuntimeTool = {
      spec: { id: "github.get_repository", label: "Get", outputKind: "object", parameters: [] },
      execute: async (args) => detailByRepo[(args as { full_name: string }).full_name]!,
    };
    const truth = await fetchR4cGroundTruth(
      makeSearchTool(Object.keys(detailByRepo).map((full_name) => ({ full_name }))),
      repoTool,
      l2task,
    );
    // L2：排除 archived 的 c 与 JavaScript 的 d → 剩余按 forks 降序前 3 → e(50), b(30), a(10)
    expect(truth).toEqual(["owner/e", "owner/b", "owner/a"]);
  });

  test("空 search 结果 → 空数组", async () => {
    const repoTool: RuntimeTool = {
      spec: { id: "github.get_repository", label: "Get", outputKind: "object", parameters: [] },
      execute: async () => ({}),
    };
    expect(await fetchR4cGroundTruth(makeSearchTool([]), repoTool, l2task)).toEqual([]);
  });
});
