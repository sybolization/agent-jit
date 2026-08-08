import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import type { ToolContract, RegisteredTool } from "../src/tools/definition.js";
import type { LlmGateway, LlmMessage, LlmResult } from "../src/llm/gateway.js";
import { exactAnswerMatch, extractFullNames, matchAnswer, runIterativeToolCalling, toPiTools } from "../src/experiments/iterativeToolCalling.js";

// ---------------------------------------------------------------------------
// 纯逻辑：答案提取
// ---------------------------------------------------------------------------

describe("extractFullNames — 从模型文本提取 owner/repo", () => {
  test("提取基本 owner/repo 对", () => {
    expect(extractFullNames("答案：\nowner/repo-a\nowner/repo-b")).toEqual(["owner/repo-a", "owner/repo-b"]);
  });

  test("Markdown 链接 / 反引号包裹不污染", () => {
    expect(extractFullNames("- [repo](https://github.com/owner/repo)\n- `owner/repo-b`")).toEqual([
      "owner/repo",
      "owner/repo-b",
    ]);
  });

  test("去重且保序", () => {
    expect(extractFullNames("a/b\na/b\nc/d\nc/d")).toEqual(["a/b", "c/d"]);
  });

  test("空文本返回空数组", () => {
    expect(extractFullNames("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 纯逻辑：集合匹配
// ---------------------------------------------------------------------------

describe("matchAnswer — 与 ground truth 集合交集匹配", () => {
  const truth = ["owner/a", "owner/b", "owner/c"];

  test("命中 ≥ required 通过（不看顺序）", () => {
    expect(matchAnswer(["owner/c", "owner/a"], truth, 2)).toBe(true);
  });

  test("命中 < required 失败", () => {
    expect(matchAnswer(["owner/a"], truth, 2)).toBe(false);
  });

  test("required=0 恒通过", () => {
    expect(matchAnswer([], truth, 0)).toBe(true);
  });

  test("幻觉名称不命中", () => {
    expect(matchAnswer(["owner/not-in-truth"], truth, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 纯逻辑：严格答案匹配（R4d）
// ---------------------------------------------------------------------------

describe("exactAnswerMatch — 长度 + 逐元素 + 顺序严格匹配", () => {
  const truth = ["owner/a", "owner/b", "owner/c"];

  test("完全相同（长度/顺序/元素）→ 通过", () => {
    expect(exactAnswerMatch(["owner/a", "owner/b", "owner/c"], truth)).toBe(true);
  });

  test("顺序错 → 失败", () => {
    expect(exactAnswerMatch(["owner/c", "owner/b", "owner/a"], truth)).toBe(false);
  });

  test("长度不足 → 失败", () => {
    expect(exactAnswerMatch(["owner/a", "owner/b"], truth)).toBe(false);
  });

  test("多余元素 → 失败", () => {
    expect(exactAnswerMatch(["owner/a", "owner/b", "owner/c", "owner/d"], truth)).toBe(false);
  });

  test("集合相同但缺一个 → 失败", () => {
    expect(exactAnswerMatch(["owner/a", "owner/b", "owner/d"], truth)).toBe(false);
  });

  test("双空 → 通过", () => {
    expect(exactAnswerMatch([], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 纯逻辑：ToolContract → pi-ai 工具定义
// ---------------------------------------------------------------------------

describe("toPiTools — ToolContract 转 pi-ai Tool", () => {
  const specs: readonly ToolContract[] = [
    {
      id: "github.search_repositories",
      label: "Search",
      description: "按查询搜索仓库",
      inputSchema: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer()) }),
      outputSchema: Type.Array(Type.Object({ full_name: Type.String() })),
    },
  ];

  test("name/description 从 spec 映射（点号转下划线，避开 OpenAI 工具名限制）", () => {
    const tools = toPiTools(specs);
    expect(tools[0]!.name).toBe("github_search_repositories");
    expect(tools[0]!.description).toBe("按查询搜索仓库");
  });

  test("required 参数进 required 列表，可选参数不进", () => {
    const schema = toPiTools(specs)[0]!.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(["query", "limit"]);
    expect(schema.required).toEqual(["query"]);
  });
});

// ---------------------------------------------------------------------------
// 工具循环（mock gateway 注入）
// ---------------------------------------------------------------------------

const SEARCH_TOOL: RegisteredTool = {
  id: "github.search_repositories",
  label: "Search",
  inputSchema: Type.Object({ query: Type.String() }),
  outputSchema: Type.Array(Type.Object({ full_name: Type.String() })),
  execute: async () => [{ full_name: "owner/a" }, { full_name: "owner/b" }, { full_name: "owner/c" }],
};

function makeGateway(
  script: Array<(messages: readonly LlmMessage[]) => LlmResult>,
): { gateway: LlmGateway; received: readonly LlmMessage[][] } {
  const received: LlmMessage[][] = [];
  let index = 0;
  const gateway: LlmGateway = {
    async complete(messages) {
      received.push([...messages]);
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      return step(messages);
    },
  };
  return { gateway, received };
}

const USAGE = { input: 10, output: 5, cacheRead: 0, totalTokens: 15 };
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });

describe("runIterativeToolCalling — agent loop 纯逻辑", () => {
  test("正常路径：工具轮 + 无工具调用即结束（默认 minConsecutiveNoTool=1），消息累积正确", async () => {
    const { gateway, received } = makeGateway([
      () => ({ content: "", toolCalls: [toolCall("c1", "github_search_repositories", { query: "x" })], usage: USAGE }),
      () => ({ content: "结果：owner/a\nowner/b", toolCalls: [], usage: USAGE }),
    ]);
    const result = await runIterativeToolCalling({
      gateway,
      initialMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "任务" },
      ],
      tools: [SEARCH_TOOL],
      toolSpecs: [SEARCH_TOOL],
      maxSteps: 5,
      groundTruth: ["owner/a", "owner/b", "owner/c"],
      required: 2,
    });

    // 2 次 complete 调用；第 2 次调用时 messages 应含 assistant + toolResult
    expect(result.ok).toBe(true);
    expect(result.round_trips).toBe(2);
    expect(result.maxed_out).toBe(false);
    expect(result.task_pass).toBe(true);
    expect(result.answered).toEqual(["owner/a", "owner/b"]);
    expect(result.exposed_bytes).toBeGreaterThan(0);
    expect(result.model_ingress_bytes).toBeGreaterThan(0);
    expect(result.model_egress_bytes).toBeGreaterThan(0);
    expect(result.runtime_internal_bytes).toBe(0);
    expect(result.usage.totalTokens).toBe(30);

    expect(received).toHaveLength(2);
    expect(received[0]!.map((m) => m.role)).toEqual(["system", "user"]);
    const secondCall = received[1]!;
    const toolResult = secondCall.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(toolResult?.role === "toolResult" && toolResult.toolName).toBe("github_search_repositories");
    expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(false);
  });

  test("minConsecutiveNoTool=2 显式指定时仍需要连续两轮无工具调用", async () => {
    const { gateway } = makeGateway([
      () => ({ content: "", toolCalls: [toolCall("c1", "github_search_repositories", { query: "x" })], usage: USAGE }),
      () => ({ content: "中间轮", toolCalls: [], usage: USAGE }),
      () => ({ content: "结果：owner/a\nowner/b", toolCalls: [], usage: USAGE }),
    ]);
    const result = await runIterativeToolCalling({
      gateway,
      initialMessages: [{ role: "user", content: "任务" }],
      tools: [SEARCH_TOOL],
      toolSpecs: [SEARCH_TOOL],
      maxSteps: 5,
      groundTruth: ["owner/a", "owner/b", "owner/c"],
      required: 2,
      minConsecutiveNoTool: 2,
    });
    expect(result.round_trips).toBe(3);
  });

  test("未知工具：注入 isError toolResult，循环继续", async () => {
    const { gateway } = makeGateway([
      () => ({ content: "", toolCalls: [toolCall("c1", "no.such_tool", {})], usage: USAGE }),
      () => ({ content: "结果：owner/a", toolCalls: [], usage: USAGE }),
    ]);
    const result = await runIterativeToolCalling({
      gateway,
      initialMessages: [{ role: "user", content: "任务" }],
      tools: [SEARCH_TOOL],
      toolSpecs: [SEARCH_TOOL],
      maxSteps: 5,
      groundTruth: ["owner/a"],
      required: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.task_pass).toBe(true);
    expect(result.round_trips).toBe(2);
  });

  test("工具执行抛错：错误进 toolResult，不中断循环", async () => {
    const failingTool: RegisteredTool = {
      id: "boom",
      label: "Boom",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => {
        throw new Error("rate limited");
      },
    };
    const { gateway } = makeGateway([
      () => ({ content: "", toolCalls: [toolCall("c1", "boom", {})], usage: USAGE }),
      () => ({ content: "结果：owner/a", toolCalls: [], usage: USAGE }),
      () => ({ content: "结果：owner/a", toolCalls: [], usage: USAGE }),
    ]);
    const result = await runIterativeToolCalling({
      gateway,
      initialMessages: [{ role: "user", content: "任务" }],
      tools: [failingTool],
      toolSpecs: [failingTool],
      maxSteps: 5,
      groundTruth: ["owner/a"],
      required: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.exposed_bytes).toBeGreaterThan(0);
  });

  test("同一 completion 的多个 toolCalls 并行执行，toolResult 按调用顺序回填", async () => {
    const order: string[] = [];
    const slowTool: RegisteredTool = {
      id: "slow",
      label: "Slow",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      execute: async () => {
        order.push("start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push("end");
        return { value: 1 };
      },
    };
    const { gateway, received } = makeGateway([
      () => ({ content: "", toolCalls: [toolCall("c1", "slow", {}), toolCall("c2", "slow", {})], usage: USAGE }),
      () => ({ content: "结果：x/y", toolCalls: [], usage: USAGE }),
    ]);
    const result = await runIterativeToolCalling({
      gateway,
      initialMessages: [{ role: "user", content: "任务" }],
      tools: [slowTool],
      toolSpecs: [slowTool],
      maxSteps: 5,
      groundTruth: ["x/y"],
      required: 1,
    });
    // 并行：两个 start 都先于任何 end（顺序执行会是 start,end,start,end）
    expect(order[0]).toBe("start");
    expect(order[1]).toBe("start");
    // toolResult 按 toolCall 顺序回填（c1 在 c2 前）
    const secondCall = received[1]!;
    const toolResultIds = secondCall
      .filter((m) => m.role === "toolResult")
      .map((m) => (m as { toolCallId: string }).toolCallId);
    expect(toolResultIds).toEqual(["c1", "c2"]);
    expect(result.ok).toBe(true);
    expect(result.round_trips).toBe(2);
  });

  test("maxed_out：达到 maxSteps 仍未结束", async () => {
    const { gateway } = makeGateway([
      () => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE }),
    ]);
    const result = await runIterativeToolCalling({
      gateway,
      initialMessages: [{ role: "user", content: "任务" }],
      tools: [SEARCH_TOOL],
      toolSpecs: [SEARCH_TOOL],
      maxSteps: 2,
      groundTruth: ["owner/a"],
      required: 1,
    });
    expect(result.maxed_out).toBe(true);
    expect(result.round_trips).toBe(2);
    expect(result.answered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R4d：strictAnswer（submit_answer 机器接口）
// ---------------------------------------------------------------------------

describe("runIterativeToolCalling — strictAnswer（submit_answer 严格答案接口）", () => {
  const TRUTH = ["owner/a", "owner/b", "owner/c"];
  const run = (script: Array<(messages: readonly LlmMessage[]) => LlmResult>, maxSteps = 5) =>
    runIterativeToolCalling({
      gateway: makeGateway(script).gateway,
      initialMessages: [{ role: "user", content: "任务" }],
      tools: [SEARCH_TOOL],
      toolSpecs: [SEARCH_TOOL],
      maxSteps,
      groundTruth: TRUTH,
      required: 3,
      strictAnswer: true,
    });

  test("调用 submit_answer → 提取 repositories，精确匹配通过", async () => {
    const result = await run([
      () => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE }),
      () => ({
        content: "",
        toolCalls: [toolCall("c2", "submit_answer", { repositories: ["owner/a", "owner/b", "owner/c"] })],
        usage: USAGE,
      }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.round_trips).toBe(2);
    expect(result.answered).toEqual(TRUTH);
    expect(result.task_pass).toBe(true);
    expect(result.maxed_out).toBe(false);
  });

  test("顺序错 → 失败（strict 判定，不看集合）", async () => {
    const result = await run([
      () => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE }),
      () => ({
        content: "",
        toolCalls: [toolCall("c2", "submit_answer", { repositories: ["owner/c", "owner/b", "owner/a"] })],
        usage: USAGE,
      }),
    ]);
    expect(result.task_pass).toBe(false);
  });

  test("长度不足 → 失败", async () => {
    const result = await run([
      () => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE }),
      () => ({
        content: "",
        toolCalls: [toolCall("c2", "submit_answer", { repositories: ["owner/a", "owner/b"] })],
        usage: USAGE,
      }),
    ]);
    expect(result.task_pass).toBe(false);
  });

  test("repositories 非数组 → answered=[] 且失败", async () => {
    const result = await run([
      () => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE }),
      () => ({
        content: "",
        toolCalls: [toolCall("c2", "submit_answer", { repositories: "owner/a" })],
        usage: USAGE,
      }),
    ]);
    expect(result.answered).toEqual([]);
    expect(result.task_pass).toBe(false);
  });

  test("正文作答未调用 submit_answer → answered=[] 且失败（不再 regex 捞答案）", async () => {
    const result = await run([
      () => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE }),
      () => ({ content: "答案：\nowner/a\nowner/b\nowner/c", toolCalls: [], usage: USAGE }),
    ]);
    expect(result.round_trips).toBe(2);
    expect(result.answered).toEqual([]);
    expect(result.task_pass).toBe(false);
  });

  test("maxed_out 且未 submit_answer → answered=[]、失败、maxed_out=true", async () => {
    const result = await run(
      [() => ({ content: "", toolCalls: [toolCall("c1", "github.search_repositories", { query: "x" })], usage: USAGE })],
      2,
    );
    expect(result.maxed_out).toBe(true);
    expect(result.answered).toEqual([]);
    expect(result.task_pass).toBe(false);
  });
});
