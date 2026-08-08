import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { githubTools } from "../src/tools/providers/github/contracts.js";
import { createMockGithubTools } from "../src/tools/providers/github/mock.js";
import { defineTool } from "../src/tools/definition.js";
import { ToolRegistry, type ToolCatalog } from "../src/tools/registry.js";
import { renderExecutionToolCatalog } from "../src/compiler/catalog.js";
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
    const { graph } = compileExecutionDsl('x = demo.union(value="a", tags=123)', { tools: new ToolRegistry([tool]) });
    expect(graph.nodes).toHaveLength(1);
  });
});
