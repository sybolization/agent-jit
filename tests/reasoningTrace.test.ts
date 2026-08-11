import { describe, expect, test } from "vitest";

import type { AgentReasoningTurn } from "../src/experiments/agentRunner.js";
import { alignReasoningTrace } from "../src/experiments/reasoningTrace.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../src/tools/jitTools.js";

const SEARCH = "github_search_repositories";
// JIT 工具名直接引用 jitTools.ts 导出的常量，避免字面量漂移
const DESCRIBE = DESCRIBE_TOOLS_TOOL.name; // jit_describe_tools
const EXECUTE = EXECUTE_PROGRAM_TOOL.name; // jit_execute_program

function turn(round: number, toolNames: readonly string[] = []): AgentReasoningTurn {
  return {
    round,
    reasoning: `R${round} reasoning`,
    toolCalls: toolNames.map((name) => ({ name, arguments: {} })),
    text: "",
  };
}

function toolCall(name: string, round: number): { name: string; round: number } {
  return { name, round };
}

describe("alignReasoningTrace — reasoning ↔ tool timeline 时间对齐", () => {
  test("标准三段：before-jit → jit-decision → jit-execute", () => {
    const trace = alignReasoningTrace(
      [turn(1, [SEARCH]), turn(2, [DESCRIBE]), turn(3, [EXECUTE])],
      [toolCall(SEARCH, 1), toolCall(DESCRIBE, 2), toolCall(EXECUTE, 3)],
    );
    expect(trace.map((t) => t.phase)).toEqual(["before-jit", "jit-decision", "jit-execute"]);
    expect(trace.map((t) => t.round)).toEqual([1, 2, 3]);
    expect(trace.map((t) => t.toolCalls)).toEqual([[SEARCH], [DESCRIBE], [EXECUTE]]);
    expect(trace[0]!.reasoning).toBe("R1 reasoning");
  });

  test("同轮并发 describe + 业务工具：同轮业务工具不影响 phase", () => {
    const trace = alignReasoningTrace(
      [turn(1, [SEARCH, DESCRIBE])],
      [toolCall(SEARCH, 1), toolCall(DESCRIBE, 1)],
    );
    expect(trace[0]!.phase).toBe("jit-decision");
    expect(trace[0]!.toolCalls).toEqual([SEARCH, DESCRIBE]);
  });

  test("late JIT 跨 round：describe 后先跑业务轮再 execute", () => {
    const trace = alignReasoningTrace(
      [turn(1, [SEARCH]), turn(2, [DESCRIBE]), turn(3, [SEARCH]), turn(4, [EXECUTE])],
      [toolCall(SEARCH, 1), toolCall(DESCRIBE, 2), toolCall(SEARCH, 3), toolCall(EXECUTE, 4)],
    );
    expect(trace.map((t) => t.phase)).toEqual(["before-jit", "jit-decision", "after-describe", "jit-execute"]);
  });

  test("execute 之后仍有业务轮次 → after-execute", () => {
    const trace = alignReasoningTrace(
      [turn(1, [DESCRIBE]), turn(2, [EXECUTE]), turn(3, [SEARCH])],
      [toolCall(DESCRIBE, 1), toolCall(EXECUTE, 2), toolCall(SEARCH, 3)],
    );
    expect(trace.map((t) => t.phase)).toEqual(["jit-decision", "jit-execute", "after-execute"]);
  });

  test("never-JIT：全程业务工具 → 全 before-jit", () => {
    const trace = alignReasoningTrace(
      [turn(1, [SEARCH]), turn(2, [SEARCH])],
      [toolCall(SEARCH, 1), toolCall(SEARCH, 2)],
    );
    expect(trace.map((t) => t.phase)).toEqual(["before-jit", "before-jit"]);
  });

  test("空 reasoningTurns → 空数组", () => {
    expect(alignReasoningTrace([], [toolCall(SEARCH, 1)])).toEqual([]);
  });

  test("同轮既有 describe 又有 execute → 归为 jit-execute（execute 优先）", () => {
    const trace = alignReasoningTrace(
      [turn(1, [DESCRIBE, EXECUTE])],
      [toolCall(DESCRIBE, 1), toolCall(EXECUTE, 1)],
    );
    expect(trace[0]!.phase).toBe("jit-execute");
  });
});
