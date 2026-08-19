import { describe, expect, test } from "vitest";
import {
  decideR7Development,
  decideR7Holdout,
  evaluateR7CrossModelPrecision,
  R7_CONSTANT_DESCRIPTION_CHARS,
  R7_DEVELOPMENT_RULES,
  R7_HOLDOUT_RULES,
  type R7CellSummary,
} from "../src/experiments/r7Decision.js";

function cell(overrides: Partial<R7CellSummary>): R7CellSummary {
  return {
    armId: "T0",
    taskId: "B",
    runs: 20,
    taskCompletionRate: 1,
    offloadPrecision: 1,
    efficiencyScore: 100,
    unnecessaryOffloadRate: 0,
    avgTokens: 100,
    ...overrides,
  };
}

describe("R7 development 预注册决策规则", () => {
  test("门槛不过（completion 或 precision < 0.9）→ system-prompt-required", () => {
    const decision = decideR7Development([
      cell({ armId: "T0", taskCompletionRate: 0.95, offloadPrecision: 0, efficiencyScore: 10 }),
      cell({ armId: "T1", taskCompletionRate: 0.8, offloadPrecision: 1, efficiencyScore: 20 }),
    ]);
    expect(decision.eligibleArmIds).toEqual([]);
    expect(decision.winnerArmId).toBeUndefined();
    expect(decision.conclusion).toBe("system-prompt-required");
  });

  test("efficiencyScore 最低的 T 臂胜出；P0/C0 只作参照不作为候选", () => {
    const decision = decideR7Development([
      cell({ armId: "P0", efficiencyScore: 90 }),
      cell({ armId: "C0", efficiencyScore: 50 }),
      cell({ armId: "T1", efficiencyScore: 110 }),
      cell({ armId: "T3", efficiencyScore: 100 }),
    ]);
    expect(decision.eligibleArmIds).toContain("T1");
    expect(decision.winnerArmId).toBe("T3");
    expect(decision.conclusion).toBe("holdout-pending");
    expect(decision.positiveControlEfficiency).toBe(90);
  });

  test("与最优效率差距 < 5% 时，选常驻描述更短的臂", () => {
    const decision = decideR7Development([
      cell({ armId: "T1", efficiencyScore: 102 }),
      cell({ armId: "T4", efficiencyScore: 100 }),
    ]);
    expect(decision.winnerArmId).toBe("T1");
    expect(R7_CONSTANT_DESCRIPTION_CHARS.T1).toBeLessThan(R7_CONSTANT_DESCRIPTION_CHARS.T4);
  });

  test("效率差距 >= 5% 时，不因描述长度翻盘", () => {
    const decision = decideR7Development([
      cell({ armId: "T1", efficiencyScore: 106 }),
      cell({ armId: "T4", efficiencyScore: 100 }),
    ]);
    expect(decision.winnerArmId).toBe("T4");
  });

  test("规则常量冻结：任何改动都会显式破坏测试", () => {
    expect(R7_DEVELOPMENT_RULES).toEqual({
      minTaskCompletionRate: 0.9,
      minOffloadPrecision: 0.9,
      efficiencyTieTolerance: 0.05,
      candidateArmIds: ["T0", "T1", "T2", "T3", "T4"],
    });
  });
});

describe("R7 holdout 预注册判定规则", () => {
  test("winner 在 H 上过 0.9/0.9 门槛且 efficiency <= P0 → recommend-default", () => {
    const decision = decideR7Holdout(
      [
        cell({ taskId: "H", armId: "T3", efficiencyScore: 95, taskCompletionRate: 1, offloadPrecision: 1 }),
        cell({ taskId: "H", armId: "P0", efficiencyScore: 100, taskCompletionRate: 1, offloadPrecision: 1 }),
      ],
      "T3",
    );
    expect(decision.gatePass).toBe(true);
    expect(decision.efficiencyNotWorseThanP0).toBe(true);
    expect(decision.conclusion).toBe("recommend-default");
  });

  test("winner efficiency 劣于 P0 → reject（即使完成率/precision 全过门槛）", () => {
    const decision = decideR7Holdout(
      [
        cell({ taskId: "H", armId: "T3", efficiencyScore: 110, taskCompletionRate: 1, offloadPrecision: 1 }),
        cell({ taskId: "H", armId: "P0", efficiencyScore: 100, taskCompletionRate: 1, offloadPrecision: 1 }),
      ],
      "T3",
    );
    expect(decision.conclusion).toBe("reject");
    expect(decision.reasons.join(",")).toContain("劣于 P0");
  });

  test("winner 未过 H 门槛 → reject；缺 H cell → data-incomplete", () => {
    const weak = decideR7Holdout(
      [
        cell({ taskId: "H", armId: "T3", taskCompletionRate: 0.8, offloadPrecision: 1, efficiencyScore: 10 }),
        cell({ taskId: "H", armId: "P0", efficiencyScore: 100 }),
      ],
      "T3",
    );
    expect(weak.conclusion).toBe("reject");

    const incomplete = decideR7Holdout([], "T3");
    expect(incomplete.conclusion).toBe("data-incomplete");
  });

  test("跨模型抽检 precision 阈值冻结为 0.9", () => {
    expect(evaluateR7CrossModelPrecision(0.9)).toBe("pass");
    expect(evaluateR7CrossModelPrecision(0.89)).toBe("blocked");
    expect(R7_HOLDOUT_RULES).toEqual({
      minTaskCompletionRate: 0.9,
      minOffloadPrecision: 0.9,
      minCrossModelPrecision: 0.9,
    });
  });
});
