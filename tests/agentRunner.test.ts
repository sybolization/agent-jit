import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { runPiAgent } from "../src/experiments/agentRunner.js";
import type { PiRuntime } from "../src/llm/gateway.js";

const stubTool = (): AgentTool => ({
  name: "demo_lookup",
  label: "Demo Lookup",
  description: "Demo lookup tool",
  parameters: Type.Object({ query: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
});

const makeRuntime = (responses: ReturnType<typeof fauxAssistantMessage>[]): PiRuntime => {
  const faux = fauxProvider({ models: [{ id: "faux" }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    model: faux.getModel() as unknown as PiRuntime["model"],
    streamFn: models.streamSimple.bind(models) as unknown as PiRuntime["streamFn"],
  };
};

describe("runPiAgent — 每轮 token 捕获（AgentTokenRound）", () => {
  test("3 轮：tokenRounds 轮次对齐，Σ round tokens === run.tokens 不变式成立", async () => {
    const runtime = makeRuntime([
      fauxAssistantMessage([fauxToolCall("demo_lookup", { query: "a" })]),
      fauxAssistantMessage([fauxToolCall("demo_lookup", { query: "b" })]),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const result = await runPiAgent({
      systemPrompt: "你是测试 agent",
      tools: [stubTool()],
      prompt: "查询一下",
      runtime,
    });

    expect(result.error).toBeUndefined();
    expect(result.tokenRounds).toHaveLength(3);
    expect(result.reasoningTurns).toHaveLength(3);

    // 轮次对齐：round 从 1 递增，与 reasoningTurns 的 round 一致
    result.tokenRounds.forEach((round, index) => {
      expect(round.round).toBe(index + 1);
      expect(round.round).toBe(result.reasoningTurns[index]!.round);
    });

    // toolCalls 记录正确
    expect(result.tokenRounds[0]!.toolCalls).toEqual(["demo_lookup"]);
    expect(result.tokenRounds[1]!.toolCalls).toEqual(["demo_lookup"]);
    expect(result.tokenRounds[2]!.toolCalls).toEqual([]);

    // 不变式：Σ round.{input|cacheRead|output|total} === run.tokens.{...}
    const sum = result.tokenRounds.reduce(
      (acc, round) => ({
        input: acc.input + round.input,
        cacheRead: acc.cacheRead + round.cacheRead,
        output: acc.output + round.output,
        total: acc.total + round.total,
      }),
      { input: 0, cacheRead: 0, output: 0, total: 0 },
    );
    expect(sum).toEqual(result.tokens);
  });

  test("同轮多工具调用：toolCalls 按序完整记录", async () => {
    const runtime = makeRuntime([
      fauxAssistantMessage([fauxToolCall("demo_lookup", { query: "a" }), fauxToolCall("demo_lookup", { query: "b" })]),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const result = await runPiAgent({
      systemPrompt: "t",
      tools: [stubTool()],
      prompt: "q",
      runtime,
    });
    expect(result.error).toBeUndefined();
    expect(result.tokenRounds).toHaveLength(2);
    expect(result.tokenRounds[0]!.toolCalls).toEqual(["demo_lookup", "demo_lookup"]);
  });
});

describe("runPiAgent — terminate 早停与 maxedOut 修正（terminatingToolNames）", () => {
  const submitTool = (): AgentTool => ({
    name: "submit_answer",
    label: "Submit Final Answer",
    description: "提交最终答案",
    parameters: Type.Object({ answer: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {}, terminate: true }),
  });

  test("submit 早停：terminate:true + terminatingToolNames → 无多余轮、maxedOut=false", async () => {
    const runtime = makeRuntime([fauxAssistantMessage([fauxToolCall("submit_answer", { answer: "done" })])]);
    const result = await runPiAgent({
      systemPrompt: "t",
      tools: [submitTool()],
      prompt: "q",
      runtime,
      terminatingToolNames: ["submit_answer"],
    });
    expect(result.error).toBeUndefined();
    expect(result.rounds).toBe(1); // 不再进模型 final 轮
    expect(result.tokenRounds).toHaveLength(1);
    expect(result.reasoningTurns).toHaveLength(1);
    expect(result.tokenRounds[0]!.toolCalls).toEqual(["submit_answer"]);
    expect(result.maxedOut).toBe(false); // submit 主动结束，非截断
  });

  test("对照组：不带 terminatingToolNames 时 submit 早停仍按旧逻辑判 maxedOut（默认行为不变）", async () => {
    const runtime = makeRuntime([fauxAssistantMessage([fauxToolCall("submit_answer", { answer: "done" })])]);
    const result = await runPiAgent({
      systemPrompt: "t",
      tools: [submitTool()],
      prompt: "q",
      runtime,
    });
    expect(result.rounds).toBe(1); // pi-ai terminate 早停仍生效
    expect(result.maxedOut).toBe(true); // 旧逻辑：最后一条 assistant 带 toolCall
  });
});
