import { Context } from "@deepseek-ai/cordis";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRegistry from "@deepseek-ai/dsh-tools";
import { describe, expect, test } from "vitest";
import { apply, inject, name } from "../src/integrations/dsh/index.js";

/**
 * hostDiscovery 活视图测试：DSH 宿主工具零配置自动发现。
 *
 * 验证用户诉求——"agent 注册常用工具时，describe 直接获取其使用方式，
 * 不需要通过代码或配置的修改才可以用 DSL"：
 * 1. 插件 apply 之后再注册的宿主工具（动态注册 / 其他插件后加载）立即可见：
 *    jit_describe_tools 能拿到契约、jit_execute_program 能编排执行；
 * 2. 宿主工具执行经 ctx.tools.execute 嵌套分发（真实策略管线），结果正确；
 * 3. jit_* 元工具自身被排除（防递归）；
 * 4. 白名单 / 黑名单配置仍然生效（收紧场景）。
 */

async function setup(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Timer);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRegistry);
  await ctx.plugin({ name, inject, apply }, { providers: { github: "mock", domain: "mock" } });
  return ctx;
}

/** 经 ctx.tools.execute 调用一次工具（完整 DSH 执行管线），返回成功值。 */
async function call(ctx: Context, toolName: string, args: unknown): Promise<unknown> {
  let seq = 0;
  const result = await ctx.tools.execute({
    callId: CallId(`host-discovery:${toolName}:${seq++}`),
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  });
  if (result.isError) throw new Error(`工具 ${toolName} 失败：${result.error.message}`);
  return result.value;
}

/** 注册一个"宿主"工具（模拟其他插件 / 用户动态注册的常用工具）。 */
function registerDemoTool(ctx: Context, nameOverride?: string): string {
  const toolName = nameOverride ?? "demo_calc";
  ctx.tools.register({
    name: toolName,
    description: "演示工具：计算两数之和。",
    parameters: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: { sum: { type: "integer" } }, required: ["sum"] },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async (args: { a: number; b: number }) => ({ sum: args.a + args.b }),
  });
  return toolName;
}

describe("hostDiscovery 活视图：零配置自动发现 DSH 宿主工具", () => {
  test("apply 后注册的工具，describe 立即能拿到 DSL 契约（无需配置 hostTools）", async () => {
    const ctx = await setup();
    const toolName = registerDemoTool(ctx);

    // 关键断言：插件 apply 时该工具尚不存在，但 describe 仍能解析（活视图，非快照）。
    const text = String(await call(ctx, "jit_describe_tools", { tool_names: [toolName] }));
    expect(text).toContain(toolName);
    expect(text).toContain("a: int");
    expect(text).toContain("b: int");
    expect(text).toContain("->");
  });

  test("apply 后注册的工具，DSL 程序直接可编排执行（零配置）", async () => {
    const ctx = await setup();
    const toolName = registerDemoTool(ctx);

    const source = [
      `x = ${toolName}(a=2, b=3)`,
      "return x",
    ].join("\n");
    const result = JSON.parse(String(await call(ctx, "jit_execute_program", { source })));
    expect(result).toEqual({ sum: 5 });
  });

  test("宿主工具经 ctx.tools.execute 嵌套分发（真实执行管线，非旁路）", async () => {
    const ctx = await setup();
    const toolName = registerDemoTool(ctx);

    // 在真实服务树上加一个 guard：拒绝该宿主工具 → DSL 程序应整体失败
    // （证明嵌套分发走完整策略管线，guard 生效）。
    ctx.tools.guard((exec) => (exec.name === toolName ? `guard 拒绝 ${toolName}` : undefined));
    const source = [
      `x = ${toolName}(a=1, b=1)`,
      "return x",
    ].join("\n");
    await expect(call(ctx, "jit_execute_program", { source })).rejects.toThrow(/guard 拒绝/);
  });

  test("jit_* 元工具自身被排除（防递归），describe 未知整体失败", async () => {
    const ctx = await setup();
    await expect(
      call(ctx, "jit_describe_tools", { tool_names: ["jit_execute_program"] }),
    ).rejects.toThrow(/UNKNOWN_TOOL/);
    // DSL 程序引用 jit_execute_program 也应编译失败。
    const source = [
      'x = jit_execute_program(source="return 1")',
      "return x",
    ].join("\n");
    await expect(call(ctx, "jit_execute_program", { source })).rejects.toThrow();
  });

  test("白名单 hostTools 只开放列出的工具；黑名单 excludeHostTools 始终排除", async () => {
    // 白名单：只允许 demo_calc，宿主工具列表里其他工具（如 jit 之外的业务）不可用。
    const ctxAllow = new Context();
    await ctxAllow.plugin(Timer);
    await ctxAllow.plugin(SystemPrompt);
    await ctxAllow.plugin(ToolRegistry);
    await ctxAllow.plugin(
      { name, inject, apply },
      { providers: { github: "mock", domain: "mock" }, hostTools: ["demo_calc"] },
    );
    const allowedName = registerDemoTool(ctxAllow);
    const text = String(await call(ctxAllow, "jit_describe_tools", { tool_names: [allowedName] }));
    expect(text).toContain(allowedName);

    // 黑名单：exclude 掉 demo_calc → describe 未知。
    const ctxExclude = new Context();
    await ctxExclude.plugin(Timer);
    await ctxExclude.plugin(SystemPrompt);
    await ctxExclude.plugin(ToolRegistry);
    await ctxExclude.plugin(
      { name, inject, apply },
      { providers: { github: "mock", domain: "mock" }, excludeHostTools: ["demo_calc"] },
    );
    const excludedName = registerDemoTool(ctxExclude);
    await expect(
      call(ctxExclude, "jit_describe_tools", { tool_names: [excludedName] }),
    ).rejects.toThrow(/UNKNOWN_TOOL/);
  });
});
