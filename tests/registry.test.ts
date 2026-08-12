import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { githubTools } from "../src/tools/providers/github/contracts.js";
import { createMockGithubTools } from "../src/tools/providers/github/mock.js";
import { defineTool } from "../src/tools/definition.js";
import { editDistance, ToolRegistry, toolIdAlias, type ToolCatalog } from "../src/tools/registry.js";
import { renderExecutionToolCatalog } from "../src/experiments/executionCatalog.js";
import { compileExecutionDsl } from "../src/compiler/compile.js";
import { toolParams } from "../src/compiler/helpers.js";

describe("ToolRegistry — register/get/has/all/ids", () => {
  test("register 后可按 id 读取，未注册的返回 undefined", () => {
    const registry = new ToolRegistry();
    registry.register({ id: "demo.a", label: "A", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    expect(registry.has("demo.a")).toBe(true);
    expect(registry.get("demo.a")).toMatchObject({ id: "demo.a", label: "A" });
    expect(registry.has("demo.b")).toBe(false);
    expect(registry.get("demo.b")).toBeUndefined();
  });

  test("ids/all 反映注册内容（注册序）", () => {
    const registry = new ToolRegistry();
    registry.register({ id: "demo.a", label: "A", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    registry.register({ id: "demo.b", label: "B", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    expect(registry.ids()).toEqual(["demo.a", "demo.b"]);
    expect(registry.all().map((tool) => tool.id)).toEqual(["demo.a", "demo.b"]);
  });

  test("constructor 接受初始 definitions（含 githubTools）", () => {
    const registry = new ToolRegistry(githubTools);
    expect(registry.ids()).toHaveLength(6);
    expect(registry.has("github.get_repository")).toBe(true);
  });

  test("register 同名 id 拒绝（重复注册尽早报错）", () => {
    const registry = new ToolRegistry();
    registry.register({ id: "demo.a", label: "A1", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    expect(() =>
      registry.register({ id: "demo.a", label: "A2", inputSchema: Type.Object({}), outputSchema: Type.Object({}) }),
    ).toThrow(/重复注册/);
    expect(registry.get("demo.a")?.label).toBe("A1");
    expect(registry.all()).toHaveLength(1);
  });
});

describe("githubTools — defineTool 静态契约", () => {
  test("6 个工具，id 唯一，契约齐备且无 execute（执行体由 provider 补上）", () => {
    expect(githubTools).toHaveLength(6);
    expect(new Set(githubTools.map((tool) => tool.id)).size).toBe(6);
    for (const tool of githubTools) {
      expect(tool.label).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect("execute" in tool).toBe(false);
    }
  });

  test("search_repositories inputSchema：query required、limit 可选（additionalProperties=false）", () => {
    const schema = githubTools.find((tool) => tool.id === "github.search_repositories")!.inputSchema as unknown as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.properties?.query?.type).toBe("string");
    expect(schema.properties?.limit?.type).toBe("integer");
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
  });

  test("list_commits outputSchema：latest_commit_at 为 string|null 联合", () => {
    const output = githubTools.find((tool) => tool.id === "github.list_commits")!.outputSchema as unknown as {
      properties?: Record<string, unknown>;
    };
    const latest = output.properties?.latest_commit_at as { anyOf?: unknown[] };
    expect(latest?.anyOf).toHaveLength(2);
  });
});

describe("ToolCatalog — 三方共享薄接口（compiler / catalog / runtime）", () => {
  test("ToolRegistry 满足 ToolCatalog（get / all）", () => {
    const catalog: ToolCatalog = new ToolRegistry(githubTools);
    expect(catalog.get("github.search_repositories")).toBeDefined();
    expect(catalog.get("nope")).toBeUndefined();
    expect(catalog.all().map((tool) => tool.id)).toHaveLength(6);
  });

  test("泛型注册保留 RegisteredTool（execute 静态可用）", () => {
    const registry = new ToolRegistry(createMockGithubTools());
    const tool = registry.get("github.search_repositories");
    expect(typeof tool?.execute).toBe("function");
  });
});

describe("defineTool — 带 execute 的 RegisteredTool 可被 registry 存储", () => {
  test("存储后能取回完整定义并执行", async () => {
    const runtimeTool = defineTool({
      id: "demo.echo",
      label: "Echo",
      inputSchema: Type.Object({ text: Type.String() }),
      outputSchema: Type.String(),
      execute: async (input: unknown) => String((input as { text?: unknown }).text ?? ""),
    });
    const registry = new ToolRegistry([runtimeTool]);
    const stored = registry.get("demo.echo")!;
    expect(stored).toMatchObject({ id: "demo.echo", label: "Echo" });
    expect(typeof stored.execute).toBe("function");
    expect(await stored.execute!({ text: "hi" })).toBe("hi");
  });
});

describe("ToolIdResolver — canonical / host alias 无感解析", () => {
  test("resolveId：canonical 与 host alias 都解析到 canonical id，未知返回 undefined", () => {
    const registry = new ToolRegistry(githubTools);
    expect(registry.resolveId("github.get_repository")).toBe("github.get_repository");
    expect(registry.resolveId("github_get_repository")).toBe("github.get_repository");
    expect(registry.resolveId("nope")).toBeUndefined();
  });

  test("get() 透明接受 alias，返回 canonical 工具", () => {
    const registry = new ToolRegistry(githubTools);
    expect(registry.get("github_get_repository")?.id).toBe("github.get_repository");
    expect(registry.has("github_get_repository")).toBe(true);
  });

  test("hostName：canonical → host alias（与注册时生成一致）；无点号工具名映射为自身", () => {
    const registry = new ToolRegistry(githubTools);
    expect(registry.hostName("github.get_repository")).toBe("github_get_repository");
    expect(toolIdAlias("github.search_repositories")).toBe("github_search_repositories");
    expect(toolIdAlias("submit_answer")).toBe("submit_answer");
  });

  test("无点号的工具名不重复注册（alias === id，只占一个名字槽位）", () => {
    const registry = new ToolRegistry();
    registry.register({ id: "plain_tool", label: "P", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    expect(registry.ids()).toEqual(["plain_tool"]);
    expect(registry.resolveId("plain_tool")).toBe("plain_tool");
  });
});

describe("ToolRegistry — alias collision fail fast", () => {
  const spec = (id: string) => ({ id, label: id, inputSchema: Type.Object({}), outputSchema: Type.Object({}) });

  test("foo.bar_baz 与 foo_bar.baz flatten 冲突 → 注册时抛错，前一个保持可用", () => {
    const registry = new ToolRegistry();
    registry.register(spec("foo.bar_baz"));
    expect(() => registry.register(spec("foo_bar.baz"))).toThrow(/注册冲突/);
    expect(registry.ids()).toEqual(["foo.bar_baz"]);
    expect(registry.resolveId("foo_bar_baz")).toBe("foo.bar_baz");
  });

  test("canonical id 与既有工具 alias 冲突也 fail fast", () => {
    const registry = new ToolRegistry();
    registry.register(spec("foo.bar"));
    expect(() => registry.register(spec("foo_bar"))).toThrow(/注册冲突/);
  });

  test("构造器遇到冲突整体失败（不半注册）", () => {
    expect(() => new ToolRegistry([spec("a.b_c"), spec("a_b.c")])).toThrow(/注册冲突/);
  });
});

describe("suggestIds — 确定性近似匹配（Did you mean）", () => {
  test("拼写错误 → 建议里同时含 host alias 与 canonical", () => {
    const registry = new ToolRegistry(githubTools);
    const suggestions = registry.suggestIds("github_get_repositry");
    expect(suggestions[0]).toEqual({ alias: "github_get_repository", canonical: "github.get_repository" });
  });

  test("相似度太低 → 不硬推荐", () => {
    const registry = new ToolRegistry(githubTools);
    expect(registry.suggestIds("totally_unrelated")).toEqual([]);
    expect(registry.suggestIds("agent")).toEqual([]);
  });

  test("默认最多 2 个，距离升序 + 字典序稳定排序", () => {
    const registry = new ToolRegistry(githubTools);
    const suggestions = registry.suggestIds("github_get_language");
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions.length).toBeLessThanOrEqual(2);
    // 距离相等时按 canonical id 字典序稳定
    const ties = registry.suggestIds("github_get_repository");
    expect(ties.length).toBeLessThanOrEqual(2);
  });

  test("editDistance 基础正确性", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("repositry", "repository")).toBe(1);
    expect(editDistance("github_get_repositry", "github_get_repository")).toBe(1);
  });
});

describe("SchemaView 归一 — catalog 渲染与参数 kind（REQ-5）", () => {
  test("github.list_commits 输出渲染 latest_commit_at: string | null（不再 unknown）", () => {
    const catalog = renderExecutionToolCatalog(new ToolRegistry(githubTools));
    expect(catalog).toContain("latest_commit_at: string | null");
    expect(catalog).not.toContain("latest_commit_at: unknown");
  });

  test("非原始类型参数 kind=unknown：编译器跳过字面量类型检查，不误报也不当 string", () => {
    const tool = defineTool({
      id: "demo.union",
      label: "Union",
      inputSchema: Type.Object(
        { value: Type.Union([Type.String(), Type.Null()]), tags: Type.Array(Type.String()) },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object({}, { additionalProperties: false }),
    });
    const params = toolParams(tool);
    expect(params.find((p) => p.key === "value")?.kind).toBe("unknown");
    expect(params.find((p) => p.key === "tags")?.kind).toBe("unknown");
    // union 参数值渲染为 "string | null"；unknown 参数写任意字面量均不报 config_type_mismatch
    const { graph } = compileExecutionDsl('x = demo.union(value="a", tags=123)\nreturn x', { tools: new ToolRegistry([tool]) });
    expect(graph.nodes).toHaveLength(2);
  });
});
