import { describe, expect, test } from "vitest";
import { validateR7Report } from "../src/experiments/r7ValidateReport.js";

function report(overrides: Record<string, unknown> = {}): Parameters<typeof validateR7Report>[0] {
  const arms = ["C0", "T0", "T1", "T2", "T3", "T4", "P0"];
  return {
    mode: "r7-routing-discovery",
    config: { task: "B", arms, samples: 2, rounds: 10 },
    armDefs: arms.map((id) => ({ id })),
    runs: arms.flatMap((r7Arm) => [
      { r7Arm, taskId: "B", sampleIndex: 1 },
      { r7Arm, taskId: "B", sampleIndex: 2 },
    ]),
    ...overrides,
  };
}

describe("R7 report 完整性校验（决策前强制门）", () => {
  test("完整报告通过", () => {
    expect(validateR7Report(report())).toEqual({ valid: true, issues: [] });
  });

  test("缺样本、重复 sampleIndex、非法 arm/task 都会报 error", () => {
    const bad = report({
      runs: [
        { r7Arm: "T0", taskId: "B", sampleIndex: 1 },
        { r7Arm: "T0", taskId: "B", sampleIndex: 1 },
        { r7Arm: "T0", taskId: "A", sampleIndex: 2 },
        { r7Arm: "NOPE", taskId: "B", sampleIndex: 3 },
      ],
    });
    const result = validateR7Report(bad);
    expect(result.valid).toBe(false);
    const messages = result.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("重复 sampleIndex=1");
    expect(messages).toContain("不在 config.task=B");
    expect(messages).toContain("缺少合法 r7Arm");
    expect(messages).toContain("应有 2 个 run");
  });

  test("mode 或 samples 不合法直接失败", () => {
    expect(validateR7Report(report({ mode: "r5-autonomous-offloading" })).valid).toBe(false);
    expect(validateR7Report(report({ config: { task: "B", samples: 0, arms: ["T0"] } })).valid).toBe(false);
  });
});
