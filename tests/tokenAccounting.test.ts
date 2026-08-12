import { describe, expect, test } from "vitest";

import type { AgentTokenRound } from "../src/experiments/agentRunner.js";
import {
  classifyAtomicStage,
  classifyTokenRound,
  sumAtomicStagesByStage,
  sumTokenRoundsByPhase,
} from "../src/experiments/tokenAccounting.js";

describe("classifyTokenRound — 机械 phase 分类", () => {
  test("各 phase 识别：atomic / jit-describe / jit-program / submission / finalization", () => {
    expect(classifyTokenRound(["github_get_repository"])).toBe("atomic-execution");
    expect(classifyTokenRound(["jit_describe_tools"])).toBe("jit-describe");
    expect(classifyTokenRound(["jit_execute_program"])).toBe("jit-program");
    expect(classifyTokenRound(["submit_answer"])).toBe("submission");
    expect(classifyTokenRound([])).toBe("finalization");
  });

  test("mixed 不硬分：jit + 业务工具 / jit + jit 同轮都判 mixed", () => {
    expect(classifyTokenRound(["jit_describe_tools", "github_search_repositories"])).toBe("mixed");
    expect(classifyTokenRound(["jit_describe_tools", "jit_execute_program"])).toBe("mixed");
    expect(classifyTokenRound(["submit_answer", "github_get_repository"])).toBe("mixed");
  });

  test("同一桶内多个工具不判 mixed", () => {
    expect(classifyTokenRound(["github_get_repository", "github_search_repositories"])).toBe("atomic-execution");
  });
});

describe("sumTokenRoundsByPhase — 按 phase 累计 token 分项", () => {
  const round = (toolCalls: readonly string[], input: number, cacheRead: number, output: number): AgentTokenRound => ({
    round: 1,
    input,
    cacheRead,
    output,
    total: input + cacheRead + output,
    toolCalls,
  });

  test("各 phase 累计正确，每轮唯一归类", () => {
    const tokenRounds: AgentTokenRound[] = [
      round(["jit_describe_tools"], 10, 100, 5),
      round(["jit_execute_program"], 20, 200, 10),
      round([], 30, 0, 15),
      round(["jit_describe_tools", "github_search_repositories"], 40, 0, 20),
    ];
    const sums = sumTokenRoundsByPhase(tokenRounds);
    expect(sums["jit-describe"]).toEqual({ input: 10, cacheRead: 100, output: 5, total: 115 });
    expect(sums["jit-program"]).toEqual({ input: 20, cacheRead: 200, output: 10, total: 230 });
    expect(sums.finalization).toEqual({ input: 30, cacheRead: 0, output: 15, total: 45 });
    expect(sums.mixed).toEqual({ input: 40, cacheRead: 0, output: 20, total: 60 });
    expect(sums["atomic-execution"]).toEqual({ input: 0, cacheRead: 0, output: 0, total: 0 });
    expect(sums.submission).toEqual({ input: 0, cacheRead: 0, output: 0, total: 0 });
  });

  test("空数组返回全 0", () => {
    const sums = sumTokenRoundsByPhase([]);
    expect(sums["atomic-execution"]).toEqual({ input: 0, cacheRead: 0, output: 0, total: 0 });
    expect(sums.mixed).toEqual({ input: 0, cacheRead: 0, output: 0, total: 0 });
  });
});

describe("Atomic stage 分类（Control 成本结构）", () => {
  test("classifyAtomicStage 各映射 + other 兜底", () => {
    expect(classifyAtomicStage("github_search_repositories")).toBe("search");
    expect(classifyAtomicStage("github_get_repository")).toBe("details");
    expect(classifyAtomicStage("github_get_contributor_stats")).toBe("scoring");
    expect(classifyAtomicStage("github_list_commits")).toBe("scoring");
    expect(classifyAtomicStage("unknown_tool")).toBe("other");
  });

  test("sumAtomicStagesByStage：atomic 轮按首个业务工具唯一归类", () => {
    const tokenRounds: AgentTokenRound[] = [
      { round: 1, input: 10, cacheRead: 100, output: 5, total: 115, toolCalls: ["github_search_repositories"] },
      { round: 2, input: 20, cacheRead: 200, output: 10, total: 230, toolCalls: ["github_get_repository", "github_get_repository"] },
      { round: 3, input: 30, cacheRead: 0, output: 15, total: 45, toolCalls: ["jit_execute_program"] }, // 非 atomic，跳过
      { round: 4, input: 40, cacheRead: 0, output: 20, total: 60, toolCalls: ["github_list_commits"] },
    ];
    const sums = sumAtomicStagesByStage(tokenRounds);
    expect(sums.search.total).toBe(115);
    expect(sums.details.total).toBe(230);
    expect(sums.scoring.total).toBe(60);
    expect(sums.other.total).toBe(0);
  });
});
