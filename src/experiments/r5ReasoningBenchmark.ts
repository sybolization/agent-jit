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
import { alignReasoningTrace, type ReasoningPhase, type ReasoningTraceMeta } from "./reasoningTrace.js";
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
  /** 该 run 是否开启 reasoning（validity 双 arm 模式用于审计，observational 模式可选） */
  reasoningEnabled?: boolean;
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
  /** observation = 单臂 reasoning observation（原 r5-reasoning 行为）；validity = R5.1a OFF vs ON 对照 */
  mode: "observation" | "validity";
  /** observation 模式 = run 数；validity 模式 = pair 数（每 pair 跑 OFF + ON 各 1 run） */
  samples: number;
  rounds: number;
  rawLogging: boolean;
  /** observation 模式：是否开启 DeepSeek thinking 模式（validity 模式下忽略，双臂自动切换） */
  reasoning: boolean;
}

export function parseFlags(argv: readonly string[]): R5ReasoningCliFlags {
  const flags: R5ReasoningCliFlags = { mode: "observation", samples: 10, rounds: 10, rawLogging: true, reasoning: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    // 显式传 0 要钳制到下限（至少 1 / 至少 2），非法数字才回退默认值
    if (key === "mode") flags.mode = value === "validity" ? "validity" : "observation";
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
 * enabled === true：mkdir + 写 traces.jsonl（有 meta 则首行写 `{"type":"meta",...}`，
 * 后续每行 JSON.stringify(line) + 换行），返回绝对路径；
 * enabled === false：什么都不做，返回 undefined；
 * lines 为空数组：不创建文件，返回 undefined（避免空文件）。
 */
export function writeReasoningTraceFile(
  dirPath: string,
  lines: readonly ReasoningTraceLine[],
  enabled: boolean,
  meta?: ReasoningTraceMeta,
): string | undefined {
  if (!enabled || lines.length === 0) return undefined;
  fs.mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, "traces.jsonl");
  const metaLine = meta !== undefined ? `${JSON.stringify({ type: "meta", ...meta })}\n` : "";
  fs.writeFileSync(filePath, metaLine + lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return filePath;
}

// ---------------------------------------------------------------------------
// R5.1a Reasoning Validity —— 双 Arm（OFF vs ON）行为对照
// ---------------------------------------------------------------------------

/** validity report 中的单个 run：稳定 runId + reasoning 开关 + pair 序号。 */
export interface R5ReasoningValidityRun extends R5ReasoningRun {
  /** 稳定 runId：`off-001` / `on-001`…（arm-pair），供 CoT label 可靠 join */
  runId: string;
  /** 该 run 的 reasoning 开关（OFF=false / ON=true） */
  reasoningEnabled: boolean;
  /** 所属 pair 序号（1-based；每 pair 含 OFF + ON 各 1 run，交替执行抵消时间顺序偏差） */
  pairIndex: number;
}

/** validity 固定配置（除 reasoning 外无其他变量）。 */
export interface R5ReasoningValidityReportConfig {
  task: "B";
  arm: "treatment";
  /** pair 数（每 pair = OFF + ON 各 1 run，总 run 数 = pairs × 2） */
  pairs: number;
  rounds: number;
  dslGuidance: "primitive";
  policy: "current";
  rawLogging: boolean;
}

/** 双臂统一行为指标（OFF/ON 直接表格比较；pre-offload 分布防 31-call outlier 拉偏）。 */
export interface ReasoningValidityAggregate {
  reasoningEnabled: boolean;
  runs: number;
  adoptionRate: number;
  jitSemanticCorrectRate: number;
  offloadPrecision: number;
  taskCompletionRate: number;
  avgOffloadDecisionRound: number;
  avgPreOffloadPipelineCalls: number | undefined;
  medianPreOffloadPipelineCalls: number | undefined;
  p90PreOffloadPipelineCalls: number | undefined;
  maxPreOffloadPipelineCalls: number | undefined;
  /** 决策同轮并发业务调用（非 fallback）的 run 占比 */
  sameRoundBusinessCallRate: number;
  fallbackRate: number;
  avgTokens: number;
  avgRounds: number;
  avgLatencyMs: number;
}

export type ReasoningValidityAggregates = {
  off: ReasoningValidityAggregate;
  on: ReasoningValidityAggregate;
};

/**
 * 交替顺序：pair 为奇数（1-based）先 OFF 后 ON，偶数先 ON 后 OFF，
 * 使 OFF/ON 在时间上均匀交错、各自等量占据先/后位置，抵消实验期间漂移。
 */
export function interleavedReasoningOrder(pairIndex: number): readonly [false, true] | readonly [true, false] {
  return pairIndex % 2 === 1 ? [false, true] : [true, false];
}

/** 稳定 runId：`off-001` / `on-001`…（arm-pair）。 */
export function validityRunId(reasoningEnabled: boolean, pairIndex: number): string {
  return `${reasoningEnabled ? "on" : "off"}-${String(pairIndex).padStart(3, "0")}`;
}

const EMPTY_VALIDITY_AGGREGATE = (reasoningEnabled: boolean): ReasoningValidityAggregate => ({
  reasoningEnabled,
  runs: 0,
  adoptionRate: 0,
  jitSemanticCorrectRate: 0,
  offloadPrecision: 0,
  taskCompletionRate: 0,
  avgOffloadDecisionRound: 0,
  avgPreOffloadPipelineCalls: undefined,
  medianPreOffloadPipelineCalls: undefined,
  p90PreOffloadPipelineCalls: undefined,
  maxPreOffloadPipelineCalls: undefined,
  sameRoundBusinessCallRate: 0,
  fallbackRate: 0,
  avgTokens: 0,
  avgRounds: 0,
  avgLatencyMs: 0,
});

/** 最近秩百分位（nearest-rank）：sorted 升序，p∈[0,1]，返回第 ceil(p·n) 个元素。 */
function nearestRank(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** 按 reasoning 开关分组聚合（行为指标统一；pre-offload 分布 = mean/median/p90/max）。 */
export function buildReasoningValidityAggregates(
  runs: readonly R5ReasoningValidityRun[],
): ReasoningValidityAggregates {
  const aggregateArm = (reasoningEnabled: boolean): ReasoningValidityAggregate => {
    const cell = runs.filter((run) => run.reasoningEnabled === reasoningEnabled);
    const total = cell.length;
    if (total === 0) return EMPTY_VALIDITY_AGGREGATE(reasoningEnabled);
    const ratio = (n: number): number => n / total;
    const avg = (values: number[]): number =>
      values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const attempted = cell.filter((run) => run.jitAttempted).length;
    const attemptedCorrect = cell.filter((run) => run.jitAttempted && run.jitSemanticCorrect === true).length;
    const decisionRounds = cell
      .map((run) => run.offloadDecisionRound)
      .filter((value): value is number => value !== undefined);
    const pipelineValues = cell
      .map((run) => run.preOffloadPipelineCalls)
      .filter((value): value is number => value !== undefined);
    const sortedPipeline = [...pipelineValues].sort((a, b) => a - b);
    return {
      reasoningEnabled,
      runs: total,
      adoptionRate: ratio(attempted),
      jitSemanticCorrectRate: ratio(cell.filter((run) => run.jitSemanticCorrect === true).length),
      offloadPrecision: attempted > 0 ? attemptedCorrect / attempted : 0,
      taskCompletionRate: ratio(cell.filter((run) => run.taskCompleted).length),
      avgOffloadDecisionRound: avg(decisionRounds),
      avgPreOffloadPipelineCalls: pipelineValues.length > 0 ? avg(pipelineValues) : undefined,
      medianPreOffloadPipelineCalls: nearestRank(sortedPipeline, 0.5),
      p90PreOffloadPipelineCalls: nearestRank(sortedPipeline, 0.9),
      maxPreOffloadPipelineCalls: sortedPipeline.length > 0 ? sortedPipeline[sortedPipeline.length - 1] : undefined,
      sameRoundBusinessCallRate: ratio(cell.filter((run) => run.sameRoundBusinessCallCount > 0).length),
      fallbackRate: ratio(cell.filter((run) => run.fallbackUsed).length),
      avgTokens: avg(cell.map((run) => run.tokens.total)),
      avgRounds: avg(cell.map((run) => run.rounds)),
      avgLatencyMs: avg(cell.map((run) => run.latencyMs)),
    };
  };
  return { off: aggregateArm(false), on: aggregateArm(true) };
}

/**
 * 把一次 R5.1a Validity 实验写入 report.json（mode = "r5-reasoning-validity"）。
 *
 * runs 每个带 runId / reasoningEnabled / pairIndex；aggregates 按 OFF/ON 分两组。
 * 与 observation 相同：runs 里绝不出现 reasoning 原文（CoT 只进 traces.jsonl）。
 */
export function writeR5ReasoningValidityReport(
  outDir: string,
  config: R5ReasoningValidityReportConfig,
  modelMeta: {
    id: string;
    off: { reasoningEnabled: false; thinkingLevel?: undefined };
    on: { reasoningEnabled: true; thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
  },
  task: { id: string; name: string; prompt: string; oracle: readonly (string | RegExp)[] },
  runs: readonly R5ReasoningValidityRun[],
  aggregates: ReasoningValidityAggregates,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r5-reasoning-validity",
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
  if (flags.mode === "validity") return runValidityMain(flags);
  return runObservationMain(flags);
}

/** 单臂 reasoning observation（原 experiment:r5-reasoning 行为，保持不变）。 */
async function runObservationMain(flags: R5ReasoningCliFlags): Promise<number> {
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
  const traceMeta: ReasoningTraceMeta = {
    modelId: runtime.model.id,
    reasoningMode: flags.reasoning ? "thinking-blocks" : "none",
    ...(runtime.thinkingLevel ? { thinkingLevel: runtime.thinkingLevel } : {}),
  };
  const tracePath = writeReasoningTraceFile(rawDir, traceLines, flags.rawLogging, traceMeta);

  console.log(`\n报告已写入: ${reportPath}`);
  if (tracePath) console.log(`raw CoT traces 已写入: ${tracePath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// R5.1a Validity 主流程：OFF/ON 双 arm 交替执行（唯一变量 = reasoning）
// ---------------------------------------------------------------------------

async function runValidityMain(flags: R5ReasoningCliFlags): Promise<number> {
  const pairs = flags.samples; // validity 模式下 samples 即 pair 数
  // OFF/ON 只差 reasoning flag：同一个 model id（deepseek-chat）、同一份 task/prompt/rounds/policy
  const offRuntime = createDeepSeekPiRuntime(); // reasoning=false（与 R5 主实验一致）
  const onRuntime = createDeepSeekPiRuntime({ reasoning: true }); // reasoning=true（thinking blocks）
  const task = R5_TASKS.find((item) => item.id === "B")!;

  const runs: R5ReasoningValidityRun[] = [];
  const traceLinesByArm: Record<"off" | "on", ReasoningTraceLine[]> = { off: [], on: [] };

  for (let pair = 1; pair <= pairs; pair += 1) {
    for (const reasoning of interleavedReasoningOrder(pair)) {
      const runtime = reasoning ? onRuntime : offRuntime;
      const arm = reasoning ? "on" : "off";
      const runId = validityRunId(reasoning, pair);
      let reasoningTurns: readonly AgentReasoningTurn[] = [];
      console.log(
        `\n===== [validity] pair ${pair}/${pairs} ${arm.toUpperCase()}（reasoning=${reasoning}）${task.name} =====`,
      );

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
          traceLinesByArm[arm].push({
            runId,
            round: entry.round,
            phase: entry.phase,
            reasoning: entry.reasoning,
            toolCalls: entry.toolCalls,
            text: textByRound.get(entry.round) ?? "",
            reasoningEnabled: reasoning,
          });
        }
      }
      runs.push({
        ...metrics,
        runId,
        reasoningEnabled: reasoning,
        pairIndex: pair,
        reasoningTraceFile: `local:${runId}`,
        phases: entries.map((entry) => ({ round: entry.round, phase: entry.phase, toolCalls: entry.toolCalls })),
      });

      console.log(
        `→ ${runId} rounds=${metrics.rounds} maxedOut=${metrics.maxedOut} tokens=${metrics.tokens.total} ` +
          `latency=${metrics.latencyMs}ms answer=${metrics.answerCorrect ? "✓" : "✗"} completed=${metrics.taskCompleted ? "✓" : "✗"}`,
      );
      console.log(
        `  jitAttempted=${metrics.jitAttempted} execSucceeded=${metrics.jitExecutionSucceeded} ` +
          `semantic=${metrics.jitSemanticCorrect === undefined ? "n/a" : metrics.jitSemanticCorrect} ` +
          `fallback=${metrics.fallbackUsed} business=[${metrics.businessCalls.join(", ") || "无"}]`,
      );
      if (metrics.offloadDecisionRound !== undefined) {
        console.log(
          `  offloadDecisionRound=${metrics.offloadDecisionRound} ` +
            `pre=${metrics.preOffloadBusinessCallCount} same=${metrics.sameRoundBusinessCallCount} ` +
            `postExec=${metrics.postExecuteBusinessCallCount}` +
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
  }

  console.log("\n\n===== R5.1a Reasoning Validity 汇总（OFF vs ON）=====");
  const aggregates = buildReasoningValidityAggregates(runs);
  for (const arm of ["off", "on"] as const) {
    const agg = aggregates[arm];
    console.log(
      `  ${arm.toUpperCase()}  runs=${agg.runs} ` +
        `adoption=${(agg.adoptionRate * 100).toFixed(0)}% semantic=${(agg.jitSemanticCorrectRate * 100).toFixed(0)}% ` +
        `offloadPrecision=${(agg.offloadPrecision * 100).toFixed(0)}% taskCompleted=${(agg.taskCompletionRate * 100).toFixed(0)}%`,
    );
    console.log(
      `    offloadRound=${agg.avgOffloadDecisionRound.toFixed(1)} ` +
        `prePipeline avg=${agg.avgPreOffloadPipelineCalls === undefined ? "n/a" : agg.avgPreOffloadPipelineCalls.toFixed(1)} ` +
        `median=${agg.medianPreOffloadPipelineCalls === undefined ? "n/a" : agg.medianPreOffloadPipelineCalls} ` +
        `p90=${agg.p90PreOffloadPipelineCalls === undefined ? "n/a" : agg.p90PreOffloadPipelineCalls} ` +
        `max=${agg.maxPreOffloadPipelineCalls === undefined ? "n/a" : agg.maxPreOffloadPipelineCalls} ` +
        `sameRound=${(agg.sameRoundBusinessCallRate * 100).toFixed(0)}% fallback=${(agg.fallbackRate * 100).toFixed(0)}%`,
    );
    console.log(
      `    rounds=${agg.avgRounds.toFixed(1)} tokens=${Math.round(agg.avgTokens)} latency=${Math.round(agg.avgLatencyMs)}ms`,
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPO_ROOT, "logs", "experiments", `r5-reasoning-validity-${ts}`);
  const rawDir = path.join(REPO_ROOT, "logs", "reasoning-raw", `r5-reasoning-validity-${ts}`);
  const reportPath = writeR5ReasoningValidityReport(
    outDir,
    {
      task: "B",
      arm: "treatment",
      pairs,
      rounds: flags.rounds,
      dslGuidance: "primitive",
      policy: "current",
      rawLogging: flags.rawLogging,
    },
    {
      id: onRuntime.model.id,
      off: { reasoningEnabled: false },
      on: { reasoningEnabled: true, thinkingLevel: onRuntime.thinkingLevel },
    },
    task,
    runs,
    aggregates,
  );
  // raw CoT 按 arm 分文件，各自带 meta 首行（modelId / reasoningMode / thinkingLevel）
  const offTrace = writeReasoningTraceFile(rawDir + "/off", traceLinesByArm.off, flags.rawLogging, {
    modelId: offRuntime.model.id,
    reasoningMode: "none",
  });
  const onTrace = writeReasoningTraceFile(rawDir + "/on", traceLinesByArm.on, flags.rawLogging, {
    modelId: onRuntime.model.id,
    reasoningMode: "thinking-blocks",
    ...(onRuntime.thinkingLevel ? { thinkingLevel: onRuntime.thinkingLevel } : {}),
  });

  console.log(`\n报告已写入: ${reportPath}`);
  if (offTrace) console.log(`OFF raw CoT traces 已写入: ${offTrace}`);
  if (onTrace) console.log(`ON  raw CoT traces 已写入: ${onTrace}`);
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
