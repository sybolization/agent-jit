import { describe, expect, test } from "vitest";

import type { RuntimeTool } from "../src/runtime/runtime.js";
import { createAdversarialGithubTools } from "../src/runtime/mockTools.js";
import { buildR4eTasks, computeR4eAnswer, fetchR4eGroundTruth, type AdversarialDetail } from "../src/experiments/r4eBenchmark.js";

describe("buildR4eTasks — 分支重组任务（N ∈ {15, 30}）", () => {
  const tasks = buildR4eTasks();

  test("2 cells，N=15/30，k=3", () => {
    expect(tasks.map((task) => task.n)).toEqual([15, 30]);
    for (const task of tasks) {
      expect(task.k).toBe(3);
      expect(task.takeCount).toBe(3);
      expect(task.ratioThreshold).toBe(0.15);
      expect(task.scoreThreshold).toBe(100);
    }
  });

  test("工具集 = search + get_repository + get_contributor_stats + list_commits", () => {
    for (const task of tasks) {
      expect(task.tools.map((tool) => tool.id).sort()).toEqual([
        "github.get_contributor_stats",
        "github.get_repository",
        "github.list_commits",
        "github.search_repositories",
      ]);
    }
  });

  test("prompt 描述分支规则 / join / 阈值 / submit_answer", () => {
    for (const task of tasks) {
      expect(task.dslPrompt).toContain("ratio");
      expect(task.dslPrompt).toContain("compute");
      expect(task.dslPrompt).toContain("select");
      expect(task.dslPrompt).toContain("join");
      expect(task.dslPrompt).toContain("score >= 100");
      expect(task.iterativePrompt).toContain("submit_answer");
      expect(task.iterativePrompt).toContain("ratio");
    }
  });
});

describe("computeR4eAnswer — oracle 确定性答案", () => {
  const TASK = { ratioThreshold: 0.15, scoreThreshold: 100, takeCount: 3 };
  const details: AdversarialDetail[] = [
    { full_name: "a", stars: 530, forks: 80, language: "TypeScript" }, // ratio .151 → contrib
    { full_name: "b", stars: 670, forks: 100, language: "TypeScript" }, // ratio .149 → commits
    { full_name: "c", stars: 900, forks: 126, language: "TypeScript" }, // ratio .140 → commits
  ];
  const statsMap = { a: { score: 801 } };
  const commitMap = { b: { score: 750 }, c: { score: 110 } };

  test("按 ratio 分支取对应路径 score → 排序取 3", () => {
    expect(computeR4eAnswer(details, statsMap, commitMap, TASK)).toEqual(["a", "b", "c"]);
  });

  test("score 低于阈值的仓库被过滤", () => {
    const low = { ...commitMap, c: { score: 90 } };
    expect(computeR4eAnswer(details, statsMap, low, TASK)).toEqual(["a", "b"]);
  });

  test("路径缺失（漏 join）→ 该仓库出局", () => {
    expect(computeR4eAnswer(details, {}, commitMap, TASK)).toEqual(["b", "c"]);
  });
});

describe("fetchR4eGroundTruth — 确定性链式取数", () => {
  const tools = createAdversarialGithubTools();
  const find = (id: string): RuntimeTool => tools.find((tool) => tool.id === id)!;
  const task15 = buildR4eTasks().find((task) => task.n === 15)!;
  const task30 = buildR4eTasks().find((task) => task.n === 30)!;

  test("N=15 → [repo-0, repo-1]（阈值后仅 2 个通过，混合两路）", async () => {
    expect(
      await fetchR4eGroundTruth(find("github.search_repositories"), find("github.get_repository"), find("github.get_contributor_stats"), find("github.list_commits"), task15),
    ).toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("N=30 → [repo-0, repo-1, repo-17]（N 梯度分叉：repo-17 在 N=30 才出现）", async () => {
    expect(
      await fetchR4eGroundTruth(find("github.search_repositories"), find("github.get_repository"), find("github.get_contributor_stats"), find("github.list_commits"), task30),
    ).toEqual(["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-17"]);
  });
});
