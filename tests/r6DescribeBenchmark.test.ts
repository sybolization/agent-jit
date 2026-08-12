import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { R5_TASKS, type R5TaskId } from "../src/experiments/r5Tasks.js";
import {
  parseR6Flags,
  buildR6Cells,
  writeR6Report,
  R6_ARM_CONTRACT_MODE,
} from "../src/experiments/r6DescribeBenchmark.js";
import type { R5Arm, R5RunMetrics } from "../src/experiments/r5OffloadingBenchmark.js";

/**
 * baseMetrics 与 r5OffloadingBenchmark.test.ts 内的同名 helper 同构（该 helper 未导出，
 * 这里本地复制最小默认形状；新 R6 可选字段均可不填，因为 aggregateR5 只读有定义值的字段）。
 */
const baseMetrics = (
  overrides: Partial<R5RunMetrics> & { arm: R5Arm; taskId: R5TaskId },
): R5RunMetrics => ({
  rounds: 3,
  maxedOut: false,
  tokens: { input: 1, output: 1, cacheRead: 0, total: 2 },
  latencyMs: 0,
  toolTimeline: [],
  businessCalls: [],
  describeCalls: 0,
  executeCalls: 0,
  jitAttempted: false,
  jitExecutionSucceeded: false,
  jitSemanticCorrect: undefined,
  jitFinishedWithoutFallback: false,
  fallbackUsed: false,
  preOffloadBusinessCalls: [],
  preOffloadBusinessCallCount: 0,
  sameRoundBusinessCalls: [],
  sameRoundBusinessCallCount: 0,
  postExecuteBusinessCalls: [],
  postExecuteBusinessCallCount: 0,
  timelyOffload: undefined,
  answerCorrect: true,
  taskCompleted: true,
  finalText: "",
  ...overrides,
});

describe("r6DescribeBenchmark — parseR6Flags", () => {
  test("默认：arm=all / task=all / samples=1 / rounds=10 / stopAfterSubmit=false", () => {
    expect(parseR6Flags([])).toEqual({ arm: "all", task: "all", samples: 1, rounds: 10, stopAfterSubmit: false });
  });

  test("解析 --arm / --task / --samples / --stop-after-submit", () => {
    expect(parseR6Flags(["--arm=B", "--task=B", "--samples=20", "--stop-after-submit"])).toEqual({
      arm: "B",
      task: "B",
      samples: 20,
      rounds: 10,
      stopAfterSubmit: true,
    });
  });

  test("非法 --arm 抛错", () => {
    expect(() => parseR6Flags(["--arm=X"])).toThrow(/--arm 必须是 A\|B\|C\|all/);
  });
});

describe("r6DescribeBenchmark — buildR6Cells 三臂 + control 分区", () => {
  const runs: R5RunMetrics[] = [
    baseMetrics({ arm: "control", taskId: "B", tokens: { input: 100, output: 50, cacheRead: 0, total: 150 } }),
    baseMetrics({
      arm: "treatment", taskId: "B", contractMode: "eager-describe",
      tokens: { input: 100, output: 50, cacheRead: 0, total: 400 },
    }),
    baseMetrics({
      arm: "treatment", taskId: "B", contractMode: "compile-first",
      tokens: { input: 200, output: 100, cacheRead: 0, total: 2000 },
    }),
    baseMetrics({
      arm: "treatment", taskId: "B", contractMode: "compact-manifest",
      tokens: { input: 300, output: 150, cacheRead: 0, total: 5000 },
    }),
  ];
  const config = { arm: "all" as const, task: "B" as const, samples: 1, rounds: 10, stopAfterSubmit: false };

  test("control/A/B/C 四格各 1 个 run，按 arm + contractMode 分区（R6_ARM_CONTRACT_MODE 映射一致）", () => {
    const cells = buildR6Cells(runs, config);
    expect(cells.control.runs).toHaveLength(1);
    expect(cells.A.runs).toHaveLength(1);
    expect(cells.B.runs).toHaveLength(1);
    expect(cells.C.runs).toHaveLength(1);
    expect(cells.A.runs[0]!.contractMode).toBe("eager-describe");
    expect(cells.B.runs[0]!.contractMode).toBe("compile-first");
    expect(cells.C.runs[0]!.contractMode).toBe("compact-manifest");
    expect(R6_ARM_CONTRACT_MODE.A).toBe("eager-describe");
    expect(R6_ARM_CONTRACT_MODE.B).toBe("compile-first");
    expect(R6_ARM_CONTRACT_MODE.C).toBe("compact-manifest");
  });

  test("每格用自己格内 runs 独立聚合：A 格 aggregate.runs=1；B 格 avgTokens 等于该 run 的 tokens.total", () => {
    const cells = buildR6Cells(runs, config);
    expect(cells.A.aggregate.runs).toBe(1);
    expect(cells.B.aggregate.runs).toBe(1);
    expect(cells.B.aggregate.avgTokens).toBe(2000);
    expect(cells.C.aggregate.avgTokens).toBe(5000);
    expect(cells.B.jitGroups.reduce((sum, group) => sum + group.runs, 0)).toBe(1);
  });
});

describe("r6DescribeBenchmark — writeR6Report", () => {
  test("写入 report.json：mode / config 记录 arm / cells（control+A/B/C）/ 全部 runs", () => {
    const runs: R5RunMetrics[] = [
      baseMetrics({ arm: "control", taskId: "B", tokens: { input: 100, output: 50, cacheRead: 0, total: 150 } }),
      baseMetrics({
        arm: "treatment", taskId: "B", contractMode: "eager-describe",
        tokens: { input: 100, output: 50, cacheRead: 0, total: 400 },
      }),
      baseMetrics({
        arm: "treatment", taskId: "B", contractMode: "compile-first",
        tokens: { input: 200, output: 100, cacheRead: 0, total: 2000 },
      }),
      baseMetrics({
        arm: "treatment", taskId: "B", contractMode: "compact-manifest",
        tokens: { input: 300, output: 150, cacheRead: 0, total: 5000 },
      }),
    ];
    const cells = buildR6Cells(runs, { arm: "all", task: "B", samples: 1, rounds: 10, stopAfterSubmit: false });
    const outDir = path.join(os.tmpdir(), `r6-report-test-${Date.now()}`);
    const reportPath = writeR6Report(
      outDir,
      { arm: "all", task: "B", samples: 1, rounds: 10, stopAfterSubmit: false },
      R5_TASKS,
      cells,
      runs,
    );
    try {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        config: { arm: string; task: string };
        cells: Record<string, { contractMode: string; aggregate: { runs: number } }>;
        runs: unknown[];
      };
      expect(report.mode).toBe("r6-contract-discovery");
      expect(report.config).toMatchObject({ arm: "all", task: "B" });
      expect(Object.keys(report.cells)).toEqual(["control", "A", "B", "C"]);
      expect(report.cells.A.contractMode).toBe("eager-describe");
      expect(report.cells.B.contractMode).toBe("compile-first");
      expect(report.cells.C.contractMode).toBe("compact-manifest");
      expect(report.cells.control.aggregate.runs).toBe(1);
      expect(report.runs).toHaveLength(4);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
