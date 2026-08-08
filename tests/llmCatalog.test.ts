import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { githubTools } from "../src/tools/providers/github/contracts.js";
import { mockDomainToolSpecs } from "../src/tools/providers/domain/mock.js";
import { defineTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { renderCompactToolCatalog, renderToolContracts } from "../src/tools/llmCatalog.js";

const githubCatalog = (): string => renderCompactToolCatalog(new ToolRegistry(githubTools));

describe("renderCompactToolCatalog — 紧凑签名（input contract）", () => {
  test("输入参数按 key: type 渲染，可选参数带 ?", () => {
    const catalog = githubCatalog();
    expect(catalog).toContain("github.search_repositories(");
    expect(catalog).toContain("  query: string");
    expect(catalog).toContain("  limit?: integer");
  });

  test("无参数工具渲染为 name()", () => {
    const catalog = renderCompactToolCatalog(new ToolRegistry(mockDomainToolSpecs));
    expect(catalog).toContain("users.list_users()");
  });

  test("目录头声明工具数量与参数格式", () => {
    const catalog = githubCatalog();
    expect(catalog).toContain("# 工具目录（紧凑签名）— 共 6 个");
  });
});

describe("renderCompactToolCatalog — 命名输出类型（output contract）", () => {
  test("数组元素对象提取为命名类型：search → RepositorySummary[]", () => {
    const catalog = githubCatalog();
    expect(catalog).toContain("-> RepositorySummary[]");
  });

  test("get_repository → Repository（与 RepositorySummary 结构不同，各自定义）", () => {
    const catalog = githubCatalog();
    expect(catalog).toMatch(/\) -> Repository(?:\s|$)/);
  });

  test("类型定义段按结构去重：github 5 个不同结构各出现一次", () => {
    const catalog = githubCatalog();
    for (const name of ["ContributorStat", "Repository", "Commit", "Contributor", "RepositorySummary"]) {
      const occurrences = catalog.match(new RegExp(`^${name} \\{$`, "gm")) ?? [];
      expect(occurrences, `类型 ${name} 应恰好定义一次`).toHaveLength(1);
    }
  });

  test("共享结构只展示一次：crm 两个工具同为 Customer", () => {
    const catalog = renderCompactToolCatalog(new ToolRegistry(mockDomainToolSpecs));
    expect(catalog).toContain(") -> Customer"); // crm.get_customer（对象）
    expect(catalog).toContain(") -> Customer[]"); // crm.search_customers（数组元素复用）
    expect(catalog.match(/^Customer \{$/gm) ?? []).toHaveLength(1);
  });

  test("纯动词段回退 <域名>Result：email.prepare → EmailResult", () => {
    const catalog = renderCompactToolCatalog(new ToolRegistry(mockDomainToolSpecs));
    expect(catalog).toContain(") -> EmailResult");
  });

  test("union 字段渲染为 string | null（list_commits）", () => {
    const catalog = githubCatalog();
    expect(catalog).toContain("  latest_commit_at: string | null");
  });

  test("record 输出内联渲染，不生成命名类型（get_languages）", () => {
    const catalog = githubCatalog();
    expect(catalog).toContain("-> Record<string, number>");
    expect(catalog.match(/^Language \{$/gm) ?? []).toHaveLength(0);
  });

  test("无法识别的输出类型内联为 unknown", () => {
    const tool = defineTool({
      id: "demo.opaque",
      label: "Opaque",
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Any(),
    });
    const catalog = renderCompactToolCatalog(new ToolRegistry([tool]));
    expect(catalog).toContain("-> unknown");
    expect(catalog).not.toContain("Opaque {");
  });

  test("同名但结构不同的输出类型追加数字后缀", () => {
    const registry = new ToolRegistry([
      githubTools.find((tool) => tool.id === "github.get_repository")!,
      defineTool({
        id: "demo.get_repository",
        label: "Other repo",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        outputSchema: Type.Object({ name: Type.String() }, { additionalProperties: false }),
      }),
    ]);
    const catalog = renderCompactToolCatalog(registry);
    expect(catalog).toContain("demo.get_repository() -> Repository");
    expect(catalog).toContain(") -> Repository2");
  });
});

describe("renderCompactToolCatalog — nameTransform", () => {
  test("应用于工具名（pi-ai 下划线命名）", () => {
    const catalog = renderCompactToolCatalog(new ToolRegistry(githubTools), (id) => id.replaceAll(".", "_"));
    expect(catalog).toContain("github_search_repositories(");
    expect(catalog).toContain("github_get_repository(");
  });
});

describe("renderToolContracts — 子集渲染（jit.describe_tools 的渲染内核）", () => {
  test("ids 子集：只渲染请求的工具，头部数量正确", () => {
    const text = renderToolContracts(new ToolRegistry(githubTools), {
      ids: ["github.get_repository", "github.search_repositories"],
    });
    expect(text).toContain("# 工具目录（紧凑签名）— 共 2 个");
    expect(text).toContain("github.get_repository(");
    expect(text).toContain("github.search_repositories(");
    expect(text).not.toContain("github.list_commits");
  });

  test("子集内结构去重仍生效（crm 两个工具共享 Customer）", () => {
    const text = renderToolContracts(new ToolRegistry(mockDomainToolSpecs), {
      ids: ["crm.get_customer", "crm.search_customers"],
    });
    expect(text).toContain(") -> Customer");
    expect(text).toContain(") -> Customer[]");
    expect(text.match(/^Customer \{$/gm) ?? []).toHaveLength(1);
  });
});
