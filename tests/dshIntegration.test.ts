import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { defineTool, type RegisteredTool } from "../src/tools/definition.js";
import { ToolRegistry, toolIdAlias } from "../src/tools/registry.js";
import { createMockGithubTools } from "../src/tools/providers/github/mock.js";
import { createMockDomainTools } from "../src/tools/providers/domain/mock.js";
import { adaptRegisteredTool, dshToolAsRegisteredTool } from "../src/integrations/dsh/toolAdapter.js";
import { createDshJitDescribeTool, createDshJitExecuteProgramTool } from "../src/integrations/dsh/jitTools.js";
import { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "../src/integrations/dsh/schema.js";
import { dslSignatureOf, renderDslSignature } from "../src/tools/dslSignature.js";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";

/** 与 piIntegration.test.ts 同构的注册表（github + domain mock）。 */
function makeRegistry(): ToolRegistry<RegisteredTool> {
  return new ToolRegistry<RegisteredTool>([...createMockGithubTools(), ...createMockDomainTools()]);
}

/** 空宿主工具 runtime stub：无宿主工具可发现（行为等同旧的"未配置 hostTools"）。 */
function makeEmptyHostTools(): ToolRuntime {
  return {
    get: () => undefined,
    schemas: () => [],
    execute: async () => {
      throw new Error("不应执行宿主工具");
    },
  } as unknown as ToolRuntime;
}

describe("adaptRegisteredTool → DSH ToolDefinition", () => {
  test("name 用 host alias（点号 → 下划线）", () => {
    const registry = makeRegistry();
    const search = registry.get("github.search_repositories")!;
    const adapted = adaptRegisteredTool(search);
    expect(adapted.name).toBe(toolIdAlias(search.id));
    expect(adapted.name).toBe("github_search_repositories");
  });

  test("description 注入实验验证的函数式 DSL 签名（缺省 inline）", () => {
    const tool = defineTool({
      id: "demo.no_description",
      label: "No Description Tool",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ metric_x: Type.Integer({ description: "forks" }) }),
    });
    const adapted = adaptRegisteredTool({ ...tool, execute: async () => ({ ok: true }) });
    expect(adapted.description.startsWith("No Description Tool\nDSL:")).toBe(true);
    expect(adapted.description).toContain("demo.no_description() -> {metric_x: int[forks]}");
  });

  test("dslSignature:'none' 保留纯描述（缺省回退 label）", () => {
    const tool = defineTool({
      id: "demo.bare",
      label: "Bare Tool",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
    });
    const adapted = adaptRegisteredTool({ ...tool, execute: async () => ({}) }, { dslSignature: "none" });
    expect(adapted.description).toBe("Bare Tool");
  });

  test("parameters / output.schema 是 DSH 支持的 JSON Schema 子集", () => {
    const registry = makeRegistry();
    const repo = registry.get("github.get_repository")!;
    const adapted = adaptRegisteredTool(repo);
    expect(adapted.parameters).toEqual({
      type: "object",
      properties: { full_name: { type: "string" } },
      required: ["full_name"],
      additionalProperties: false,
    });
    expect(adapted.output.schema).toMatchObject({
      type: "object",
      properties: { full_name: { type: "string" }, stars: { type: "integer" } },
      required: ["full_name", "stars", "forks", "archived", "language"],
    });
  });

  test("execute 透传 RegisteredTool.execute（行为零改动）", async () => {
    const calls: unknown[] = [];
    const tool: RegisteredTool = {
      id: "demo.ping",
      label: "Ping",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async (input) => {
        calls.push(input);
        return { pong: true };
      },
    };
    const adapted = adaptRegisteredTool(tool);
    const value = await adapted.execute({}, undefined as never);
    expect(value).toEqual({ pong: true });
    expect(calls).toEqual([{}]);
  });
});

describe("dshToolAsRegisteredTool → agent-jit RegisteredTool（宿主工具反向导入）", () => {
  test("id 用 DSH 原名，schema 反向映射为 typebox，execute 走调用闭包", async () => {
    const definition = {
      name: "run_bash",
      description: "Run bash.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      } as unknown as Record<string, unknown>,
      output: { schema: { type: "string" as const }, render: () => [{ type: "text" as const, text: "" }] },
      execute: async () => "out",
    };
    const calls: string[] = [];
    const registered = dshToolAsRegisteredTool(definition, async (name, args) => {
      calls.push(name);
      return `nested:${JSON.stringify(args)}`;
    });
    expect(registered.id).toBe("run_bash");
    // inputSchema 已是 typebox：编译器/运行时 Value.Check 可校验
    expect(JSON.stringify(registered.inputSchema)).toContain('"command"');
    const value = await registered.execute({ command: "ls" });
    expect(value).toBe('nested:{"command":"ls"}');
    expect(calls).toEqual(["run_bash"]);
  });
});

describe("schema 转换层", () => {
  test("jsonSchemaFromTypebox：object/optional/enum/union 收敛为 DSH 子集", () => {
    const schema = Type.Object({
      a: Type.String(),
      b: Type.Optional(Type.Integer()),
      c: Type.Enum(["x", "y"]),
      d: Type.Union([Type.String(), Type.Null()]),
    });
    expect(jsonSchemaFromTypebox(schema)).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "integer" },
        c: { type: "string", enum: ["x", "y"] },
        d: { oneOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["a", "c", "d"],
    });
  });

  test("typeboxFromJsonSchema：required → 必填，缺省 → Optional；子集外结构回退 Any", () => {
    const schema = typeboxFromJsonSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(JSON.stringify(schema)).toContain('"a"');
    const anySchema = typeboxFromJsonSchema({ patternProperties: { "^.*$": { type: "number" } } });
    expect(JSON.stringify(anySchema)).toBe("{}");
  });

  test("typeboxFromJsonSchema：DSH 形态 enum/const 反向导入为 Type.Enum（值不丢失）", () => {
    const enumSchema = typeboxFromJsonSchema({ type: "string", enum: ["workspace-write", "danger-full-access"] });
    expect(JSON.stringify(enumSchema)).toContain('"enum"');
    const constSchema = typeboxFromJsonSchema({ type: "string", const: "x" });
    expect(JSON.stringify(constSchema)).toContain('"enum"');
    // 经签名层渲染出字面量联合（修复前 type 分支先行吞掉 enum → 渲染 str/unknown）
    const tool = defineTool({
      id: "edit",
      label: "Edit",
      inputSchema: Type.Object({ sandbox_permissions: Type.Optional(enumSchema) }, { additionalProperties: false }),
      outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
    });
    expect(renderDslSignature(dslSignatureOf(tool))).toBe(
      'edit(sandbox_permissions?: "workspace-write" | "danger-full-access") -> {ok: bool}',
    );
  });
});

describe("DSH JIT 元工具", () => {
  test("createDshJitDescribeTool：确定性契约渲染，未知工具整体失败", async () => {
    const registry = makeRegistry();
    const tool = createDshJitDescribeTool(registry, makeEmptyHostTools());
    expect(tool.name).toBe("jit_describe_tools");
    const text = await tool.execute({ tool_names: ["github.get_repository"] }, undefined as never);
    expect(text).toContain("github.get_repository");
    await expect(
      tool.execute({ tool_names: ["no.such_tool"] }, undefined as never),
    ).rejects.toThrow();
  });

  test("createDshJitExecuteProgramTool：source → 编译 → 执行同一 registry", async () => {
    const registry = makeRegistry();
    const calls: string[] = [];
    const tools = {
      get: () => undefined,
      schemas: () => [],
      execute: async (input: { name: string }) => {
        calls.push(input.name);
        throw new Error("不应在无宿主工具的程序里被调用");
      },
    };
    const tool = createDshJitExecuteProgramTool(registry, tools as unknown as ToolRuntime);
    const source = [
      'repos = github.search_repositories(query="dsl", limit=3)',
      "return repos",
    ].join("\n");
    const result = await tool.execute({ source }, undefined as never);
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toBeInstanceOf(Array);
    expect(calls).toEqual([]);
  });
});
