import { describe, expect, test } from "vitest";

import { ADVERSARIAL_REPOS, createAdversarialGithubTools } from "../src/runtime/mockTools.js";
import { computeR4eAnswer, type AdversarialDetail } from "../src/experiments/r4eBenchmark.js";

const TASK = { ratioThreshold: 0.15, scoreThreshold: 100, takeCount: 3 };

function detailsOf(rows: readonly (typeof ADVERSARIAL_REPOS)[number][]): AdversarialDetail[] {
  return rows.map((row) => ({ full_name: row.full_name, stars: row.stars, forks: row.forks, language: row.language }));
}

/** 按给定路径映射计算答案（overrides 覆盖某 repo 走错路径）——置换测试的 oracle 变体。 */
function answerWith(
  rows: readonly (typeof ADVERSARIAL_REPOS)[number][],
  overrides: Record<string, "contrib" | "commits"> = {},
): string[] {
  const statsMap: Record<string, { score: number }> = {};
  const commitMap: Record<string, { score: number }> = {};
  for (const row of rows) {
    const path = overrides[row.full_name] ?? (row.forks / row.stars > 0.15 ? "contrib" : "commits");
    if (path === "contrib") statsMap[row.full_name] = { score: row.contributor_count * 3 };
    else commitMap[row.full_name] = { score: row.total_commits * 2 };
  }
  return computeR4eAnswer(detailsOf(rows), statsMap, commitMap, TASK);
}

describe("createAdversarialGithubTools — 确定性 mock 数据", () => {
  test("30 个仓库，字段齐全且确定性", () => {
    expect(ADVERSARIAL_REPOS).toHaveLength(30);
    expect(new Set(ADVERSARIAL_REPOS.map((row) => row.full_name)).size).toBe(30);
    for (const row of ADVERSARIAL_REPOS) {
      expect(row.stars).toBeGreaterThan(0);
      expect(row.forks).toBeGreaterThan(0);
      expect(row.forks < row.stars).toBe(true);
    }
  });

  test("search 尊重 limit，返回按表序的 full_name", async () => {
    const tools = createAdversarialGithubTools();
    const search = tools.find((tool) => tool.id === "github.search_repositories")!;
    const result = await search.execute!({ query: "x", limit: 5 });
    expect(result).toEqual([
      { full_name: "adv/org-repo-0" },
      { full_name: "adv/org-repo-1" },
      { full_name: "adv/org-repo-2" },
      { full_name: "adv/org-repo-3" },
      { full_name: "adv/org-repo-4" },
    ]);
  });

  test("get_repository 返回 forks/stars；两路 score 工具各自返回 score", async () => {
    const tools = createAdversarialGithubTools();
    const repo = tools.find((tool) => tool.id === "github.get_repository")!;
    const stats = tools.find((tool) => tool.id === "github.get_contributor_stats")!;
    const commits = tools.find((tool) => tool.id === "github.list_commits")!;
    expect(await repo.execute!({ full_name: "adv/org-repo-0" })).toMatchObject({ full_name: "adv/org-repo-0", forks: 80, stars: 530 });
    expect(await stats.execute!({ full_name: "adv/org-repo-0" })).toEqual({ full_name: "adv/org-repo-0", score: 801 });
    expect(await commits.execute!({ full_name: "adv/org-repo-1" })).toEqual({ full_name: "adv/org-repo-1", score: 750 });
  });

  test("用错字段必错：stars 排序 ≠ forks 排序", () => {
    const byStars = [...ADVERSARIAL_REPOS].sort((a, b) => b.stars - a.stars).map((row) => row.full_name);
    const byForks = [...ADVERSARIAL_REPOS].sort((a, b) => b.forks - a.forks).map((row) => row.full_name);
    expect(byStars.join(",")).not.toBe(byForks.join(","));
  });
});

describe("adversarial separability — 任一单步错误 → 答案必变", () => {
  const N15 = ADVERSARIAL_REPOS.slice(0, 15);
  const N30 = ADVERSARIAL_REPOS;

  test("正确 GT：N=15 → [repo-0, repo-1]（阈值后仅 2 个通过，混合两路）；N=30 → [repo-0, repo-1, repo-17]（N 分叉）", () => {
    expect(answerWith(N15)).toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
    expect(answerWith(N30)).toEqual(["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-17"]);
  });

  test("分错分支（repo-0 误走 commits）→ 答案变", () => {
    expect(answerWith(N15, { "adv/org-repo-0": "commits" })).not.toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("分错分支（repo-1 误走 contributors）→ 答案变", () => {
    expect(answerWith(N15, { "adv/org-repo-1": "contrib" })).not.toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("漏掉阈值（不过滤 score < 100 的 C）→ 答案变（C 顶替为第 3，长度 2→3）", () => {
    const scores = (row: (typeof ADVERSARIAL_REPOS)[number]) =>
      row.forks / row.stars > 0.15 ? row.contributor_count * 3 : row.total_commits * 2;
    const noThreshold = N15
      .map((row) => ({ full_name: row.full_name, score: scores(row) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.full_name);
    // C（repo-2，90 分）是全体第 3 高分 → 漏阈值时错误进答案
    expect(noThreshold).toEqual(["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-2"]);
    expect(noThreshold).not.toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("漏 join（所有 repo 无 score → 全出局）→ 答案变", () => {
    expect(computeR4eAnswer(detailsOf(N15), {}, {}, TASK)).toEqual([]);
  });

  test("只走 contributors 路径（commits 侧 repo 无 score）→ 答案变（缺 repo-1）", () => {
    const statsMap = Object.fromEntries(N15.map((row) => [row.full_name, { score: row.contributor_count * 3 }]));
    const answer = computeR4eAnswer(detailsOf(N15), statsMap, {}, TASK);
    expect(answer).toEqual(["adv/org-repo-0"]);
    expect(answer).not.toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("只走 commits 路径（contributors 侧 repo 无 score）→ 答案变（缺 repo-0）", () => {
    const commitMap = Object.fromEntries(N15.map((row) => [row.full_name, { score: row.total_commits * 2 }]));
    const answer = computeR4eAnswer(detailsOf(N15), {}, commitMap, TASK);
    expect(answer).toEqual(["adv/org-repo-1"]);
    expect(answer).not.toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("按 forks 直接排序（跳过分支/score）→ 答案变", () => {
    const byForks = [...N15].sort((a, b) => b.forks - a.forks).slice(0, 3).map((row) => row.full_name);
    expect(byForks).not.toEqual(["adv/org-repo-0", "adv/org-repo-1"]);
  });

  test("边界仓库（repo-17 ratio=0.15）在 N=30 用 < 而非 <= 分到 contributors → 答案变", () => {
    expect(answerWith(N30, { "adv/org-repo-17": "contrib" })).not.toEqual(["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-17"]);
  });

  test("过阈值者恰好 2 个（801/750），第 3 高分 90 不过阈值——阈值是必要步骤", () => {
    const scores = N15.map((row) => ({ name: row.full_name, score: row.forks / row.stars > 0.15 ? row.contributor_count * 3 : row.total_commits * 2 }))
      .sort((a, b) => b.score - a.score);
    const passing = scores.filter((item) => item.score >= 100);
    expect(passing.map((item) => item.score)).toEqual([801, 750]);
    expect(scores[2]!.score).toBe(90);
  });
});
