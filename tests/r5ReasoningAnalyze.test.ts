import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  aggregateCauses,
  analyzeExperiment,
  analyzeRun,
  type CauseDistribution,
  type RunInput,
  type RunReasoningAnalysis,
  type RunReasoningLabel,
} from "../src/experiments/r5ReasoningAnalyze.js";

// ---------------------------------------------------------------------------
// analyzeRun —— run + label 合并与 lag 计算（纯函数，不跑模型）
// ---------------------------------------------------------------------------

const runWithAction: RunInput = {
  offloadDecisionRound: 2,
  phases: [
    { round: 1, phase: "before-jit" },
    { round: 2, phase: "jit-decision" },
  ],
};

describe("analyzeRun — 有 label 的合并与 lag 计算", () => {
  test("recognition=1 / consideration=1 / action=2 → recognitionToConsiderationLag=0、considerationToActionLag=1；jitActionRound 来自 offloadDecisionRound", () => {
    const label: RunReasoningLabel = {
      runId: "r5r-001",
      deterministicRecognitionRound: 1,
      jitConsiderationRound: 1,
      primaryCause: "recognition-late",
      labels: {
        deterministicPathRecognized: true,
        jitConsidered: true,
        jitSelected: true,
        dataUnknownBlocksOffload: false,
        semanticUncertainty: false,
        greedyProbe: false,
        jitOverheadConcern: false,
        pathTooShort: false,
        duplicateExecutionAwareness: false,
      },
    };
    const analysis = analyzeRun(runWithAction, label);
    expect(analysis.runId).toBe("r5r-001");
    expect(analysis.jitActionRound).toBe(2);
    expect(analysis.deterministicRecognitionRound).toBe(1);
    expect(analysis.jitConsiderationRound).toBe(1);
    expect(analysis.recognitionToConsiderationLag).toBe(0);
    expect(analysis.considerationToActionLag).toBe(1);
    expect(analysis.primaryCause).toBe("recognition-late");
    expect(analysis.labels).toEqual(label.labels);
  });
});

describe("analyzeRun — 无 label", () => {
  test("lag / label 合并字段均不出现；phases 透传正确；jitActionRound 仍来自 offloadDecisionRound", () => {
    const analysis = analyzeRun(runWithAction);
    expect(analysis.jitActionRound).toBe(2);
    expect(analysis.phases).toEqual(runWithAction.phases);
    for (const key of [
      "deterministicRecognitionRound",
      "jitConsiderationRound",
      "recognitionToConsiderationLag",
      "considerationToActionLag",
      "primaryCause",
      "labels",
    ] as const) {
      expect(key in analysis).toBe(false);
    }
  });
});

describe("analyzeRun — 只有 recognition 无 consideration", () => {
  test("两个 lag 都 undefined（不出现）", () => {
    const analysis = analyzeRun(runWithAction, {
      runId: "r5r-001",
      deterministicRecognitionRound: 1,
    });
    expect(analysis.deterministicRecognitionRound).toBe(1);
    expect("jitConsiderationRound" in analysis).toBe(false);
    expect("recognitionToConsiderationLag" in analysis).toBe(false);
    expect("considerationToActionLag" in analysis).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregateCauses —— 五键固定的 cause 计数（纯函数）
// ---------------------------------------------------------------------------

describe("aggregateCauses — 五键固定的 cause 计数", () => {
  test("3 个带 cause + 1 个无 cause → 五键齐全，未出现键计 0", () => {
    const analysis = (runId: string, primaryCause?: RunReasoningAnalysis["primaryCause"]): RunReasoningAnalysis => ({
      runId,
      ...(primaryCause !== undefined ? { primaryCause } : {}),
      phases: [],
    });
    const analyses = [
      analysis("r5r-001", "recognition-late"),
      analysis("r5r-002", "data-uncertainty-blocker"),
      analysis("r5r-003", "recognition-late"),
      analysis("r5r-004"),
    ];
    const distribution: CauseDistribution = {
      "recognition-late": 2,
      "data-uncertainty-blocker": 1,
      "jit-selection-late": 0,
      "greedy-speculative": 0,
      "economic-rejection": 0,
    };
    expect(aggregateCauses(analyses)).toEqual(distribution);
  });
});

// ---------------------------------------------------------------------------
// analyzeExperiment —— 读目录 → 合并 → 写 reasoning-analysis.json（端到端，不跑模型）
// ---------------------------------------------------------------------------

describe("analyzeExperiment — report.json + labels.json → reasoning-analysis.json", () => {
  test("合并人工 label、生成 runId、五类分布、缩进 2 与末尾换行", () => {
    const dir = path.join(os.tmpdir(), `r5-reasoning-analyze-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(dir, "report.json"),
        JSON.stringify({
          runs: [
            {
              offloadDecisionRound: 2,
              phases: [
                { round: 1, phase: "before-jit" },
                { round: 2, phase: "jit-decision", toolCalls: ["jit_describe_tools"] },
              ],
            },
            // 无 offload、无 label 的 run（验证 runId 按 runs 下标生成、cause 不计入）
            { phases: [{ round: 1, phase: "before-jit" }] },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(dir, "labels.json"),
        JSON.stringify([
          {
            runId: "r5r-001",
            deterministicRecognitionRound: 1,
            jitConsiderationRound: 1,
            primaryCause: "recognition-late",
          },
        ]),
      );

      const outputPath = analyzeExperiment(dir, path.join(dir, "labels.json"));
      expect(outputPath).toBe(path.join(dir, "reasoning-analysis.json"));

      const content = fs.readFileSync(outputPath, "utf8");
      expect(content.endsWith("\n")).toBe(true); // 末尾换行
      const result = JSON.parse(content) as {
        analyses: Array<Record<string, unknown>>;
        causeDistribution: CauseDistribution;
      };

      // runs[0]（r5r-001）：label 合并 + lag 计算
      expect(result.analyses).toHaveLength(2);
      expect(result.analyses[0]).toEqual({
        runId: "r5r-001",
        jitActionRound: 2,
        phases: [
          { round: 1, phase: "before-jit" },
          { round: 2, phase: "jit-decision", toolCalls: ["jit_describe_tools"] },
        ],
        deterministicRecognitionRound: 1,
        jitConsiderationRound: 1,
        recognitionToConsiderationLag: 0,
        considerationToActionLag: 1,
        primaryCause: "recognition-late",
      });
      // runs[1]（r5r-002）：无 label → runId 按下标生成、无 lag/label 字段
      expect(result.analyses[1]).toEqual({
        runId: "r5r-002",
        phases: [{ round: 1, phase: "before-jit" }],
      });
      expect(result.causeDistribution).toEqual({
        "recognition-late": 1,
        "data-uncertainty-blocker": 0,
        "jit-selection-late": 0,
        "greedy-speculative": 0,
        "economic-rejection": 0,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
