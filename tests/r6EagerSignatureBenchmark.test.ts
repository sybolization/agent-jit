import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { R5_TASKS, type R5TaskId } from "../src/experiments/r5Tasks.js";
import {
  parseR6EagerFlags,
  buildR6EagerCells,
  writeR6EagerReport,
  computeR6EagerTax,
  R6_EAGER_CELLS,
  type R6EagerConfig,
  type R6EagerCellId,
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

describe("r6EagerSignatureBenchmark — R6_EAGER_CELLS 2×2 映射", () => {
  test("task × contract delivery 正确", () => {
    expect(R6_EAGER_CELLS["A-eager"]).toMatchObject({ taskId: "A", contractMode: "eager" });
    expect(R6_EAGER_CELLS["A-sig"]).toMatchObject({ taskId: "A", contractMode: "eager-signatures" });
    expect(R6_EAGER_CELLS["B-eager"]).toMatchObject({ taskId: "B", contractMode: "eager" });
    expect(R6_EAGER_CELLS["B-sig"]).toMatchObject({ taskId: "B", contractMode: "eager-signatures" });
  });
});

describe("r6EagerSignatureBenchmark — parseR6EagerFlags", () => {
  test("默认：cell=all / samples=1 / rounds=10", () => {
    expect(parseR6EagerFlags([])).toEqual({ cell: "all", samples: 1, rounds: 10, reasoning: false });
  });

  test("解析 --cell / --samples / --rounds", () => {
    expect(parseR6EagerFlags(["--cell=B-sig", "--samples=20", "--rounds=5", "--reasoning"])).toEqual({
      cell: "B-sig",
      samples: 20,
      rounds: 5,
      reasoning: true,
    });
  });

  test("非法 --cell 抛错", () => {
    expect(() => parseR6EagerFlags(["--cell=X"])).toThrow(/--cell 必须是 A-eager\|A-sig\|B-eager\|B-sig\|all/);
  });
});

describe("r6EagerSignatureBenchmark — buildR6EagerCells 2×2 分区", () => {
  const config: R6EagerConfig = { cell: "all", samples: 1, rounds: 10, boundaryPolicy: true, stopAfterSubmit: true };
  const runs: R5RunMetrics[] = [
    baseMetrics({ arm: "control", taskId: "B" }),
    baseMetrics({ arm: "treatment", taskId: "A", contractMode: "eager", tokens: { input: 1, output: 1, cacheRead: 0, total: 100 } }),
    baseMetrics({ arm: "treatment", taskId: "A", contractMode: "eager-signatures", tokens: { input: 1, output: 1, cacheRead: 0, total: 150 } }),
    baseMetrics({ arm: "treatment", taskId: "B", contractMode: "eager", tokens: { input: 1, output: 1, cacheRead: 0, total: 400 } }),
    baseMetrics({ arm: "treatment", taskId: "B", contractMode: "eager-signatures", tokens: { input: 1, output: 1, cacheRead: 0, total: 900 } }),
  ];

  test("四格各自独立分区：只计入 arm=treatment 且 taskId/contractMode 匹配的 run", () => {
    const cells = buildR6EagerCells(runs, config);
    const ids: R6EagerCellId[] = ["A-eager", "A-sig", "B-eager", "B-sig"];
    for (const id of ids) {
      expect(cells[id].runs).toHaveLength(1);
      expect(cells[id].runs[0]!.contractMode).toBe(R6_EAGER_CELLS[id].contractMode);
      expect(cells[id].runs[0]!.taskId).toBe(R6_EAGER_CELLS[id].taskId);
    }
  });

  test("每格独立聚合：control run 不计入，A/B 格 avgTokens 正确", () => {
    const cells = buildR6EagerCells(runs, config);
    expect(cells["A-eager"].aggregate.avgTokens).toBe(100);
    expect(cells["A-sig"].aggregate.avgTokens).toBe(150);
    expect(cells["B-eager"].aggregate.avgTokens).toBe(400);
    expect(cells["B-sig"].aggregate.avgTokens).toBe(900);
  });

  test("computeR6EagerTax：A tax=+50，B savings=+500（负 savings 表示 sig 更贵）", () => {
    const cells = buildR6EagerCells(runs, config);
    expect(computeR6EagerTax(cells)).toEqual({
      aTaxTokens: 50,
      bSavingsTokens: -500,
      bSavingsRounds: 0,
    });
  });
});

describe("r6EagerSignatureBenchmark — writeR6EagerReport", () => {
  test("写入 report.json：mode/model 正确、cells 含四格、不重复序列化 runs", () => {
    const runs: R5RunMetrics[] = [
      baseMetrics({ arm: "treatment", taskId: "A", contractMode: "eager", tokens: { input: 1, output: 1, cacheRead: 0, total: 100 } }),
      baseMetrics({ arm: "treatment", taskId: "A", contractMode: "eager-signatures", tokens: { input: 1, output: 1, cacheRead: 0, total: 150 } }),
      baseMetrics({ arm: "treatment", taskId: "B", contractMode: "eager", tokens: { input: 1, output: 1, cacheRead: 0, total: 400 } }),
      baseMetrics({ arm: "treatment", taskId: "B", contractMode: "eager-signatures", tokens: { input: 1, output: 1, cacheRead: 0, total: 900 } }),
    ];
    const config: R6EagerConfig = { cell: "all", samples: 1, rounds: 10, boundaryPolicy: true, stopAfterSubmit: true };
    const cells = buildR6EagerCells(runs, config);
    const outDir = path.join(os.tmpdir(), `r6-eager-report-test-${Date.now()}`);
    const reportPath = writeR6EagerReport(outDir, config, R5_TASKS, cells, runs);
    try {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        model: string;
        cells: Record<string, { taskId: string; contractMode: string; aggregate: { runs: number }; runs?: unknown }>;
        runs: unknown[];
      };
      expect(report.mode).toBe("r6-eager-signature");
      expect(report.model).toBe("deepseek-v4-flash");
      expect(Object.keys(report.cells)).toEqual(["A-eager", "A-sig", "B-eager", "B-sig"]);
      expect(report.cells["A-eager"].taskId).toBe("A");
      expect(report.cells["A-sig"].contractMode).toBe("eager-signatures");
      expect(report.cells["B-eager"].aggregate.runs).toBe(1);
      expect(report.cells["B-sig"].aggregate.runs).toBe(1);
      expect(report.cells["A-eager"].runs).toBeUndefined();
      expect(report.cells["B-sig"].runs).toBeUndefined();
      expect(report.runs).toHaveLength(4);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
