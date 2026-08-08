import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import type { RegisteredTool } from "../src/tools/definition.js";
import { buildBenchmarkTasks, fetchGroundTruth } from "../src/experiments/programmaticBenchmark.js";

const SEARCH_SPEC = {
  id: "github.search_repositories",
  label: "Search",
  inputSchema: Type.Object({}),
  outputSchema: Type.Object({}),
};

function makeSearchTool(items: Array<{ full_name: string }>): {
  tool: RegisteredTool;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    tool: {
      ...SEARCH_SPEC,
      execute: async (args) => {
        calls.push(args as Record<string, unknown>);
        return items;
      },
    },
    calls,
  };
}

describe("fetchGroundTruth — 确定性基准（两臂共用）", () => {
  test("以 limit=n 调用 search，取前 k 个 full_name", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ full_name: `owner/repo-${i}` }));
    const { tool, calls } = makeSearchTool(items);

    const truth = await fetchGroundTruth(tool, 10, 3);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ query: "agent framework language:typescript", limit: 10 });
    expect(truth).toEqual(["owner/repo-0", "owner/repo-1", "owner/repo-2"]);
  });

  test("k 不超过返回条数", async () => {
    const { tool } = makeSearchTool([{ full_name: "owner/a" }, { full_name: "owner/b" }]);
    const truth = await fetchGroundTruth(tool, 5, 3);
    expect(truth).toEqual(["owner/a", "owner/b"]);
  });

  test("空结果返回空数组", async () => {
    const { tool } = makeSearchTool([]);
    const truth = await fetchGroundTruth(tool, 5, 3);
    expect(truth).toEqual([]);
  });
});

describe("buildBenchmarkTasks — 复杂度梯度", () => {
  const tasks = buildBenchmarkTasks();

  test("生成 N=2/5/10/20 四档", () => {
    expect(tasks.map((task) => task.n)).toEqual([2, 5, 10, 20]);
  });

  test("k = min(3, N)，且两臂 prompt 的取数一致", () => {
    const n2 = tasks.find((task) => task.n === 2)!;
    const n20 = tasks.find((task) => task.n === 20)!;
    expect(n2.k).toBe(2);
    expect(n20.k).toBe(3);
    expect(n2.dslPrompt).toContain("取前 2 个");
    expect(n2.dslPrompt).toContain("截取前 2 个");
    expect(n20.dslPrompt).toContain("取前 20 个");
    expect(n20.dslPrompt).toContain("截取前 3 个");
    expect(n2.iterativePrompt).toContain("取前 2 个");
    expect(n20.iterativePrompt).toContain("取前 20 个");
  });

  test("工具集只含 search + get_repository（两臂共用）", () => {
    for (const task of tasks) {
      expect(task.tools.map((tool) => tool.id).sort()).toEqual(["github.get_repository", "github.search_repositories"]);
    }
  });
});
