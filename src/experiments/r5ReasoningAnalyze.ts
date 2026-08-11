#!/usr/bin/env node

/**
 * R5.1 Reasoning Observation —— 离线分析环节。
 *
 * 把实验 report.json（runs 数组，每个 run 含 offloadDecisionRound 与每轮 phases 对齐）
 * 与人工标注（RunReasoningLabel，taxonomy 见 reasoningLabels.ts 的固定 CoT 体系）合并，
 * 计算 Recognition → Consideration → Action 的三段 lag（recognitionToConsiderationLag /
 * considerationToActionLag），并统计 late-offload 五类主因分布（CauseDistribution）。
 *
 * 设计约束：
 * - **完全离线**：只读文件 + 纯计算，**严禁接入 LLM classifier**，不影响 Agent 执行；
 * - 人工 label 是第一轮标注（taxonomy 固定，后续可自动化），本脚本只做合并与统计，
 *   不修改、不生成任何实验观测数据；
 * - runId 在推理阶段按顺序生成（r5r-001…），此处按 runs 数组下标 +1 对应
 *   （runs[0] → "r5r-001"、下标 1 → "r5r-002"，依此类推）。
 *
 * 运行：npx tsx src/experiments/r5ReasoningAnalyze.ts <experiment-dir> [--labels <labels.json>]
 * 输出：<experiment-dir>/reasoning-analysis.json（{ analyses, causeDistribution }，缩进 2、末尾换行）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LateOffloadCause, BoundaryReasonLabels } from "./reasoningLabels.js";
import type { ReasoningPhase } from "./reasoningTrace.js";

/** 人工标注（第一轮人工 label，taxonomy 固定；后续可自动化） */
export interface RunReasoningLabel {
  runId: string;
  /** 模型第一次在 reasoning 中意识到后续控制规则已确定 */
  deterministicRecognitionRound?: number;
  /** 第一次在 reasoning 中考虑 JIT */
  jitConsiderationRound?: number;
  /** late-offload 主因（五类） */
  primaryCause?: LateOffloadCause;
  labels?: BoundaryReasonLabels;
}

export interface RunReasoningAnalysis {
  runId: string;
  /** 真正第一次 JIT 调用（describe 或 execute）的轮数 = 实验的 offloadDecisionRound；未尝试 JIT → undefined */
  jitActionRound?: number;
  /** 每轮 phase（与报告 phases 同构，含 phase 即可；保留 toolCalls 可选） */
  phases: readonly { round: number; phase: ReasoningPhase; toolCalls?: readonly string[] }[];
  /** 人工标注的识别轮数（无 label → undefined） */
  deterministicRecognitionRound?: number;
  /** 人工标注的考虑轮数（无 label → undefined） */
  jitConsiderationRound?: number;
  /** Recognition → Consideration lag = jitConsiderationRound - deterministicRecognitionRound（两者都齐全才定义） */
  recognitionToConsiderationLag?: number;
  /** Consideration → Action lag = jitActionRound - jitConsiderationRound（两者都齐全才定义） */
  considerationToActionLag?: number;
  primaryCause?: LateOffloadCause;
  labels?: BoundaryReasonLabels;
}

/** 五类 cause 计数（键固定五类，缺省 0） */
export type CauseDistribution = Record<LateOffloadCause, number>;

/**
 * report.json 里单个 run 的输入形态（只取分析需要的字段；R5RunMetrics 扩展的其余字段忽略）。
 *
 * runId / reasoningEnabled 由 validity 模式的 report 提供（off-001/on-001…）；
 * observation 模式的旧 report 没有这两个字段 → runId 按 runs 数组下标 +1 对应（r5r-001…），
 * reasoningEnabled 视为未声明（legacy，按旧行为处理：有 label 就做 taxonomy 分析）。
 */
export type RunInput = {
  runId?: string;
  reasoningEnabled?: boolean;
  offloadDecisionRound?: number;
  phases: readonly { round: number; phase: ReasoningPhase }[];
};

/**
 * 合并单个 run 的实验观测与人工标注，生成该 run 的分析结果。
 *
 * - jitActionRound 来自 run.offloadDecisionRound（实验的第一次 JIT 调用轮数）；
 * - phases 透传（含 round/phase；run.phases 里如有 toolCalls 也会保留）；
 * - label 合并：deterministicRecognitionRound / jitConsiderationRound / primaryCause / labels
 *   取 label 值（无 label → 该字段省略）；
 * - lag 只在两个输入 round 都是 number 时才有定义（任一缺 → 该字段省略）；
 *   recognitionToConsiderationLag = jitConsiderationRound - deterministicRecognitionRound；
 *   considerationToActionLag = jitActionRound - jitConsiderationRound；
 * - runId 取 label.runId；无 label → 空串（由调用方按 runs 下标补充，见 analyzeExperiment）。
 */
export function analyzeRun(run: RunInput, label?: RunReasoningLabel): RunReasoningAnalysis {
  const jitActionRound = run.offloadDecisionRound;
  const deterministicRecognitionRound = label?.deterministicRecognitionRound;
  const jitConsiderationRound = label?.jitConsiderationRound;

  const recognitionToConsiderationLag =
    deterministicRecognitionRound !== undefined && jitConsiderationRound !== undefined
      ? jitConsiderationRound - deterministicRecognitionRound
      : undefined;
  const considerationToActionLag =
    jitActionRound !== undefined && jitConsiderationRound !== undefined
      ? jitActionRound - jitConsiderationRound
      : undefined;

  return {
    runId: label?.runId ?? "",
    ...(jitActionRound !== undefined ? { jitActionRound } : {}),
    phases: run.phases,
    ...(deterministicRecognitionRound !== undefined ? { deterministicRecognitionRound } : {}),
    ...(jitConsiderationRound !== undefined ? { jitConsiderationRound } : {}),
    ...(recognitionToConsiderationLag !== undefined ? { recognitionToConsiderationLag } : {}),
    ...(considerationToActionLag !== undefined ? { considerationToActionLag } : {}),
    ...(label?.primaryCause !== undefined ? { primaryCause: label.primaryCause } : {}),
    ...(label?.labels !== undefined ? { labels: label.labels } : {}),
  };
}

const EMPTY_CAUSE_DISTRIBUTION: CauseDistribution = {
  "recognition-late": 0,
  "data-uncertainty-blocker": 0,
  "jit-selection-late": 0,
  "greedy-speculative": 0,
  "economic-rejection": 0,
};

/**
 * 统计每个 analysis.primaryCause 的个数；返回对象必含全部五个键（未出现的 cause 计 0）；
 * primaryCause 为 undefined 的 run 不计入。
 */
export function aggregateCauses(analyses: readonly RunReasoningAnalysis[]): CauseDistribution {
  const distribution: CauseDistribution = { ...EMPTY_CAUSE_DISTRIBUTION };
  for (const analysis of analyses) {
    if (analysis.primaryCause !== undefined) {
      distribution[analysis.primaryCause] += 1;
    }
  }
  return distribution;
}

/**
 * 读 <experiment-dir>/report.json（取 runs 数组）与可选的人工标注 labels.json（RunReasoningLabel[]，
 * 按 runId 建 Map），逐 run 调 analyzeRun，输出 `{ analyses, causeDistribution }` 写入
 * <experiment-dir>/reasoning-analysis.json（缩进 2、末尾换行）。返回输出文件的绝对路径。
 *
 * runId 生成规则：优先取 run.runId（validity 模式的 off-001/on-001…）；
 * 旧 observation report（无 runId）回退为 `r5r-${下标+1:03d}`。
 *
 * **OFF arm（reasoningEnabled === false）没有 CoT**：即使 labels.json 里误标了它，
 * taxonomy 字段（recognition/consideration/lag/primaryCause/labels）也不会应用；
 * 行为指标（jitActionRound / phases）照常输出。legacy report（reasoningEnabled 未声明）
 * 按旧行为处理（有 label 就做 taxonomy 分析）。
 */
export function analyzeExperiment(experimentDir: string, labelsPath?: string): string {
  const report = JSON.parse(
    fs.readFileSync(path.join(experimentDir, "report.json"), "utf8"),
  ) as { runs: readonly RunInput[] };

  const labelsById = new Map<string, RunReasoningLabel>();
  if (labelsPath !== undefined) {
    const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8")) as readonly RunReasoningLabel[];
    for (const label of labels) labelsById.set(label.runId, label);
  }

  const analyses: RunReasoningAnalysis[] = report.runs.map((run, i) => {
    const runId = run.runId ?? `r5r-${String(i + 1).padStart(3, "0")}`;
    const label = run.reasoningEnabled === false ? undefined : labelsById.get(runId);
    const analysis = analyzeRun(run, label);
    // 无 label 时 analyzeRun 返回空 runId，这里补上生成的 runId，保证输出总正确
    return analysis.runId !== "" ? analysis : { ...analysis, runId };
  });

  const causeDistribution = aggregateCauses(analyses);
  const outputPath = path.join(experimentDir, "reasoning-analysis.json");
  fs.writeFileSync(outputPath, `${JSON.stringify({ analyses, causeDistribution }, null, 2)}\n`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error("用法：npx tsx src/experiments/r5ReasoningAnalyze.ts <experiment-dir> [--labels <labels.json>]");
}

function main(): number {
  const argv = process.argv.slice(2);
  let experimentDir: string | undefined;
  let labelsPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--labels") {
      labelsPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--labels=")) {
      labelsPath = arg.slice("--labels=".length);
    } else if (arg.startsWith("--")) {
      // 未知 flag：忽略
    } else if (experimentDir === undefined) {
      experimentDir = arg;
    }
  }

  if (experimentDir === undefined) {
    printUsage();
    return 1;
  }
  if (labelsPath !== undefined && !fs.existsSync(labelsPath)) {
    console.error(`[FAIL] labels 文件不存在：${labelsPath}`);
    printUsage();
    return 1;
  }

  const outputPath = analyzeExperiment(experimentDir, labelsPath);
  const result = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { causeDistribution: CauseDistribution };

  console.log("===== late-offload cause 分布 =====");
  for (const cause of Object.keys(EMPTY_CAUSE_DISTRIBUTION) as LateOffloadCause[]) {
    console.log(`  ${cause}: ${result.causeDistribution[cause]}`);
  }
  console.log(`\n分析结果已写入: ${outputPath}`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error: unknown) {
    console.error("[FAIL]", (error as Error).message);
    process.exit(1);
  }
}
