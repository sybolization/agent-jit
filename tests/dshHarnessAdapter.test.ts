import { CallId } from "@deepseek-ai/dsh-llm";
import type {
  ToolDefinition,
  ToolExecutionInput,
  ToolExecutionToken,
  ToolRunContext,
  ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, test, vi } from "vitest";
import type { HarnessToolDefinition } from "../src/adapter/index.js";
import * as dsh from "../src/integrations/dsh/index.js";

function hostTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async () => ({ value: name }),
  };
}

function executionContext(agent: object = {}): ToolRunContext {
  return {
    callId: CallId("adapter:parent"),
    rootCallId: CallId("adapter:root"),
    name: "outer_transport",
    arguments: {},
    agent,
    parent: undefined,
    signal: new AbortController().signal,
    token: Symbol("adapter-parent") as ToolExecutionToken,
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext;
}

describe("agent-jit/dsh harness adapter", () => {
  test("public DSH entry keeps the plugin API and exports createDshHarnessAdapter", () => {
    expect(Object.keys(dsh).sort()).toEqual([
      "DEFAULT_REMINDER_EXCLUDE",
      "HostToolView",
      "LIST_ROUTING_REMINDER",
      "RoutingReminderGate",
      "adaptRegisteredTool",
      "apply",
      "buildListReminder",
      "containsList",
      "createDshHarnessAdapter",
      "createDshJitDescribeTool",
      "createDshJitExecuteProgramTool",
      "createDshJitTools",
      "dshToolAsRegisteredTool",
      "inject",
      "installRoutingReminder",
      "jsonSchemaFromTypebox",
      "name",
      "typeboxFromJsonSchema",
      "unreachableHostCaller",
    ]);
    expect(dsh.name).toBe("agent-jit-dsl");
    expect(dsh.inject).toEqual(["tools", "systemPrompt"]);
    expect(dsh.apply).toBeTypeOf("function");
    expect(dsh.createDshJitTools).toBeTypeOf("function");
    expect(dsh.createDshHarnessAdapter).toBeTypeOf("function");
  });

  test("registerTool maps schemas, execution, text rendering, and returns the host disposer", async () => {
    let registered: ToolDefinition | undefined;
    const hostDisposer = vi.fn();
    const tools = {
      register: vi.fn((definition: ToolDefinition) => {
        registered = definition;
        return hostDisposer;
      }),
      get: () => undefined,
      schemas: () => [],
      execute: vi.fn(),
    } as unknown as ToolRuntime;
    const adapter = dsh.createDshHarnessAdapter(tools);
    const context = executionContext();
    const execute = vi.fn(async (args: unknown, actualContext: ToolRunContext) => ({
      args,
      sameContext: actualContext === context,
    }));
    const definition: HarnessToolDefinition<ToolRunContext> = {
      name: "portable_lookup",
      description: "Portable lookup.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          args: { type: "object" },
          sameContext: { type: "boolean" },
        },
        required: ["args", "sameContext"],
      },
      execute,
      renderText: (args, value) =>
        `id=${String((args as { id: string }).id)} value=${JSON.stringify(value)}`,
    };

    const dispose = adapter.registerTool(definition);

    expect(dispose).toBe(hostDisposer);
    expect(registered).toMatchObject({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
      output: { schema: definition.outputSchema },
    });
    await expect(registered!.execute({ id: "42" }, context)).resolves.toEqual({
      args: { id: "42" },
      sameContext: true,
    });
    expect(execute).toHaveBeenCalledWith({ id: "42" }, context);
    expect(registered!.output.render({ id: "42" }, { args: { id: "42" }, sameContext: true })).toEqual([
      {
        type: "text",
        text: 'id=42 value={"args":{"id":"42"},"sameContext":true}',
      },
    ]);

    dispose();
    expect(hostDisposer).toHaveBeenCalledOnce();
  });

  test("catalog is synchronous, scope-aware, and live after the view is created", () => {
    const agentA = {};
    const agentB = {};
    const visibleForA = [hostTool("alpha")];
    const seenGetScopes: unknown[] = [];
    const seenListScopes: unknown[] = [];
    const tools = {
      register: vi.fn(),
      get: (name: string, scope: unknown) => {
        seenGetScopes.push(scope);
        return scope === agentA ? visibleForA.find((tool) => tool.name === name) : undefined;
      },
      schemas: (scope: unknown) => {
        seenListScopes.push(scope);
        return scope === agentA
          ? visibleForA.map(({ name, description, parameters }) => ({ name, description, parameters }))
          : [];
      },
      execute: vi.fn(),
    } as unknown as ToolRuntime;
    const adapter = dsh.createDshHarnessAdapter(tools);
    const catalogA = adapter.catalog(executionContext(agentA));
    const catalogB = adapter.catalog(executionContext(agentB));

    const first = catalogA.listTools();
    expect(Array.isArray(first)).toBe(true);
    expect(first).toEqual([
      {
        name: "alpha",
        description: "alpha description",
        inputSchema: hostTool("alpha").parameters,
        outputSchema: hostTool("alpha").output.schema,
      },
    ]);
    expect(catalogA.getTool("alpha")).toEqual(first[0]);
    expect(catalogB.listTools()).toEqual([]);

    // The catalog is a live view, not a snapshot captured by adapter.catalog().
    visibleForA.push(hostTool("late_tool"));
    expect(catalogA.listTools().map((tool) => tool.name)).toEqual(["alpha", "late_tool"]);
    expect(catalogA.getTool("late_tool")?.name).toBe("late_tool");
    expect(seenGetScopes.every((scope) => scope === agentA || scope === agentB)).toBe(true);
    expect(seenListScopes).toContain(agentA);
    expect(seenListScopes).toContain(agentB);
  });

  test("nested dispatch propagates DSH execution fields and rejects host errors", async () => {
    const calls: ToolExecutionInput[] = [];
    const tools = {
      register: vi.fn(),
      get: () => undefined,
      schemas: () => [],
      execute: vi.fn(async (input: ToolExecutionInput) => {
        calls.push(input);
        return input.name === "failing_tool"
          ? {
              isError: true as const,
              error: { message: "host policy denied the call" },
              content: [{ type: "text" as const, text: "Error: host policy denied the call" }],
            }
          : {
              isError: false as const,
              value: { ok: true },
              content: [{ type: "text" as const, text: '{"ok":true}' }],
            };
      }),
    } as unknown as ToolRuntime;
    const adapter = dsh.createDshHarnessAdapter(tools);
    const agent = {};
    const context = executionContext(agent);
    const execution = adapter.execution(context);

    await expect(execution.callTool("ok_tool", { id: 1 })).resolves.toEqual({ ok: true });
    await expect(execution.callTool("failing_tool", { id: 2 })).rejects.toThrow(
      "host policy denied the call",
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: "ok_tool",
      arguments: { id: 1 },
      rootCallId: context.rootCallId,
      agent,
      parent: context.token,
      signal: context.signal,
    });
    expect(calls[1]).toMatchObject({
      name: "failing_tool",
      arguments: { id: 2 },
      rootCallId: context.rootCallId,
      agent,
      parent: context.token,
      signal: context.signal,
    });
    expect(calls[0]!.callId).toBe(CallId("adapter:parent:dsl:1"));
    expect(calls[1]!.callId).toBe(CallId("adapter:parent:dsl:2"));
  });
});
