import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { githubTools } from "../src/compiler/registry.js";
import { defineTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";

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

  test("register 同名 id 覆盖", () => {
    const registry = new ToolRegistry();
    registry.register({ id: "demo.a", label: "A1", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    registry.register({ id: "demo.a", label: "A2", inputSchema: Type.Object({}), outputSchema: Type.Object({}) });
    expect(registry.get("demo.a")?.label).toBe("A2");
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
      expect(tool.execute).toBeUndefined();
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

describe("defineTool — 带 execute 的 RuntimeTool 可被 registry 存储", () => {
  test("存储后能取回完整定义并执行", async () => {
    const runtimeTool = defineTool({
      id: "demo.echo",
      label: "Echo",
      inputSchema: Type.Object({ text: Type.String() }),
      outputSchema: Type.String(),
      execute: async (input) => String((input as { text?: unknown }).text ?? ""),
    });
    const registry = new ToolRegistry([runtimeTool]);
    const stored = registry.get("demo.echo")!;
    expect(stored).toMatchObject({ id: "demo.echo", label: "Echo" });
    expect(typeof stored.execute).toBe("function");
    expect(await stored.execute!({ text: "hi" })).toBe("hi");
  });
});
