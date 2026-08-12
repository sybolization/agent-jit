import { describe, expect, test } from "vitest";

import { renderCompactManifest } from "../src/tools/compactContractRenderer.js";
import { githubTools } from "../src/tools/providers/github/contracts.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("renderCompactManifest — compact output manifest", () => {
  const registry = new ToolRegistry(githubTools);

  test("只渲染 <id> -> <形状> 行：search 输出为数组对象形状，含 full_name: string", () => {
    const manifest = renderCompactManifest(registry);
    const lines = manifest.split("\n");
    const searchLine = lines.find((line) => line.startsWith("github.search_repositories -> "));
    expect(searchLine).toBeDefined();
    expect(searchLine).toMatch(/github\.search_repositories -> \[\{/);
    expect(searchLine).toContain("full_name: string");
    expect(searchLine).toContain("language: string");
  });

  test("无标题 / 描述 / 输入参数 / schema / # 行——每行都是自包含的形状行", () => {
    const manifest = renderCompactManifest(registry);
    expect(manifest).not.toContain("参数格式");
    expect(manifest).not.toContain("类型定义");
    expect(manifest).not.toContain("description");
    expect(manifest).not.toContain("input");
    expect(manifest).not.toContain("schema");
    expect(manifest).not.toContain("# ");
    // 元数据段也不出现（required / title / $id 是 schema 元数据，boilerplate 是冗余样板串）
    expect(manifest).not.toContain("required");
    expect(manifest).not.toContain("title");
    expect(manifest).not.toContain("$id");
    expect(manifest).not.toContain("boilerplate");
    for (const line of manifest.split("\n")) {
      expect(line).toMatch(/^[\w.]+ -> /);
    }
  });

  test("ids 子集：保持给定顺序，只返回 1 行 github.get_repository -> {…}", () => {
    const manifest = renderCompactManifest(registry, ["github.get_repository"]);
    const lines = manifest.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("github.get_repository -> {")).toBe(true);
    expect(lines[0]).toContain("full_name: string");
    expect(lines[0]).toContain("forks: integer");
  });
});
