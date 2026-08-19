import { describe, expect, test } from "vitest";
import { auditPromptOverlap } from "../src/experiments/r7OverfitAudit.js";

describe("R7 prompt overfit audit（数值证据，不构成新决策阈值）", () => {
  test("中性 prompt 不命中黑名单，最长公共子串很短", () => {
    const audit = auditPromptOverlap(
      "对列表中的每个元素执行相同的工具调用，然后筛选、排序并取前 N。",
      ["搜索 GitHub 上活跃的 agent framework 仓库，取前 30 个，返回 adv/org-repo-0 等完整名称。"],
    );
    expect(audit.forbiddenTokenHits).toEqual([]);
    expect(audit.longestCommonSubstring.length).toBeLessThan(8);
  });

  test("泄漏 prompt 会被黑名单命中", () => {
    const audit = auditPromptOverlap(
      '调用 github.search_repositories(query="agent framework", limit=30)，然后按 ratio > 0.15 分支。',
      ["搜索 GitHub 上活跃的 agent framework 仓库。"],
    );
    expect(audit.forbiddenTokenHits).toEqual(
      expect.arrayContaining(["agent framework", "github.search_repositories", "0.15", "ratio"]),
    );
    expect(audit.longestCommonSubstring).toContain("agent framework");
  });

  test("共享词统计能捕捉模板级重叠", () => {
    const audit = auditPromptOverlap(
      "使用 tool_a 对列表过滤排序取前 N。",
      ["使用 tool_b 对列表过滤排序取前 N。"],
    );
    expect(audit.sharedWordTokens).toEqual(expect.arrayContaining(["使用", "对列表过滤排序取前"]));
  });
});
