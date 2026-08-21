import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import {
  HarnessToolView,
  createHarnessJitDescribeTool,
  createHarnessJitExecuteProgramTool,
  harnessToolAsRegisteredTool,
  installLegacyDslJit,
  jsonSchemaFromTypebox,
  registeredToolAsHarnessTool,
  type HarnessAdapter,
  type HarnessDisposer,
  type HarnessToolCatalog,
  type HarnessToolContract,
  type HarnessToolDefinition,
  type HarnessToolExecution,
  typeboxFromJsonSchema,
} from "../src/adapter/index.js";
import { defineTool, type RegisteredTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";

interface FakeContext {
  scope: string;
}

class FakeHarness implements HarnessAdapter<FakeContext> {
  private readonly tools = new Map<string, HarnessToolDefinition<FakeContext>>();
  readonly calls: { scope: string; name: string; args: unknown }[] = [];
  readonly disposals: string[] = [];
  failOnRegister: string | undefined;
  readonly failDisposeOnce = new Set<string>();

  registerTool(definition: HarnessToolDefinition<FakeContext>): HarnessDisposer {
    if (definition.name === this.failOnRegister) {
      throw new Error(`register-failed:${definition.name}`);
    }
    if (this.tools.has(definition.name)) throw new Error(`duplicate:${definition.name}`);
    this.tools.set(definition.name, definition);
    return () => {
      if (this.failDisposeOnce.delete(definition.name)) {
        throw new Error(`dispose-failed:${definition.name}`);
      }
      if (this.tools.get(definition.name) === definition) {
        this.disposals.push(definition.name);
        this.tools.delete(definition.name);
      }
    };
  }

  catalog(context: FakeContext): HarnessToolCatalog {
    return {
      getTool: (name) => this.visible(name, context),
      listTools: () => this.visibleTools(context),
    };
  }

  execution(context: FakeContext): HarnessToolExecution {
    const catalog = this.catalog(context);
    return {
      ...catalog,
      callTool: async (name, args) => {
        const tool = this.visible(name, context);
        if (tool === undefined) throw new Error(`UNKNOWN_TOOL:${name}`);
        this.calls.push({ scope: context.scope, name, args });
        return tool.execute(args, context);
      },
    };
  }

  addTool(
    definition: Omit<HarnessToolDefinition<FakeContext>, "renderText"> & {
      scopes?: readonly string[];
    },
  ): HarnessDisposer {
    const scopes = definition.scopes;
    const tool: HarnessToolDefinition<FakeContext> & { scopes?: readonly string[] } = {
      ...definition,
      renderText: (_args, value) => JSON.stringify(value) as string,
      ...(scopes === undefined ? {} : { scopes }),
    };
    if (this.tools.has(tool.name)) throw new Error(`duplicate:${tool.name}`);
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  private visible(
    name: string,
    context: FakeContext,
  ): (HarnessToolDefinition<FakeContext> & { scopes?: readonly string[] }) | undefined {
    const tool = this.tools.get(name) as
      | (HarnessToolDefinition<FakeContext> & { scopes?: readonly string[] })
      | undefined;
    if (tool === undefined) return undefined;
    return tool.scopes === undefined || tool.scopes.includes(context.scope) ? tool : undefined;
  }

  private visibleTools(context: FakeContext): readonly HarnessToolContract[] {
    return [...this.tools.keys()]
      .map((name) => this.visible(name, context))
      .filter((tool): tool is HarnessToolDefinition<FakeContext> => tool !== undefined);
  }
}

function addCalculator(harness: FakeHarness, name = "demo_calc"): void {
  harness.addTool({
    name,
    description: "演示工具：计算两数之和。",
    inputSchema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { sum: { type: "integer" } },
      required: ["sum"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const { a, b } = args as { a: number; b: number };
      return { sum: a + b };
    },
  });
}

describe("host-neutral schema and tool adapters", () => {
  test("TypeBox 与 neutral JSON Schema 保持当前 object/optional/enum/union 语义", () => {
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

    const imported = typeboxFromJsonSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(JSON.stringify(imported)).toContain('"a"');
    expect(JSON.stringify(typeboxFromJsonSchema({ patternProperties: {} }))).toBe("{}");
  });

  test("RegisteredTool 转 host alias/DSL signature，并可反向绑定 authoritative caller", async () => {
    const calls: unknown[] = [];
    const tool: RegisteredTool = {
      id: "demo.ping",
      label: "Ping",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ pong: Type.String() }),
      execute: async (args) => ({ pong: (args as { value: string }).value }),
    };
    const adapted = registeredToolAsHarnessTool<FakeContext>(tool);
    expect(adapted.name).toBe("demo_ping");
    expect(adapted.description).toContain("DSL: demo.ping(value: str) -> {pong: str}");
    expect(adapted.renderText({}, { pong: "x" })).toBe('{"pong":"x"}');

    const rebound = harnessToolAsRegisteredTool(adapted, async (name, args) => {
      calls.push({ name, args });
      return { pong: "host" };
    });
    await expect(rebound.execute({ value: "x" })).resolves.toEqual({ pong: "host" });
    expect(calls).toEqual([{ name: "demo_ping", args: { value: "x" } }]);
  });
});

describe("HarnessToolView", () => {
  test("目录保持 live，并保留 alias、suggestion、allow/exclude/base/meta 规则", () => {
    const harness = new FakeHarness();
    const context = { scope: "alpha" };
    const execution = harness.execution(context);
    const view = new HarnessToolView({
      catalog: execution,
      caller: (name, args) => execution.callTool(name, args),
    });

    expect(view.all()).toEqual([]);
    addCalculator(harness, "service_get_detail");
    expect(view.resolveId("service.get_detail")).toBe("service_get_detail");
    expect(view.suggestIds("service_get_detai")).toEqual([
      { alias: "service_get_detail", canonical: "service_get_detail" },
    ]);

    harness.addTool({
      name: "alpha_only",
      description: "Only visible in alpha.",
      inputSchema: {},
      outputSchema: {},
      scopes: ["alpha"],
      execute: async () => ({ ok: true }),
    });
    expect(harness.catalog(context).getTool("alpha_only")?.name).toBe("alpha_only");
    expect(harness.catalog({ scope: "beta" }).getTool("alpha_only")).toBeUndefined();

    harness.addTool({
      name: "jit_execute_program",
      description: "recursive",
      inputSchema: {},
      outputSchema: {},
      execute: async () => null,
    });
    harness.addTool({
      name: "custom_meta",
      description: "meta",
      inputSchema: {},
      outputSchema: {},
      execute: async () => null,
    });
    const filtered = new HarnessToolView({
      catalog: execution,
      caller: (name, args) => execution.callTool(name, args),
      allow: ["service_get_detail", "jit_execute_program", "custom_meta"],
      exclude: ["service_get_detail"],
      metaNames: ["custom_meta"],
    });
    expect(filtered.all()).toEqual([]);

    const closed = new HarnessToolView({
      catalog: execution,
      caller: (name, args) => execution.callTool(name, args),
      allow: [],
    });
    expect(closed.all()).toEqual([]);

    const baseTool = defineTool({
      id: "service.get_detail",
      label: "Base",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => ({}),
    });
    const base = new ToolRegistry<RegisteredTool>([baseTool]);
    const shadowed = new HarnessToolView({
      catalog: execution,
      caller: (name, args) => execution.callTool(name, args),
      base,
    });
    expect(shadowed.get("service_get_detail")).toBeUndefined();
  });
});

describe("generic legacy DSL JIT", () => {
  test("apply 后新增的 scoped host tool 可 describe 并经 authoritative dispatch 执行", async () => {
    const harness = new FakeHarness();
    const registry = new ToolRegistry<RegisteredTool>();
    const describeTool = createHarnessJitDescribeTool(registry, harness);
    const executeTool = createHarnessJitExecuteProgramTool(registry, harness);
    addCalculator(harness);

    const context = { scope: "alpha" };
    const contracts = String(
      await describeTool.execute({ tool_names: ["demo_calc"] }, context),
    );
    expect(contracts).toContain("# Requested Tool Contracts");
    expect(contracts).toContain("demo_calc(a: int, b: int) -> {sum: int}");

    const result = await executeTool.execute(
      { source: ["x = demo_calc(a=2, b=3)", "return x"].join("\n") },
      context,
    );
    expect(JSON.parse(String(result))).toEqual({ sum: 5 });
    expect(harness.calls).toEqual([
      { scope: "alpha", name: "demo_calc", args: { a: 2, b: 3 } },
    ]);
  });

  test("严格输入、compile diagnostics 与 first-call reference 保持 legacy 文案", async () => {
    const harness = new FakeHarness();
    const registry = new ToolRegistry<RegisteredTool>();
    const describeTool = createHarnessJitDescribeTool(registry, harness, {
      describeDslReference: "first-call",
    });
    addCalculator(harness);
    const context = { scope: "alpha" };

    await expect(describeTool.execute({ tool_names: [] }, context)).rejects.toThrow(
      "tool_names 必须是 1..20 个工具名的数组（严格语义：不允许 partial success）",
    );
    const first = String(
      await describeTool.execute({ tool_names: ["demo_calc"] }, context),
    );
    const second = String(
      await describeTool.execute({ tool_names: ["demo_calc"] }, context),
    );
    expect(first).toContain("## Agent Execution DSL 参考（核心语言语义）");
    expect(second.startsWith("# Requested Tool Contracts")).toBe(true);

    const diagnostics: string[] = [];
    const executeTool = createHarnessJitExecuteProgramTool(registry, harness, {
      onCompileFailure: (items) => diagnostics.push(...items.map((item) => item.code)),
    });
    await expect(
      executeTool.execute(
        { source: ["x = demo_cal(a=1, b=2)", "return x"].join("\n") },
        context,
      ),
    ).rejects.toThrow(/demo_calc/);
    expect(diagnostics).toContain("unknown_tool");
    await expect(executeTool.execute({ source: "  " }, context)).rejects.toThrow(
      "source 为空。请把完整 DSL 程序放在 source 参数里。",
    );
  });

  test("installLegacyDslJit 注册 provider 与两个 transport，并返回幂等 disposer", async () => {
    const harness = new FakeHarness();
    const provider: RegisteredTool = {
      id: "demo.provider",
      label: "Provider",
      inputSchema: Type.Object({ value: Type.String() }),
      outputSchema: Type.Object({ value: Type.String() }),
      execute: async (args) => args,
    };
    const registry = new ToolRegistry<RegisteredTool>([provider]);
    const dispose = installLegacyDslJit(harness, registry);
    expect(harness.has("demo_provider")).toBe(true);
    expect(harness.catalog({ scope: "alpha" }).getTool("demo_provider")?.description).toContain(
      "DSL: demo.provider",
    );
    expect(harness.has("jit_describe_tools")).toBe(true);
    expect(harness.has("jit_execute_program")).toBe(true);
    await expect(
      harness.execution({ scope: "alpha" }).callTool("demo_provider", { value: "x" }),
    ).resolves.toEqual({ value: "x" });
    dispose();
    dispose();
    expect(harness.has("demo_provider")).toBe(false);
    expect(harness.has("jit_describe_tools")).toBe(false);
    expect(harness.has("jit_execute_program")).toBe(false);
    expect(harness.disposals).toEqual([
      "jit_execute_program",
      "jit_describe_tools",
      "demo_provider",
    ]);

    const executeOnlyDispose = installLegacyDslJit(harness, registry, {
      describeTools: false,
      dslSignature: "none",
    });
    expect(harness.catalog({ scope: "alpha" }).getTool("demo_provider")?.description).toBe(
      "Provider",
    );
    expect(harness.has("jit_describe_tools")).toBe(false);
    expect(harness.has("jit_execute_program")).toBe(true);
    executeOnlyDispose();
  });

  test("组合 disposer 会继续清理其余工具，并可重试暂时失败的 disposer", () => {
    const harness = new FakeHarness();
    const provider: RegisteredTool = {
      id: "demo.provider",
      label: "Provider",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => ({}),
    };
    const registry = new ToolRegistry<RegisteredTool>([provider]);
    const dispose = installLegacyDslJit(harness, registry);
    harness.failDisposeOnce.add("jit_execute_program");

    expect(dispose).toThrow("dispose-failed:jit_execute_program");
    expect(harness.has("jit_execute_program")).toBe(true);
    expect(harness.has("jit_describe_tools")).toBe(false);
    expect(harness.has("demo_provider")).toBe(false);

    expect(dispose).not.toThrow();
    expect(harness.has("jit_execute_program")).toBe(false);
    expect(dispose).not.toThrow();
  });

  test("installLegacyDslJit 注册中途失败时逆序回滚", () => {
    const harness = new FakeHarness();
    harness.failOnRegister = "jit_execute_program";
    const provider: RegisteredTool = {
      id: "demo.provider",
      label: "Provider",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => ({}),
    };
    const registry = new ToolRegistry<RegisteredTool>([provider]);

    expect(() => installLegacyDslJit(harness, registry)).toThrow(
      "register-failed:jit_execute_program",
    );
    expect(harness.has("demo_provider")).toBe(false);
    expect(harness.has("jit_describe_tools")).toBe(false);
    expect(harness.has("jit_execute_program")).toBe(false);
    expect(harness.disposals).toEqual(["jit_describe_tools", "demo_provider"]);
  });
});
