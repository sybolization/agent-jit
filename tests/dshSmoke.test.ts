import { Context } from "@deepseek-ai/cordis";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRegistry from "@deepseek-ai/dsh-tools";
import { describe, expect, test } from "vitest";
import { apply, inject, name } from "../src/integrations/dsh/index.js";

/**
 * DSH 端到端 smoke 测试：在真实的 DSH 服务树（Timer + SystemPrompt +
 * ToolRegistry，与 cordis-host-runner 测试 helpers 相同的挂载方式）上挂载
 * agent-jit-dsl 插件，验证：
 * 1. 生产缺省（experimentMode 未开）：不注册实验业务工具，只挂 jit_* 元工具；
 * 2. experimentMode: true：业务工具（github + domain）全部以 host alias 名
 *    注册进 ctx.tools，description 带实验验证的函数式 DSL 签名；
 * 3. jit_describe_tools / jit_execute_program 元工具注册可用；
 * 4. 执行路径压缩：同一份确定性编排，DSL 单次工具调用 ≡ 逐工具 11 次调用，
 *    最终结果一致（这是 JIT offload 的核心价值：把 agent loop 的
 *    N 轮工具往返压缩为 1 次）。
 */

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Timer);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRegistry);
  await ctx.plugin(
    { name, inject, apply },
    { providers: { github: "mock", domain: "mock" }, experimentMode: true, ...config },
  );
  return ctx;
}

/** 经 ctx.tools.execute 调用一次工具（完整 DSH 执行管线），返回成功值。 */
async function call(ctx: Context, toolName: string, args: unknown): Promise<unknown> {
  let seq = 0;
  const result = await ctx.tools.execute({
    callId: CallId(`smoke:${toolName}:${seq++}`),
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  });
  if (result.isError) throw new Error(`工具 ${toolName} 失败：${result.error.message}`);
  return result.value;
}

const PROVIDER_ALIASES = [
  "github_search_repositories",
  "github_get_repository",
  "github_get_languages",
  "github_list_contributors",
  "github_get_contributor_stats",
  "github_list_commits",
  "crm_search_customers",
  "crm_get_customer",
  "users_list_users",
  "email_prepare",
] as const;

describe("agent-jit-dsl 在真实 DSH 服务树上的挂载", () => {
  test("生产缺省（experimentMode 未开）：不注册实验业务工具，只挂 jit_* 元工具", async () => {
    const ctx = await setup({ experimentMode: undefined, providers: undefined });
    for (const alias of PROVIDER_ALIASES) {
      expect(ctx.tools.get(alias), `${alias} 生产模式不应注册`).toBeUndefined();
    }
    expect(ctx.tools.get("jit_describe_tools")).toBeDefined();
    expect(ctx.tools.get("jit_execute_program")).toBeDefined();
  });

    test("生产默认 = R7 T3：jit_execute_program 工具面自描述（trigger + 完整中性 manual）", async () => {
      const ctx = await setup();
      const execute = ctx.tools.get("jit_execute_program")!;
      expect(execute.description).toContain("当剩余工作可以确定为多步数据流时使用本工具");
      expect(execute.description).toContain("## Agent Execution DSL 参考（核心语言语义）");
      expect(execute.description).toContain("merge_by_key");
      // 中性 manual：不出现 benchmark 的 GitHub 工具/字段示例。
      expect(execute.description).not.toContain("github.search_repositories");
      expect(execute.description).not.toContain("full_name");
    });

  test("experimentMode: true：10 个业务工具全部注册（host alias 名），description 注入 DSL 函数式签名", async () => {
    const ctx = await setup();
    for (const alias of PROVIDER_ALIASES) {
      const definition = ctx.tools.get(alias);
      expect(definition, `${alias} 应已注册`).toBeDefined();
      expect(definition!.description).toContain("DSL: ");
    }
    const repo = ctx.tools.get("github_get_repository")!;
    expect(repo.description).toContain(
      "github.get_repository(full_name: str) -> {full_name: str, stars: int, forks: int, archived: bool, language: str}",
    );
  });

  test("jit_describe_tools / jit_execute_program 注册并返回函数式契约", async () => {
    const ctx = await setup();
    expect(ctx.tools.get("jit_describe_tools")).toBeDefined();
    expect(ctx.tools.get("jit_execute_program")).toBeDefined();
    const text = await call(ctx, "jit_describe_tools", { tool_names: ["github.get_repository", "crm.get_customer"] });
    expect(String(text)).toContain("github.get_repository");
    expect(String(text)).toContain("crm.get_customer");
    expect(String(text)).toContain("->");
  });

  test("R7 配置：systemPrompt:false + 工具面文案变体 + lazy manual 在真实服务树上生效", async () => {
    const ctx = await setup({
      dsl: {
        systemPrompt: false,
        routingPrompt: "tool-embedded-mini",
        describeDslReference: "first-call",
        signatureInDescription: "inline",
      },
    });

    const executeDefinition = ctx.tools.get("jit_execute_program")!;
    expect(executeDefinition.description).toContain("## Agent Execution DSL（极简）");
    expect(executeDefinition.description).toContain("当剩余工作可以确定为多步数据流时使用本工具");

    const first = String(await call(ctx, "jit_describe_tools", { tool_names: ["github.get_repository"] }));
    expect(first.startsWith("## Agent Execution DSL 参考（核心语言语义）")).toBe(true);
    expect(first).toContain("# Requested Tool Contracts");

    const second = String(await call(ctx, "jit_describe_tools", { tool_names: ["github.get_repository"] }));
    expect(second.startsWith("# Requested Tool Contracts")).toBe(true);
    expect(second).not.toContain("## Agent Execution DSL 参考（核心语言语义）");
  });

  test("执行路径压缩：DSL 单次调用 ≡ 逐工具 11 次调用，结果一致", async () => {
    const ctx = await setup();
    const source = [
      'repos = github.search_repositories(query="dsl", limit=5)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      "active = filter(details, archived=false)",
      "top = take(active, 3)",
      "return top",
    ].join("\n");

    // 压缩路径：一次 jit_execute_program（1 次工具调用）。
    const compressed = JSON.parse(String(await call(ctx, "jit_execute_program", { source })));

    // 未压缩路径：模拟 agent loop 逐工具执行（1 search + 10 get_repository = 11 次调用）。
    const uncompressedCalls: string[] = [];
    const search = (await call(ctx, "github_search_repositories", {
      query: "dsl",
      limit: 5,
    })) as { full_name: string; archived: boolean }[];
    const details: unknown[] = [];
    for (const repo of search) {
      details.push(
        await call(ctx, "github_get_repository", { full_name: repo.full_name }),
      );
    }
    const active = details.filter((repo) => (repo as { archived: boolean }).archived === false);
    const top = active.slice(0, 3);
    uncompressedCalls.push("search");
    for (const repo of search) uncompressedCalls.push(`get_repository(${repo.full_name})`);

    expect(compressed).toEqual(top);
    expect(uncompressedCalls.length).toBe(11);
    // 压缩比：11 次 agent loop 工具往返 → 1 次。
    expect(compressed.length).toBe(3);
  });
});
