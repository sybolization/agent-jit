import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { R5_TASKS, type R5TaskId } from "../src/experiments/r5Tasks.js";
import {
  parseR6EagerFlags,
  buildR6EagerCells,
  writeR6EagerReport,
  R6_EAGER_CONTRACT_MODE,
  type R6EagerConfig,
} from "../src/experiments/r6EagerSignatureBenchmark.js";
import type { R5Arm, R5RunMetrics } from "../src/experiments/r5OffloadingBenchmark.js";

/**
 * baseMetrics 与 r6DescribeBenchmark.test.ts 内的同名 helper 同构（该 helper 未导出，
 * 这里本地复制最小默认形状；R6 可选字段均可不填，因为 aggregateR5 只读有定义值的字段）。
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

describe("r6EagerSignatureBenchmark — R6_EAGER_CONTRACT_MODE", () => {
  test("A→eager、B→eager-signatures", () => {
    expect(R6_EAGER_CONTRACT_MODE.A).toBe("eager");
    expect(R6_EAGER_CONTRACT_MODE.B).toBe("eager-signatures");
  });
});

describe("r6EagerSignatureBenchmark — parseR6EagerFlags", () => {
  test("默认：arm=all / samples=1 / rounds=10", () => {
    expect(parseR6EagerFlags([])).toEqual({ arm: "all", samples: 1, rounds: 10 });
  });

  test("解析 --arm / --samples / --rounds", () => {
    expect(parseR6EagerFlags(["--arm=B", "--samples=20", "--rounds=5"])).toEqual({
      arm: "B",
      samples: 20,
      rounds: 5,
    });
  });

  test("非法 --arm 抛错", () => {
    expect(() => parseR6EagerFlags(["--arm=X"])).toThrow(/--arm 必须是 A\|B\|all/);
  });
});

describe("r6EagerSignatureBenchmark — buildR6EagerCells 两臂分区", () => {
  const config: R6EagerConfig = { arm: "all", samples: 1, rounds: 10, boundaryPolicy: true, stopAfterSubmit: true };
  const runs: R5RunMetrics[] = [
    baseMetrics({ arm: "control", taskId: "B" }),
    baseMetrics({ arm: "treatment", taskId: "A", contractMode: "eager" }),
    baseMetrics({
      arm: "treatment", taskId: "B", contractMode: "eager",
      tokens: { input: 100, output: 50, cacheRead: 0, total: 400 },
    }),
    baseMetrics({
      arm: "treatment", taskId: "B", contractMode: "eager-signatures",
      tokens: { input: 200, output: 100, cacheRead: 0, total: 900 },
    }),
  ];

  test("只计入 arm=treatment 且 taskId=B 且 contractMode 匹配的 run", () => {
    const cells = buildR6EagerCells(runs, config);
    expect(cells.A.runs).toHaveLength(1);
    expect(cells.B.runs).toHaveLength(1);
    expect(cells.A.runs[0]!.contractMode).toBe("eager");
    expect(cells.B.runs[0]!.contractMode).toBe("eager-signatures");
  });

  test("每格独立聚合：A 格 avgTokens 只来自 eager run；control / A-task run 不计入", () => {
    const cells = buildR6EagerCells(runs, config);
    expect(cells.A.aggregate.runs).toBe(1);
    expect(cells.B.aggregate.runs).toBe(1);
    expect(cells.A.aggregate.avgTokens).toBe(400);
    expect(cells.B.aggregate.avgTokens).toBe(900);
    expect(cells.A.jitGroups.reduce((sum, group) => sum + group.runs, 0)).toBe(1);
    expect(cells.B.jitGroups.reduce((sum, group) => sum + group.runs, 0)).toBe(1);
  });
});

describe("r6EagerSignatureBenchmark — writeR6EagerReport", () => {
  test("写入 report.json：mode=r6-eager-signature、model=deepseek-v4-flash、cells 含 A/B 且不重复序列化 runs", () => {
    const runs: R5RunMetrics[] = [
      baseMetrics({
        arm: "treatment", taskId: "B", contractMode: "eager",
        tokens: { input: 100, output: 50, cacheRead: 0, total: 400 },
      }),
      baseMetrics({
        arm: "treatment", taskId: "B", contractMode: "eager-signatures",
        tokens: { input: 200, output: 100, cacheRead: 0, total: 900 },
      }),
    ];
    const config: R6EagerConfig = { arm: "all", samples: 1, rounds: 10, boundaryPolicy: true, stopAfterSubmit: true };
    const cells = buildR6EagerCells(runs, config);
    const outDir = path.join(os.tmpdir(), `r6-eager-report-test-${Date.now()}`);
    const reportPath = writeR6EagerReport(outDir, config, R5_TASKS, cells, runs);
    try {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        model: string;
        cells: Record<string, { contractMode: string; aggregate: { runs: number }; runs?: unknown }>;
        runs: unknown[];
      };
      expect(report.mode).toBe("r6-eager-signature");
      expect(report.model).toBe("deepseek-v4-flash");
      expect(Object.keys(report.cells)).toEqual(["A", "B"]);
      expect(report.cells.A.contractMode).toBe("eager");
      expect(report.cells.B.contractMode).toBe("eager-signatures");
      expect(report.cells.A.aggregate.runs).toBe(1);
      expect(report.cells.B.aggregate.runs).toBe(1);
      expect(report.cells.A.runs).toBeUndefined();
      expect(report.cells.B.runs).toBeUndefined();
      expect(report.runs).toHaveLength(2);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
