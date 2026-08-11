import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { buildR5Aggregates } from "../src/experiments/r5OffloadingBenchmark.js";
import {
  parseFlags,
  writeReasoningTraceFile,
  writeR5ReasoningReport,
  type R5ReasoningRun,
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
});
