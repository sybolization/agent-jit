import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Type } from "typebox";
import { createDshJitDescribeTool, createDshJitExecuteProgramTool } from "../src/integrations/dsh/jitTools.js";
import { createPiTools } from "../src/integrations/pi/toolAdapter.js";
import {
  BASELINE_DESCRIBE_DESCRIPTION,
  BASELINE_EXECUTE_DESCRIPTION,
  DSL_MINI_REFERENCE,
  R7_FORBIDDEN_PROMPT_TOKENS,
  ROUTING_TRIGGER,
  describeProgramDescription,
  executeProgramDescription,
  renderRoutingDslReference,
} from "../src/prompt/routingToolPrompts.js";
import { defineTool, type RegisteredTool } from "../src/tools/definition.js";
import { createMockGithubTools } from "../src/tools/providers/github/mock.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";

/**
 * R7 防 prompt overfit 检查：
 * 任何面向模型的路由文案都不得出现 benchmark 的任务常量、工具 id 或输出字段。
 * 这些 token 来自 R5/R6 的 B/A/C 任务与 oracle，如果候选 prompt 命中，
 * 实验就无法区分“路由能力”与“模板泄漏”。
 */
function expectNoBenchmarkLeakage(text: string): void {
  for (const token of R7_FORBIDDEN_PROMPT_TOKENS) {
    expect(text).not.toContain(token);
  }
}

function makeRegistry(): ToolRegistry<RegisteredTool> {
  return new ToolRegistry<RegisteredTool>(createMockGithubTools());
}

function makeEmptyHostTools(): ToolRuntime {
  return {
    get: () => undefined,
    schemas: () => [],
    execute: async () => {
      throw new Error("不应执行宿主工具");
    },
  } as unknown as ToolRuntime;
}

describe("R7 routing prompt variants — 纯文案层", () => {
  test("baseline 与当前生产文案逐字节一致（默认行为冻结）", () => {
    expect(executeProgramDescription("baseline")).toBe(BASELINE_EXECUTE_DESCRIPTION);
    expect(describeProgramDescription("baseline")).toBe(BASELINE_DESCRIBE_DESCRIPTION);
  });

  test("trigger 只补 when/why，不夹带 DSL 语法", () => {
    const text = executeProgramDescription("trigger");
    expect(text).toContain("当剩余工作可以确定为多步数据流时使用本工具");
    expect(text).toContain("中间结果不会进入上下文");
    expect(text).not.toContain("map(");
    expect(text).not.toContain("return ");
    expectNoBenchmarkLeakage(text);
  });

  test("tool-embedded 携带完整中性 DSL 参考", () => {
    const text = executeProgramDescription("tool-embedded");
    expect(text).toContain("## Agent Execution DSL 参考（核心语言语义）");
    expect(text).toContain("merge_by_key");
    expect(text).toContain("当剩余工作可以确定为多步数据流时使用本工具");
    expectNoBenchmarkLeakage(text);
  });

  test("tool-embedded-mini 携带极简 DSL 参考，且明显短于完整参考", () => {
    const mini = executeProgramDescription("tool-embedded-mini");
    const full = executeProgramDescription("tool-embedded");
    expect(mini).toContain("## Agent Execution DSL（极简）");
    expect(mini).toContain("map(列表, 工具(参数=_.字段))");
    expect(mini).toContain("return top");
    expectNoBenchmarkLeakage(mini);
    // 常驻成本预算：mini 描述必须显著短于完整参考（这里留 50% 余量）。
    expect(mini.length * 2).toBeLessThan(full.length);
  });

  test("mini reference 自身不含 benchmark 字段/常量", () => {
    expectNoBenchmarkLeakage(DSL_MINI_REFERENCE);
    expect(DSL_MINI_REFERENCE).toContain("service.search");
    expect(DSL_MINI_REFERENCE).toContain("service.get_detail");
  });

  test("lazy manual 使用中性参考，不随历史 guidance 复现", () => {
    const reference = renderRoutingDslReference();
    expect(reference).toContain("## Agent Execution DSL 参考（核心语言语义）");
    expectNoBenchmarkLeakage(reference);
  });

  test("候选文案 SHA256 冻结：任何字符改动都会让实验失效", () => {
    const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
    // 哈希表与 docs/r7-routing-plan.md 第 3 节一致（2026-08-17 冻结）。
    expect(sha(ROUTING_TRIGGER)).toBe("90879b6a0800dfa7");
    expect(sha(DSL_MINI_REFERENCE)).toBe("3afcb2064c60b236");
    expect(sha(renderRoutingDslReference())).toBe("2a3f27c1aadf196f");
    expect(sha(executeProgramDescription("baseline"))).toBe("4ea3958d54e4ee30");
    expect(sha(executeProgramDescription("trigger"))).toBe("c6aa0f9ca45eb135");
    expect(sha(executeProgramDescription("tool-embedded"))).toBe("207cdefd22dda650");
    expect(sha(executeProgramDescription("tool-embedded-mini"))).toBe("0ea71aa08fac2f4e");
    expect(sha(describeProgramDescription("baseline"))).toBe("8448771750610224");
    expect(sha(describeProgramDescription("trigger"))).toBe("7b4ce3cd26f808fa");
  });
});

describe("R7 routing prompt variants — DSH 元工具集成", () => {
  test("createDshJitExecuteProgramTool 默认 baseline，可按 variant 切换", () => {
    const registry = makeRegistry();
    const baseline = createDshJitExecuteProgramTool(registry, makeEmptyHostTools());
    expect(baseline.description).toBe(BASELINE_EXECUTE_DESCRIPTION);

    const embedded = createDshJitExecuteProgramTool(registry, makeEmptyHostTools(), {
      routingPrompt: "tool-embedded-mini",
    });
    expect(embedded.description).toContain("## Agent Execution DSL（极简）");
    expect(embedded.description).toContain("return top");
    expectNoBenchmarkLeakage(embedded.description);
  });

  test("createDshJitDescribeTool 默认纯契约；first-call 只附一次中性 DSL 参考", async () => {
    const registry = makeRegistry();
    const lazy = createDshJitDescribeTool(registry, makeEmptyHostTools(), {
      routingPrompt: "trigger",
      describeDslReference: "first-call",
    });
    expect(lazy.description).toContain("先调用本工具获取相关工具的 DSL 契约");
    expectNoBenchmarkLeakage(lazy.description);

    const first = String(await lazy.execute({ tool_names: ["github.get_repository"] }, undefined as never));
    expect(first.startsWith("## Agent Execution DSL 参考（核心语言语义）")).toBe(true);
    expect(first).toContain("# Requested Tool Contracts");
    // 契约段必然包含被查询工具的真实字段，所以防泄漏检查只针对前置 language reference。
    expectNoBenchmarkLeakage(first.slice(0, first.indexOf("# Requested Tool Contracts")));

    const second = String(await lazy.execute({ tool_names: ["github.get_repository"] }, undefined as never));
    expect(second.startsWith("# Requested Tool Contracts")).toBe(true);
    expect(second).not.toContain("## Agent Execution DSL 参考（核心语言语义）");
  });

  test("Pi 集成同样支持 R7 routingPrompt + describeDslReference（R7 harness 依赖）", async () => {
    const registry = makeRegistry();

    const miniTools = createPiTools(registry, {
      routingPrompt: "tool-embedded-mini",
      describeDslReference: "none",
      describeTools: true,
      dslSignatures: true,
    });
    const execute = miniTools.find((tool) => tool.name === "jit_execute_program")!;
    expect(execute.description).toContain("## Agent Execution DSL（极简）");
    expect(execute.description).toContain("return top");

    const lazyTools = createPiTools(registry, {
      routingPrompt: "trigger",
      describeDslReference: "first-call",
      describeTools: true,
      dslSignatures: true,
    });
    const describe = lazyTools.find((tool) => tool.name === "jit_describe_tools")!;
    expect(describe.description).toContain("先调用本工具获取相关工具的 DSL 契约");
    const textOf = (result: unknown): string =>
      String((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");
    const first = textOf(await describe.execute("c1", { tool_names: ["github.get_repository"] }));
    expect(first.startsWith("## Agent Execution DSL 参考（核心语言语义）")).toBe(true);
    expect(first).toContain("# Requested Tool Contracts");
    const second = textOf(await describe.execute("c2", { tool_names: ["github.get_repository"] }));
    expect(second.startsWith("# Requested Tool Contracts")).toBe(true);
  });
});
