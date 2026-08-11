import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { extractAgentReasoningTurn, runPiAgent } from "../src/experiments/agentRunner.js";
import type { PiRuntime } from "../src/llm/gateway.js";

describe("extractAgentReasoningTurn（纯函数）", () => {
  test("thinking + toolCall + text 同轮捕获，round 透传", () => {
    const turn = extractAgentReasoningTurn(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先搜索" },
          { type: "toolCall", id: "c1", name: "github_search_repositories", arguments: { query: "x" } },
          { type: "text", text: "你好" },
        ],
      },
      1,
    );
    expect(turn.round).toBe(1);
    expect(turn.reasoning).toBe("先搜索");
    expect(turn.toolCalls).toEqual([{ name: "github_search_repositories", arguments: { query: "x" } }]);
    expect(turn.text).toBe("你好");
  });

  test("无 thinking：只有 text → reasoning 为空串且不抛错", () => {
    const turn = extractAgentReasoningTurn(
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      2,
    );
    expect(turn.reasoning).toBe("");
    expect(turn.text).toBe("hi");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.round).toBe(2);
  });

  test("多个 thinking 块按序拼接", () => {
    const turn = extractAgentReasoningTurn(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "第一步" },
          { type: "thinking", thinking: "第二步" },
        ],
      },
      3,
    );
    expect(turn.reasoning).toBe("第一步第二步");
  });

  test("未知/其他 block 类型（如 image）被忽略、不抛错", () => {
    const turn = extractAgentReasoningTurn(
      {
        role: "assistant",
        content: [{ type: "image", data: "x", mimeType: "image/png" }],
      },
      4,
    );
    expect(turn.reasoning).toBe("");
    expect(turn.text).toBe("");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.round).toBe(4);
  });
});

describe("runPiAgent 集成 — message_end 捕获 per-round reasoning", () => {
  test("两轮脚本化响应：round 对齐、reasoning/toolCalls/text 逐轮正确", async () => {
    const faux = fauxProvider({ models: [{ id: "faux", reasoning: true }] });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("先搜索看看"), fauxToolCall("demo_lookup", { query: "x" })]),
      fauxAssistantMessage([fauxThinking("任务完成"), fauxText("done")]),
    ]);

    const models = createModels();
    models.setProvider(faux.provider);
    const runtime: PiRuntime = {
      model: faux.getModel() as unknown as PiRuntime["model"],
      streamFn: models.streamSimple.bind(models) as unknown as PiRuntime["streamFn"],
    };

    const stubTool: AgentTool = {
      name: "demo_lookup",
      label: "Demo Lookup",
      description: "Demo lookup tool",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    };

    const result = await runPiAgent({
      systemPrompt: "你是测试 agent",
      tools: [stubTool],
      prompt: "查询一下",
      runtime,
    });

    expect(result.error).toBeUndefined();
    expect(result.reasoningTurns).toHaveLength(2);

    // 第 1 轮：thinking + toolCall
    const first = result.reasoningTurns[0]!;
    expect(first.round).toBe(1);
    expect(first.reasoning).toContain("先搜索");
    expect(first.toolCalls).toEqual([{ name: "demo_lookup", arguments: { query: "x" } }]);

    // round 对齐：同一轮的工具调用记录与 reasoningTurns[0].round 一致
    expect(result.toolCalls[0]!.round).toBe(first.round);

    // 第 2 轮：thinking + text，无 toolCall
    const second = result.reasoningTurns[1]!;
    expect(second.round).toBe(2);
    expect(second.reasoning).toContain("任务完成");
    expect(second.text).toBe("done");
    expect(second.toolCalls).toEqual([]);
  });
});
