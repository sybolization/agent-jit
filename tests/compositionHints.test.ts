import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { githubTools } from "../src/tools/providers/github/contracts.js";
import { createR5IssueTools } from "../src/experiments/r5Tasks.js";
import { defineTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { deriveCompositionHints, renderCompositionBindings } from "../src/tools/compositionHints.js";

describe("deriveCompositionHints — 局部 type-derived 兼容连接", () => {
  test("search_repositories[].full_name → 五个下游（都接受 full_name 参数）", () => {
    const hints = deriveCompositionHints(githubTools);
    const fromSearch = hints.filter((hint) => hint.fromTool === "github.search_repositories");
    expect(fromSearch).toHaveLength(5);
    expect(fromSearch.map((hint) => hint.toTool).sort()).toEqual([
      "github.get_contributor_stats",
      "github.get_languages",
      "github.get_repository",
      "github.list_commits",
      "github.list_contributors",
    ]);
    for (const hint of fromSearch) {
      expect(hint.fromField).toBe("full_name");
      expect(hint.fromArray).toBe(true);
      expect(hint.toParam).toBe("full_name");
      expect(hint.type).toBe("string");
    }
  });

  test("get_repository.full_name → 四个下游（排除自身，search 无 full_name 入参）", () => {
    const hints = deriveCompositionHints(githubTools);
    const fromRepo = hints.filter((hint) => hint.fromTool === "github.get_repository");
    expect(fromRepo).toHaveLength(4);
    expect(fromRepo.some((hint) => hint.toTool === "github.get_repository")).toBe(false);
  });

  test("无同名 input 参数的输出字段（stars/archived/language/forks/pushed_at）不产生 hint", () => {
    const hints = deriveCompositionHints(githubTools);
    const fields = hints.map((hint) => hint.fromField);
    for (const forbidden of ["stars", "archived", "language", "forks", "pushed_at"]) {
      expect(fields).not.toContain(forbidden);
    }
  });

  test("union 字段（list_commits.latest_commit_at）不产生 hint", () => {
    const hints = deriveCompositionHints(githubTools);
    expect(hints.every((hint) => hint.fromField !== "latest_commit_at")).toBe(true);
  });

  test("R5-C 契约：get_issues[].number → get_issue_score(number) / get_issue(number)；title/state/comments 无 hint", () => {
    const hints = deriveCompositionHints(createR5IssueTools());
    const fromIssues = hints.filter((hint) => hint.fromTool === "github.get_issues");
    expect(fromIssues.map((hint) => `${hint.toTool}(${hint.toParam})`).sort()).toEqual([
      "github.get_issue(number)",
      "github.get_issue_score(number)",
    ]);
    expect(fromIssues[0]!.fromField).toBe("number");
    expect(fromIssues[0]!.fromArray).toBe(true);
    for (const forbidden of ["title", "state", "comments"]) {
      expect(hints.every((hint) => hint.fromField !== forbidden)).toBe(true);
    }
  });

  test("类型不兼容不产生 hint：string 输出字段 → integer 参数", () => {
    const contracts = [
      defineTool({
        id: "demo.list_things",
        label: "List",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: false })),
      }),
      defineTool({
        id: "demo.get_thing",
        label: "Get",
        inputSchema: Type.Object({ name: Type.Integer() }, { additionalProperties: false }),
        outputSchema: Type.Object({}, { additionalProperties: false }),
      }),
    ];
    expect(deriveCompositionHints(contracts)).toEqual([]);
  });

  test("integer ↔ number 互通：integer 输出可喂 number 参数", () => {
    const contracts = [
      defineTool({
        id: "demo.list_counts",
        label: "List",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Array(Type.Object({ count: Type.Integer() }, { additionalProperties: false })),
      }),
      defineTool({
        id: "demo.avg_count",
        label: "Avg",
        inputSchema: Type.Object({ count: Type.Number() }, { additionalProperties: false }),
        outputSchema: Type.Object({}, { additionalProperties: false }),
      }),
    ];
    const hints = deriveCompositionHints(contracts);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ fromTool: "demo.list_counts", toTool: "demo.avg_count", toParam: "count" });
  });

  test("空契约 → 空列表", () => {
    expect(deriveCompositionHints([])).toEqual([]);
  });
});

describe("renderCompositionBindings — 渲染 ## Compatible bindings 段", () => {
  const catalog = new ToolRegistry(githubTools);

  test("有兼容 → 渲染局部连接（array 字段用 tool[].field）", () => {
    const text = renderCompositionBindings(catalog, ["github.search_repositories", "github.get_repository"]);
    expect(text.startsWith("## Compatible bindings")).toBe(true);
    expect(text).toContain("github.search_repositories[].full_name");
    expect(text).toContain("→ github.get_repository(full_name)");
  });

  test("对象字段用 tool.field 渲染（全量 github 契约）", () => {
    const text = renderCompositionBindings(catalog, githubTools.map((tool) => tool.id));
    expect(text).toContain("github.get_repository.full_name");
    expect(text).toContain("→ github.list_commits(full_name)");
  });

  test("无兼容 / 空 ids → 空串", () => {
    expect(renderCompositionBindings(catalog, [])).toBe("");
    expect(renderCompositionBindings(catalog, ["github.get_languages"])).toBe("");
  });

  test("确定性：两次调用文本一致", () => {
    const ids = ["github.search_repositories", "github.get_repository"];
    expect(renderCompositionBindings(catalog, ids)).toBe(renderCompositionBindings(catalog, ids));
  });

  test("未知 id 被跳过（不抛错）", () => {
    const text = renderCompositionBindings(catalog, [
      "github.search_repositories",
      "github.get_repository",
      "nope.tool",
    ]);
    expect(text).toContain("github.search_repositories[].full_name");
    expect(text).toContain("→ github.get_repository(full_name)");
  });
});
