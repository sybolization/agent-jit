import { Context } from "@deepseek-ai/cordis";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRegistry, { type ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { describe, expect, test } from "vitest";
import {
  apply,
  buildListReminder,
  containsList,
  DEFAULT_REMINDER_EXCLUDE,
  inject,
  name,
  RoutingReminderGate,
} from "../src/integrations/dsh/index.js";

/**
 * routingReminder（soft hook）测试：
 * 1. 纯函数：containsList 的列表判定（顶层数组 / 对象含数组字段 / 空 / 标量 / 阈值）；
 * 2. buildListReminder 的消息形态（user 角色、plugin 来源、引用 jit_* 元工具）；
 * 3. 集成：返回列表的工具在 tools/post-execute 上被附加 additionalContexts；
 *    标量结果不附加；默认开启、显式 none 关闭；
 * 4. 排除名单：read/read_image（内容读取）默认不触发；
 * 5. 嵌套执行（jit_execute_program 内部经 hostDiscovery 分发）不注入。
 */

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Timer);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRegistry);
  await ctx.plugin({ name, inject, apply }, { ...config });
  return ctx;
}

/** 经 ctx.tools.execute 完整执行一次，返回完整 result（含 additionalContexts）。 */
async function callFull(
  ctx: Context,
  toolName: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId(`routing-reminder:${toolName}`),
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  });
}

/** 注册一个返回列表的工具（模拟 glob / grep 形态）。 */
function registerListTool(ctx: Context, items: string[] = ["a", "b", "c"]): string {
  ctx.tools.register({
    name: "demo_list",
    description: "演示：返回列表。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } } },
        required: ["items"],
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async () => ({ items }),
  });
  return "demo_list";
}

/** 注册一个返回标量的工具。 */
function registerScalarTool(ctx: Context): string {
  ctx.tools.register({
    name: "demo_scalar",
    description: "演示：返回标量。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "object", properties: { sum: { type: "integer" } }, required: ["sum"] },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async () => ({ sum: 1 }),
  });
  return "demo_scalar";
}

describe("containsList（列表判定纯函数）", () => {
  test("顶层数组 / 对象含数组字段 / 阈值", () => {
    expect(containsList(["a", "b"], 2)).toBe(true);
    expect(containsList({ items: ["a", "b"] }, 2)).toBe(true);
    expect(containsList({ items: ["a"] }, 2)).toBe(false);
    expect(containsList([], 1)).toBe(false);
    expect(containsList("abc", 1)).toBe(false);
    expect(containsList(42, 1)).toBe(false);
    expect(containsList(null, 1)).toBe(false);
    expect(containsList({ items: ["a", "b"], nested: { more: ["x", "y"] } }, 2)).toBe(true);
  });
});

describe("buildListReminder（消息形态）", () => {
  test("user 角色 + plugin 来源 + 引用 jit_* 元工具", () => {
    const message = buildListReminder();
    expect(message.role).toBe("user");
    expect(message.source.kind).toBe("plugin");
    expect(message.source.plugin).toBe("agent-jit-dsl");
    expect(message.content[0]).toMatchObject({ type: "text" });
    expect(String((message.content[0] as { text: string }).text)).toContain("jit_execute_program");
    expect(String((message.content[0] as { text: string }).text)).toContain("jit_describe_tools");
  });
});

describe("RoutingReminderGate（once-per-turn 状态机）", () => {
  const listResult = { isError: false, value: { items: ["a", "b"] } };
  const scalarResult = { isError: false, value: { sum: 1 } };

  function gate(
    overrides: Partial<{ minListLength: number; oncePerTurn: boolean; exclude: readonly string[] }> = {},
  ) {
    return new RoutingReminderGate({
      minListLength: 2,
      oncePerTurn: true,
      exclude: DEFAULT_REMINDER_EXCLUDE,
      ...overrides,
    });
  }

  test("同一 agent 同一回合：第一个列表触发，后续列表被去重", () => {
    const g = gate();
    const agent = {};
    expect(g.shouldRemind({ agent }, listResult)).toBe(true);
    expect(g.shouldRemind({ agent }, listResult)).toBe(false);
  });

  test("不同 agent 各自独立计数", () => {
    const g = gate();
    expect(g.shouldRemind({ agent: {} }, listResult)).toBe(true);
    expect(g.shouldRemind({ agent: {} }, listResult)).toBe(true);
  });

  test("真正用户消息到达时重置；plugin 来源（提醒自身）不误触重置", () => {
    const g = gate();
    const agent = {};
    expect(g.shouldRemind({ agent }, listResult)).toBe(true);
    expect(g.shouldRemind({ agent }, listResult)).toBe(false);
    // plugin 来源的消息（如注入的提醒）不应清标记
    g.onPreStep(agent, [{ source: { kind: "plugin" } }]);
    expect(g.shouldRemind({ agent }, listResult)).toBe(false);
    // 真正的用户消息 → 重置 → 下一回合再次提醒
    g.onPreStep(agent, [{ source: { kind: "user" } }]);
    expect(g.shouldRemind({ agent }, listResult)).toBe(true);
  });

  test("标量 / 错误 / 嵌套（parent 存在）不触发，也不消耗 once-per-turn 名额", () => {
    const g = gate();
    const agent = {};
    expect(g.shouldRemind({ agent }, scalarResult)).toBe(false);
    expect(g.shouldRemind({ agent }, { isError: true })).toBe(false);
    expect(g.shouldRemind({ agent, parent: Symbol("nested") }, listResult)).toBe(false);
    // 以上都不登记，首次真正的列表仍触发
    expect(g.shouldRemind({ agent }, listResult)).toBe(true);
  });

  test("oncePerTurn:false 时不做去重", () => {
    const g = gate({ oncePerTurn: false });
    const agent = {};
    expect(g.shouldRemind({ agent }, listResult)).toBe(true);
    expect(g.shouldRemind({ agent }, listResult)).toBe(true);
  });

  test("无 agent（程序化调用）不参与去重，每次都提醒", () => {
    const g = gate();
    expect(g.shouldRemind({}, listResult)).toBe(true);
    expect(g.shouldRemind({}, listResult)).toBe(true);
  });

  test("排除名单：read / read_image 默认不触发；通配符与空名单生效", () => {
    const g = gate();
    const agent = {};
    // 默认排除 read / read_image（内容读取类，数组字段是内容细节）
    expect(g.shouldRemind({ agent, name: "read" }, listResult)).toBe(false);
    expect(g.shouldRemind({ agent, name: "read_image" }, listResult)).toBe(false);
    // glob / grep 等枚举类工具仍触发
    expect(g.shouldRemind({ agent, name: "glob" }, listResult)).toBe(true);

    // 通配符：exclude=["read_*"] 命中 read_image
    const gWild = gate({ exclude: ["read_*"] });
    expect(gWild.shouldRemind({ agent, name: "read_image" }, listResult)).toBe(false);
    expect(gWild.shouldRemind({ agent, name: "glob" }, listResult)).toBe(true);

    // 空名单：不排除任何工具
    const gNone = gate({ exclude: [] });
    expect(gNone.shouldRemind({ agent, name: "read" }, listResult)).toBe(true);
  });
});

describe("routingReminder soft hook 集成", () => {
  test("on-list：返回列表的工具附加 additionalContexts；标量工具不附加", async () => {
    const ctx = await setup({ dsl: { routingReminder: "on-list" } });
    const listTool = registerListTool(ctx);
    const scalarTool = registerScalarTool(ctx);

    const listResult = await callFull(ctx, listTool, {});
    expect(listResult.isError).toBe(false);
    expect(listResult.additionalContexts?.length).toBeGreaterThan(0);
    const reminder = listResult.additionalContexts![0];
    expect(reminder.source.kind).toBe("plugin");
    expect(String((reminder.content[0] as { text: string }).text)).toContain("jit_execute_program");

    const scalarResult = await callFull(ctx, scalarTool, {});
    expect(scalarResult.isError).toBe(false);
    expect(scalarResult.additionalContexts).toBeUndefined();
  });

  test("默认（未配置 routingReminder）：开启注入；显式 none 关闭", async () => {
    // 生产默认 on-list：不配置也注入。
    const ctxDefault = await setup();
    const listTool = registerListTool(ctxDefault);
    const defaultResult = await callFull(ctxDefault, listTool, {});
    expect(defaultResult.isError).toBe(false);
    expect(defaultResult.additionalContexts?.length).toBeGreaterThan(0);

    // 显式 none：关闭。
    const ctxNone = await setup({ dsl: { routingReminder: "none" } });
    const noneTool = registerListTool(ctxNone);
    const noneResult = await callFull(ctxNone, noneTool, {});
    expect(noneResult.isError).toBe(false);
    expect(noneResult.additionalContexts).toBeUndefined();
  });

  test("routingReminderMinListLength 阈值生效", async () => {
    const ctx = await setup({ dsl: { routingReminder: "on-list", routingReminderMinListLength: 3 } });
    const listTool = registerListTool(ctx, ["a", "b"]); // 长度 2 < 3
    const result = await callFull(ctx, listTool, {});
    expect(result.isError).toBe(false);
    expect(result.additionalContexts).toBeUndefined();
  });

  test("内容读取类工具（read 形态）默认不触发提醒", async () => {
    const ctx = await setup({ dsl: { routingReminder: "on-list" } });
    ctx.tools.register({
      name: "read",
      description: "演示：模拟 read（lines 数组是内容细节）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            lines: { type: "array", items: { type: "object" } },
          },
          required: ["path", "lines"],
        },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      execute: async () => ({ path: "/f", lines: [{ number: 1, text: "a" }, { number: 2, text: "b" }] }),
    });
    const result = await callFull(ctx, "read", {});
    expect(result.isError).toBe(false);
    expect(result.additionalContexts).toBeUndefined();
  });

  test("嵌套执行（jit 程序内部经 hostDiscovery 分发）不注入提醒", async () => {
    const ctx = await setup({ dsl: { routingReminder: "on-list" } });
    registerListTool(ctx);
    const source = ["x = demo_list()", "return x"].join("\n");
    const result = await callFull(ctx, "jit_execute_program", { source });
    expect(result.isError).toBe(false);
    // jit_execute_program 自身返回 JSON 字符串（非列表）；其内部嵌套的 demo_list
    // 带 parent，被排除——两者都不应触发提醒。
    expect(result.additionalContexts).toBeUndefined();
  });
});
