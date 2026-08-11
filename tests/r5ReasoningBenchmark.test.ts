import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { buildR5Aggregates } from "../src/experiments/r5OffloadingBenchmark.js";
import {
  buildReasoningValidityAggregates,
  interleavedReasoningOrder,
  parseFlags,
  validityRunId,
  writeReasoningTraceFile,
  writeR5ReasoningReport,
  writeR5ReasoningValidityReport,
  type R5ReasoningRun,
  type R5ReasoningValidityRun,
  type ReasoningTraceLine,
} from "../src/experiments/r5ReasoningBenchmark.js";
import { R5_TASKS } from "../src/experiments/r5Tasks.js";

// ---------------------------------------------------------------------------
// writeReasoningTraceFile —— raw CoT 落盘门控（纯函数，不跑模型）
// ---------------------------------------------------------------------------

const traceLine: ReasoningTraceLine = {
  runId: "r5r-001",
  round: 1,
  phase: "jit-decision",
  reasoning: "这段后续工作是确定性流水线，用 JIT 一次写完更省轮次",
  toolCalls: ["jit_describe_tools"],
  text: "先看下工具契约",
};

describe("writeReasoningTraceFile — raw CoT 落盘门控", () => {
  test("enabled=true：文件存在、内容每行可 JSON.parse、字段齐全", () => {
    const dir = path.join(os.tmpdir(), `r5-reasoning-raw-test-${Date.now()}`);
    const filePath = writeReasoningTraceFile(dir, [traceLine], true);
    try {
      expect(filePath).toBe(path.join(dir, "traces.jsonl"));
      expect(fs.existsSync(filePath!)).toBe(true);
      const content = fs.readFileSync(filePath!, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(parsed).toEqual(traceLine);
      // 字段齐全
      for (const key of ["runId", "round", "phase", "reasoning", "toolCalls", "text"]) {
        expect(key in parsed).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enabled=false：返回 undefined、目录/文件不存在", () => {
    const dir = path.join(os.tmpdir(), `r5-reasoning-raw-disabled-${Date.now()}`);
    expect(writeReasoningTraceFile(dir, [traceLine], false)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "traces.jsonl"))).toBe(false);
  });

  test("lines=[] 且 enabled=true：返回 undefined、不创建文件", () => {
    const dir = path.join(os.tmpdir(), `r5-reasoning-raw-empty-${Date.now()}`);
    expect(writeReasoningTraceFile(dir, [], true)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("提供 meta：首行是 type=meta 的诊断元数据，其余行保持条目", () => {
    const dir = path.join(os.tmpdir(), `r5-reasoning-raw-meta-${Date.now()}`);
    const filePath = writeReasoningTraceFile(dir, [traceLine], true, {
      modelId: "deepseek-chat",
      reasoningMode: "thinking-blocks",
      thinkingLevel: "medium",
    });
    try {
      const content = fs.readFileSync(filePath!, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({
        type: "meta",
        modelId: "deepseek-chat",
        reasoningMode: "thinking-blocks",
        thinkingLevel: "medium",
      });
      expect(JSON.parse(lines[1]!)).toEqual(traceLine);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeR5ReasoningReport —— report 不含 reasoning 原文（纯函数，不跑模型）
// ---------------------------------------------------------------------------

/** R5ReasoningRun 构造辅助（phases 只含 round/phase/toolCalls，与真实产物同形）。 */
const reasoningRun = (overrides: Partial<R5ReasoningRun> = {}): R5ReasoningRun => ({
  arm: "treatment",
  taskId: "B",
  rounds: 3,
  maxedOut: false,
  tokens: { input: 100, output: 50, cacheRead: 0, total: 150 },
  latencyMs: 2000,
  toolTimeline: [{ name: "jit_describe_tools", isError: false, round: 1, arguments: {} }],
  businessCalls: [],
  describeCalls: 1,
  executeCalls: 0,
  jitAttempted: true,
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
  timelyOffload: false,
  answerCorrect: true,
  taskCompleted: true,
  finalText: "完成",
  reasoningTraceFile: "local:r5r-001",
  phases: [{ round: 1, phase: "jit-decision", toolCalls: ["jit_describe_tools"] }],
  ...overrides,
});

describe("writeR5ReasoningReport — report.json 不含 reasoning 原文", () => {
  test("runs 无 reasoning/reasoningTurns 字段、固定 config（task=B/arm=treatment/dslGuidance=primitive/policy=current）、model 元数据齐全", () => {
    const runs: R5ReasoningRun[] = [reasoningRun(), reasoningRun({ reasoningTraceFile: "local:r5r-002" })];
    const aggregates = buildR5Aggregates(runs);
    const task = R5_TASKS.find((item) => item.id === "B")!;
    const outDir = path.join(os.tmpdir(), `r5-reasoning-report-test-${Date.now()}`);

    const reportPath = writeR5ReasoningReport(
      outDir,
      { task: "B", arm: "treatment", samples: 2, rounds: 10, dslGuidance: "primitive", policy: "current", rawLogging: true, reasoning: true },
      { id: "deepseek-chat", reasoningEnabled: true },
      task,
      runs,
      aggregates,
    );
    try {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        config: {
          task: string;
          arm: string;
          samples: number;
          rounds: number;
          dslGuidance: string;
          policy: string;
          rawLogging: boolean;
          reasoning: boolean;
        };
        model: { id: string; reasoningEnabled: boolean };
        tasks: Array<{ id: string; name: string; prompt: string; oracle: string[] }>;
        aggregates: Record<string, Record<string, { runs: number }>>;
        runs: Array<Record<string, unknown>>;
      };
      expect(report.mode).toBe("r5-reasoning-observation");
      expect(report.config).toEqual({
        task: "B",
        arm: "treatment",
        samples: 2,
        rounds: 10,
        dslGuidance: "primitive",
        policy: "current",
        rawLogging: true,
        reasoning: true,
      });
      expect(report.model).toEqual({ id: "deepseek-chat", reasoningEnabled: true });
      expect(report.tasks[0]!.id).toBe("B");
      expect(report.tasks[0]!.prompt.length).toBeGreaterThan(0);
      expect(report.tasks[0]!.oracle.length).toBeGreaterThan(0);

      // P0：runs 里绝不能出现 reasoning 原文（CoT 只进 traces.jsonl）
      expect(report.runs).toHaveLength(2);
      for (const run of report.runs) {
        expect("reasoning" in run).toBe(false);
        expect("reasoningTurns" in run).toBe(false);
      }
      // phases 只含 round/phase/toolCalls；reasoningTraceFile 是本地引用而非原文
      expect(report.runs[0]!.reasoningTraceFile).toBe("local:r5r-001");
      expect(report.runs[0]!.phases).toEqual([
        { round: 1, phase: "jit-decision", toolCalls: ["jit_describe_tools"] },
      ]);
      expect(report.aggregates.treatment.B.runs).toBe(2);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseFlags —— CLI 参数解析（纯函数）
// ---------------------------------------------------------------------------

describe("parseFlags — R5.1 Reasoning Observation CLI 参数", () => {
  test("默认值：samples=10 / rounds=10 / rawLogging=true / reasoning=false（固定 task=B/arm=treatment/dslGuidance=primitive/policy=current）", () => {
    const flags = parseFlags([]);
    expect(flags.samples).toBe(10);
    expect(flags.rounds).toBe(10);
    expect(flags.rawLogging).toBe(true);
    expect(flags.reasoning).toBe(false);
  });

  test("显式传参覆盖", () => {
    const flags = parseFlags(["--samples=3", "--rounds=5", "--raw-logging=false", "--reasoning=true"]);
    expect(flags.samples).toBe(3);
    expect(flags.rounds).toBe(5);
    expect(flags.rawLogging).toBe(false);
    expect(flags.reasoning).toBe(true);
  });

  test("钳制：samples 至少 1、rounds 至少 2；非法数字回退默认值", () => {
    const clamped = parseFlags(["--samples=0", "--rounds=1"]);
    expect(clamped.samples).toBe(1);
    expect(clamped.rounds).toBe(2);
    const fallback = parseFlags(["--samples=abc", "--rounds=xyz"]);
    expect(fallback.samples).toBe(10);
    expect(fallback.rounds).toBe(10);
  });

  test("mode：默认 observation；--mode=validity 切换；非法值回退 observation", () => {
    expect(parseFlags([]).mode).toBe("observation");
    expect(parseFlags(["--mode=validity"]).mode).toBe("validity");
    expect(parseFlags(["--mode=unknown"]).mode).toBe("observation");
  });
});

// ---------------------------------------------------------------------------
// R5.1a validity —— 交替顺序 / runId / 聚合 / 报告 schema（纯函数，不跑模型）
// ---------------------------------------------------------------------------

describe("interleavedReasoningOrder — OFF→ON / ON→OFF 交替", () => {
  test("pair 1（奇）先 OFF 后 ON；pair 2（偶）先 ON 后 OFF；pair 3 回到 OFF 先", () => {
    expect(interleavedReasoningOrder(1)).toEqual([false, true]);
    expect(interleavedReasoningOrder(2)).toEqual([true, false]);
    expect(interleavedReasoningOrder(3)).toEqual([false, true]);
  });
});

describe("validityRunId — 稳定 runId（arm-pair）", () => {
  test("off/on 前缀 + 3 位 pair 序号", () => {
    expect(validityRunId(false, 1)).toBe("off-001");
    expect(validityRunId(true, 1)).toBe("on-001");
    expect(validityRunId(false, 30)).toBe("off-030");
    expect(validityRunId(true, 30)).toBe("on-030");
  });
});

/** R5ReasoningValidityRun 构造辅助（只填聚合需要的关键字段，其余用安全默认）。 */
const validityRun = (overrides: Partial<R5ReasoningValidityRun> & { runId: string; reasoningEnabled: boolean; pairIndex: number }): R5ReasoningValidityRun => ({
  arm: "treatment",
  taskId: "B",
  rounds: 4,
  maxedOut: false,
  tokens: { input: 1000, output: 500, cacheRead: 0, total: 1500 },
  latencyMs: 8000,
  toolTimeline: [{ name: "jit_describe_tools", isError: false, round: 1, arguments: {} }],
  businessCalls: [],
  describeCalls: 1,
  executeCalls: 1,
  jitAttempted: true,
  jitExecutionSucceeded: true,
  jitSemanticCorrect: true,
  jitFinishedWithoutFallback: true,
  fallbackUsed: false,
  preOffloadBusinessCalls: [],
  preOffloadBusinessCallCount: 0,
  sameRoundBusinessCalls: [],
  sameRoundBusinessCallCount: 0,
  postExecuteBusinessCalls: [],
  postExecuteBusinessCallCount: 0,
  offloadDecisionRound: 1,
  timelyOffload: true,
  answerCorrect: true,
  taskCompleted: true,
  finalText: "完成",
  reasoningTraceFile: "local:off-001",
  phases: [{ round: 1, phase: "jit-decision", toolCalls: ["jit_describe_tools"] }],
  ...overrides,
});

describe("buildReasoningValidityAggregates — OFF/ON 分组 + pre-offload 分布（mean/median/p90/max）", () => {
  test("OFF 含 31-call outlier 不拉偏 median/p90；ON 分布为 0；sameRound 率正确", () => {
    const runs: R5ReasoningValidityRun[] = [
      // OFF arm：1 条正常（pre=1）+ 1 条 outlier（pre=31，模拟 28k 坏 run）
      validityRun({ runId: "off-001", reasoningEnabled: false, pairIndex: 1, preOffloadPipelineCalls: 1, preOffloadBusinessCallCount: 1, timelyOffload: false }),
      validityRun({ runId: "off-002", reasoningEnabled: false, pairIndex: 2, preOffloadPipelineCalls: 31, preOffloadBusinessCallCount: 31, timelyOffload: false }),
      // ON arm：2 条都在决策轮并发（same=1），pre=0
      validityRun({ runId: "on-001", reasoningEnabled: true, pairIndex: 1, preOffloadPipelineCalls: 0, preOffloadBusinessCallCount: 0, sameRoundBusinessCallCount: 1 }),
      validityRun({ runId: "on-002", reasoningEnabled: true, pairIndex: 2, preOffloadPipelineCalls: 0, preOffloadBusinessCallCount: 0, sameRoundBusinessCallCount: 1 }),
    ];
    const aggregates = buildReasoningValidityAggregates(runs);

    // OFF：n=2，prePipeline=[1,31] → avg=16 / median=1（nearest-rank）/ p90=31 / max=31
    expect(aggregates.off.runs).toBe(2);
    expect(aggregates.off.avgPreOffloadPipelineCalls).toBe(16);
    expect(aggregates.off.medianPreOffloadPipelineCalls).toBe(1);
    expect(aggregates.off.p90PreOffloadPipelineCalls).toBe(31);
    expect(aggregates.off.maxPreOffloadPipelineCalls).toBe(31);
    expect(aggregates.off.adoptionRate).toBe(1);
    expect(aggregates.off.offloadPrecision).toBe(1);
    expect(aggregates.off.sameRoundBusinessCallRate).toBe(0);
    expect(aggregates.off.avgOffloadDecisionRound).toBe(1);

    // ON：n=2，prePipeline=[0,0] → 全 0；sameRound 率 100%
    expect(aggregates.on.runs).toBe(2);
    expect(aggregates.on.avgPreOffloadPipelineCalls).toBe(0);
    expect(aggregates.on.medianPreOffloadPipelineCalls).toBe(0);
    expect(aggregates.on.p90PreOffloadPipelineCalls).toBe(0);
    expect(aggregates.on.maxPreOffloadPipelineCalls).toBe(0);
    expect(aggregates.on.sameRoundBusinessCallRate).toBe(1);
    expect(aggregates.on.fallbackRate).toBe(0);

    // 行为指标两臂齐备（rounds / tokens / latency）
    expect(aggregates.off.avgRounds).toBe(4);
    expect(aggregates.on.avgRounds).toBe(4);
    expect(aggregates.on.avgLatencyMs).toBe(8000);
  });

  test("某 arm 无 run：返回全 0 的占位 aggregate", () => {
    const runs: R5ReasoningValidityRun[] = [
      validityRun({ runId: "on-001", reasoningEnabled: true, pairIndex: 1 }),
    ];
    const aggregates = buildReasoningValidityAggregates(runs);
    expect(aggregates.off.runs).toBe(0);
    expect(aggregates.off.avgOffloadDecisionRound).toBe(0);
    expect(aggregates.on.runs).toBe(1);
  });
});

describe("writeR5ReasoningValidityReport — 单一 report、双臂 schema、无 reasoning 原文", () => {
  test("mode=r5-reasoning-validity；runs 带 runId/reasoningEnabled/pairIndex；aggregates={off,on}", () => {
    const runs: R5ReasoningValidityRun[] = [
      validityRun({ runId: "off-001", reasoningEnabled: false, pairIndex: 1 }),
      validityRun({ runId: "on-001", reasoningEnabled: true, pairIndex: 1 }),
    ];
    const aggregates = buildReasoningValidityAggregates(runs);
    const task = R5_TASKS.find((item) => item.id === "B")!;
    const outDir = path.join(os.tmpdir(), `r5-reasoning-validity-report-test-${Date.now()}`);

    const reportPath = writeR5ReasoningValidityReport(
      outDir,
      { task: "B", arm: "treatment", pairs: 1, rounds: 10, dslGuidance: "primitive", policy: "current", rawLogging: true },
      { id: "deepseek-chat", off: { reasoningEnabled: false }, on: { reasoningEnabled: true, thinkingLevel: "medium" } },
      task,
      runs,
      aggregates,
    );
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        config: { pairs: number; task: string; arm: string; dslGuidance: string; policy: string; rounds: number };
        model: { id: string; off: { reasoningEnabled: boolean }; on: { reasoningEnabled: boolean; thinkingLevel?: string } };
        aggregates: { off: { runs: number }; on: { runs: number } };
        runs: Array<Record<string, unknown>>;
      };
      expect(report.mode).toBe("r5-reasoning-validity");
      expect(report.config).toEqual({
        task: "B",
        arm: "treatment",
        pairs: 1,
        rounds: 10,
        dslGuidance: "primitive",
        policy: "current",
        rawLogging: true,
      });
      expect(report.model).toEqual({
        id: "deepseek-chat",
        off: { reasoningEnabled: false },
        on: { reasoningEnabled: true, thinkingLevel: "medium" },
      });
      expect(report.aggregates.off.runs).toBe(1);
      expect(report.aggregates.on.runs).toBe(1);

      // runs 各自带 runId / reasoningEnabled / pairIndex；且绝不含 reasoning 原文
      expect(report.runs).toHaveLength(2);
      expect(report.runs[0]!.runId).toBe("off-001");
      expect(report.runs[0]!.reasoningEnabled).toBe(false);
      expect(report.runs[0]!.pairIndex).toBe(1);
      expect(report.runs[1]!.runId).toBe("on-001");
      expect(report.runs[1]!.reasoningEnabled).toBe(true);
      for (const run of report.runs) {
        expect("reasoning" in run).toBe(false);
        expect("reasoningTurns" in run).toBe(false);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
