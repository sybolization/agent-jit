#!/usr/bin/env node

/**
 * R5.1 Reasoning Observation —— 机制诊断实验（不是性能 benchmark）。
 *
 * 实验目的：把 R5 treatment 臂（task=B / arm=treatment / dslGuidance=primitive /
 * policy=current）的**每轮 reasoning（CoT）**原样采集下来，供离线人工标注
 * （taxonomy 见 reasoningLabels.ts 的固定 CoT 体系，避免 post-hoc storytelling），
 * 诊断模型 offload 决策的机制原因（recognition-late / data-uncertainty-blocker /
 * jit-selection-late / greedy-speculative / economic-rejection），而不是只报告性能数字。
 *
 * 关键设计：
 * - **什么都不改变**：固定 task=B / arm=treatment / dslGuidance=primitive / policy=current，
 *   不引入新提示词、新工具、新 policy——只增加 reasoning observation
 *   （通过 runR5Run 的 onReasoningTurns 回调透传，附加式，不进 R5RunMetrics）；
 * - **raw CoT 只写 gitignored 路径**（logs/reasoning-raw/）；report.json 不含 reasoning
 *   原文（只含 run 指标 + phases 的 round/phase/toolCalls），避免把模型思维链写进
 *   纳入版本控制的 report 污染可复现实验记录；
 * - --reasoning=true 时用 createDeepSeekPiRuntime({ reasoning: true }) 打开 DeepSeek
 *   thinking 模式（默认 false，与 R5 主实验一致）。
 *
 * 运行：npx tsx src/experiments/r5ReasoningBenchmark.ts [--samples=10] [--rounds=10]
 *   [--raw-logging=true|false] [--reasoning=true|false]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime } from "../llm/gateway.js";
import type { AgentReasoningTurn } from "./agentRunner.js";
import { alignReasoningTrace, type ReasoningPhase } from "./reasoningTrace.js";
import {
  buildR5Aggregates,
  runR5Run,
  type R5Aggregates,
  type R5RunMetrics,
} from "./r5OffloadingBenchmark.js";
import { R5_TASKS } from "./r5Tasks.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

function loadEnv(root: string): void {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** raw CoT 单行记录：一轮 reasoning 的完整观测（只写 traces.jsonl，绝不进 report）。 */
export interface ReasoningTraceLine {
  runId: string;
  round: number;
  phase: ReasoningPhase;
  /** 模型思维链原文（可能为空串，如关闭 reasoning 模式时） */
  reasoning: string;
  toolCalls: readonly string[];
  /** 同轮 assistant 普通文本（无则空串） */
  text: string;
}

/** report 中的单个 run：R5 全部指标 + reasoning 观测的轻量索引（不含 CoT 原文）。 */
export interface R5ReasoningRun extends R5RunMetrics {
  /** reasoning 观测的落盘引用（形如 "local:r5r-001"，raw 路径见同名前缀的 traces.jsonl） */
  reasoningTraceFile: string;
  /** 每轮阶段对齐（只含 round/phase/toolCalls，reasoning 文本只进 traces.jsonl） */
  phases: readonly { round: number; phase: ReasoningPhase; toolCalls: readonly string[] }[];
}

/** 本实验固定配置（task=B / arm=treatment / dslGuidance=primitive / policy=current）。 */
export interface R5ReasoningReportConfig {
  task: "B";
  arm: "treatment";
  samples: number;
  rounds: number;
  dslGuidance: "primitive";
  policy: "current";
  /** 是否写 raw CoT traces（本实验目的即产出 traces 供人工 review；false 关闭） */
  rawLogging: boolean;
  /** 是否打开 DeepSeek thinking 模式（reasoning 观测的是否是 CoT 原文） */
  reasoning: boolean;
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

export interface R5ReasoningCliFlags {
  samples: number;
  rounds: number;
  rawLogging: boolean;
  reasoning: boolean;
}

export function parseFlags(argv: readonly string[]): R5ReasoningCliFlags {
  const flags: R5ReasoningCliFlags = { samples: 10, rounds: 10, rawLogging: true, reasoning: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    // 显式传 0 要钳制到下限（至少 1 / 至少 2），非法数字才回退默认值
    if (key === "samples") {
      const n = Number(value);
      flags.samples = Number.isFinite(n) ? Math.max(1, n) : 10;
    }
    if (key === "rounds") {
      const n = Number(value);
      flags.rounds = Number.isFinite(n) ? Math.max(2, n) : 10;
    }
    if (key === "raw-logging") flags.rawLogging = value !== "false";
    if (key === "reasoning") flags.reasoning = value === "true";
  }
  return flags;
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/**
 * 把一次 R5.1 Reasoning Observation 的结果写入 report.json。
 *
 * 配置（固定 task=B / arm=treatment / dslGuidance=primitive / policy=current）+ 任务元数据
 * （prompt / oracle）+ 每个 run 的全部 R5 指标与 phases（round/phase/toolCalls）+ 汇总。
 *
 * **注意：runs 里绝不能出现 reasoning 原文**——phases 只有 round/phase/toolCalls；
 * reasoning 文本只进 traces.jsonl（writeReasoningTraceFile）。返回 report.json 绝对路径。
 */
export function writeR5ReasoningReport(
  outDir: string,
  config: R5ReasoningReportConfig,
  modelMeta: { id: string; reasoningEnabled: boolean; thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" },
  task: { id: string; name: string; prompt: string; oracle: readonly (string | RegExp)[] },
  runs: readonly R5ReasoningRun[],
  aggregates: R5Aggregates,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r5-reasoning-observation",
        config,
        model: modelMeta,
        timestamp: new Date().toISOString(),
        tasks: [{ id: task.id, name: task.name, prompt: task.prompt, oracle: task.oracle.map(String) }],
        aggregates,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  return reportPath;
}

/**
 * 写 raw CoT traces（JSONL，每行一条 ReasoningTraceLine）。
 *
 * enabled === true：mkdir + 写 traces.jsonl（每行 JSON.stringify(line) + 换行），返回绝对路径；
 * enabled === false：什么都不做，返回 undefined；
 * lines 为空数组：不创建文件，返回 undefined（避免空文件）。
 */
export function writeReasoningTraceFile(
  dirPath: string,
  lines: readonly ReasoningTraceLine[],
  enabled: boolean,
): string | undefined {
  if (!enabled || lines.length === 0) return undefined;
  fs.mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, "traces.jsonl");
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return filePath;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const flags = parseFlags(process.argv.slice(2));
  const runtime = createDeepSeekPiRuntime(flags.reasoning ? { reasoning: true } : undefined);
  const task = R5_TASKS.find((item) => item.id === "B")!;

  const runs: R5ReasoningRun[] = [];
  const traceLines: ReasoningTraceLine[] = [];

  for (let i = 1; i <= flags.samples; i += 1) {
    const runId = `r5r-${String(i).padStart(3, "0")}`;
    let reasoningTurns: readonly AgentReasoningTurn[] = [];
    console.log(`\n===== [treatment/B] ${task.name}（sample ${i}/${flags.samples}）=====`);

    const metrics = await runR5Run(task, "treatment", runtime, flags.rounds, {
      dslGuidance: "primitive",
      onReasoningTurns: (turns) => {
        reasoningTurns = turns;
      },
    });

    // reasoning ↔ tool timeline 对齐（每轮 phase；reasoning 原文只进 traceLines）
    const entries = alignReasoningTrace(reasoningTurns, metrics.toolTimeline);
    if (flags.rawLogging) {
      const textByRound = new Map(reasoningTurns.map((turn) => [turn.round, turn.text]));
      for (const entry of entries) {
        traceLines.push({
          runId,
          round: entry.round,
          phase: entry.phase,
          reasoning: entry.reasoning,
          toolCalls: entry.toolCalls,
          text: textByRound.get(entry.round) ?? "",
        });
      }
    }
    runs.push({
      ...metrics,
      reasoningTraceFile: `local:${runId}`,
      phases: entries.map((entry) => ({ round: entry.round, phase: entry.phase, toolCalls: entry.toolCalls })),
    });

    console.log(
      `→ rounds=${metrics.rounds} maxedOut=${metrics.maxedOut} tokens=${metrics.tokens.total} latency=${metrics.latencyMs}ms ` +
        `answer=${metrics.answerCorrect ? "✓" : "✗"} completed=${metrics.taskCompleted ? "✓" : "✗"}`,
    );
    console.log(
      `  jitAttempted=${metrics.jitAttempted} execSucceeded=${metrics.jitExecutionSucceeded} ` +
        `semantic=${metrics.jitSemanticCorrect === undefined ? "n/a" : metrics.jitSemanticCorrect} ` +
        `jitFinishedWithoutFallback=${metrics.jitFinishedWithoutFallback} fallback=${metrics.fallbackUsed} ` +
        `describe=${metrics.describeCalls} execute=${metrics.executeCalls} business=[${metrics.businessCalls.join(", ") || "无"}]`,
    );
    if (metrics.offloadDecisionRound !== undefined) {
      console.log(
        `  offloadDecisionRound=${metrics.offloadDecisionRound} ` +
          `pre=${metrics.preOffloadBusinessCallCount} same=${metrics.sameRoundBusinessCallCount} postExec=${metrics.postExecuteBusinessCallCount}` +
          (metrics.preOffloadPipelineCalls !== undefined ? ` preOffloadPipeline=${metrics.preOffloadPipelineCalls}` : "") +
          ` timely=${metrics.timelyOffload === undefined ? "n/a" : metrics.timelyOffload}`,
      );
    }
    if (flags.rawLogging) {
      console.log(
        `  reasoningTurns=${reasoningTurns.length} phases=[${entries.map((entry) => entry.phase).join(", ") || "无"}]`,
      );
    }
  }

  console.log("\n\n===== R5.1 Reasoning Observation 汇总（treatment/B）=====");
  const aggregates = buildR5Aggregates(runs);
  const agg = aggregates.treatment.B;
  console.log(
    `  runs=${agg.runs} ` +
      `adoption=${(agg.adoptionRate * 100).toFixed(0)}% ` +
      `offloadPrecision=${(agg.offloadPrecision * 100).toFixed(0)}% ` +
      `timely=${agg.timelyOffloadRate === undefined ? "n/a" : `${(agg.timelyOffloadRate * 100).toFixed(0)}%`} ` +
      `taskCompleted=${(agg.taskCompletionRate * 100).toFixed(0)}% ` +
      `offloadRound=${agg.avgOffloadDecisionRound.toFixed(1)} ` +
      `preOffloadPipeline=${agg.avgPreOffloadPipelineCalls === undefined ? "n/a" : agg.avgPreOffloadPipelineCalls.toFixed(1)} ` +
      `rounds=${agg.avgRounds.toFixed(1)} tokens=${Math.round(agg.avgTokens)}`,
  );

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // report（纳入版本控制，不含 reasoning 原文）与 raw CoT（gitignored 路径）分目录落盘
  const outDir = path.join(REPO_ROOT, "logs", "experiments", `r5-reasoning-${ts}`);
  const rawDir = path.join(REPO_ROOT, "logs", "reasoning-raw", `r5-reasoning-${ts}`);
  const reportPath = writeR5ReasoningReport(
    outDir,
    {
      task: "B",
      arm: "treatment",
      samples: flags.samples,
      rounds: flags.rounds,
      dslGuidance: "primitive",
      policy: "current",
      rawLogging: flags.rawLogging,
      reasoning: flags.reasoning,
    },
    {
      id: runtime.model.id,
      reasoningEnabled: runtime.model.reasoning === true,
      ...(runtime.thinkingLevel ? { thinkingLevel: runtime.thinkingLevel } : {}),
    },
    task,
    runs,
    aggregates,
  );
  const tracePath = writeReasoningTraceFile(rawDir, traceLines, flags.rawLogging);

  console.log(`\n报告已写入: ${reportPath}`);
  if (tracePath) console.log(`raw CoT traces 已写入: ${tracePath}`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[FAIL]", (error as Error).message);
      process.exit(1);
    });
}
