#!/usr/bin/env node

/**
 * R7 — Zero-Prompt Routing Discovery Benchmark。
 *
 * 实验问题：DSH 上 `dsl.systemPrompt:false` 时模型几乎不路由到
 * jit_execute_program。R7 把 when/why/how 从 system prompt 迁到工具面，
 * 测量各信息位置下的自主路由质量与固定上下文成本。
 *
 * 臂（全部 stopAfterSubmit + reasoning OFF + 边界策略不进 system prompt）：
 * - C0 control：无 JIT 工具；
 * - T0 baseline：JIT 工具 + 当前一句话描述，无 system prompt；
 * - T1 trigger：execute 描述增加 when/why；
 * - T2 lazy-manual：trigger + 首次 describe 附中性 DSL manual；
 * - T3 tool-embedded：trigger + 完整中性 DSL manual 进 execute 描述；
 * - T4 tool-embedded-mini：trigger + 极简 DSL manual 进 execute 描述；
 * - P0 positive control：systemPrompt:true + neutral DSL manual + inline DSL signatures。
 *
 * 任务：A/B（development，来自 R5）+ H（holdout shipment 域，异名多字段绑定）。
 * 防 overfit：候选文案由 src/prompt/routingToolPrompts.ts 生成并通过
 * tests/routingToolPrompts.test.ts 的 benchmark 泄漏断言；最终结论只认 H。
 *
 * 运行：npx tsx src/experiments/r7RoutingBenchmark.ts [--task=A|B|H|all] [--arm=all|C0,T0,T1,T2,T3,T4,P0] [--samples=1] [--rounds=10]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime, type PiRuntime } from "../llm/gateway.js";
import type { DescribeDslReferenceMode, RoutingPromptVariant } from "../prompt/routingToolPrompts.js";
import { r5ControlSystemPrompt, runR5Run } from "./r5OffloadingBenchmark.js";
import { aggregateR5 } from "./shared/agentJitRun.js";
import type { R5RunMetrics } from "./shared/types.js";
import type { R5Task, R5TaskId } from "./r5Tasks.js";
import { createR7HTask, r7DevelopmentTasks, type R7Task, type R7TaskId } from "./r7Tasks.js";

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

export type R7ArmId = "C0" | "T0" | "T1" | "T2" | "T3" | "T4" | "P0";

/** 带实验臂与样本编号的 run 标注（report.json 的 runs 元素）。 */
export type R7AnnotatedRun = R5RunMetrics & { r7Arm: R7ArmId; sampleIndex: number };

/** --resume 读取的 partial report 结构（宽松，允许旧报告无 sampleIndex）。 */
export interface R7ResumeReport {
  mode?: string;
  runs?: Array<Partial<R5RunMetrics> & { r7Arm?: string; sampleIndex?: number }>;
}

export interface R7ResumeState {
  runsByCell: Map<string, R7AnnotatedRun[]>;
  completedSamplesByCell: Map<string, Set<number>>;
}

/**
 * 从 partial report 构建 resume state（纯函数）。
 * - 旧报告没有 sampleIndex：每个 cell 内 run 按追加顺序天然对应 sample 1..N，顺序回填；
 * - mode 不是 r7-routing-discovery 时抛错。
 */
export function buildR7ResumeState(resumed: R7ResumeReport): R7ResumeState {
  if (resumed.mode !== "r7-routing-discovery") {
    throw new Error(`--resume 目标不是 R7 report（mode=${resumed.mode ?? "unknown"}）`);
  }
  const runsByCell = new Map<string, R7AnnotatedRun[]>();
  const completedSamplesByCell = new Map<string, Set<number>>();
  const legacyCounters = new Map<string, number>();
  for (const run of resumed.runs ?? []) {
    if (run.r7Arm === undefined) continue;
    const cellKey = `${run.r7Arm}/${run.taskId}`;
    const legacyNext = (legacyCounters.get(cellKey) ?? 0) + 1;
    legacyCounters.set(cellKey, legacyNext);
    const sampleIndex = run.sampleIndex ?? legacyNext;
    runsByCell.set(cellKey, [...(runsByCell.get(cellKey) ?? []), { ...run, r7Arm: run.r7Arm as R7ArmId, sampleIndex } as R7AnnotatedRun]);
    const sampleSet = completedSamplesByCell.get(cellKey) ?? new Set<number>();
    sampleSet.add(sampleIndex);
    completedSamplesByCell.set(cellKey, sampleSet);
  }
  return { runsByCell, completedSamplesByCell };
}

interface R7ArmDef {
  id: R7ArmId;
  label: string;
  /** control = 普通 Agent；tool-surface = treatment 且 system prompt 与 control 完全一致；positive = system prompt 告知 JIT。 */
  kind: "control" | "tool-surface" | "positive";
  routingPrompt?: RoutingPromptVariant;
  describeDslReference?: DescribeDslReferenceMode;
}

export const R7_ARMS: readonly R7ArmDef[] = [
  { id: "C0", label: "C0 control（无 JIT）", kind: "control" },
  { id: "T0", label: "T0 baseline（无提示词 + 现状描述）", kind: "tool-surface", routingPrompt: "baseline", describeDslReference: "none" },
  { id: "T1", label: "T1 trigger（只补 when/why）", kind: "tool-surface", routingPrompt: "trigger", describeDslReference: "none" },
  { id: "T2", label: "T2 lazy-manual（trigger + describe 附 manual）", kind: "tool-surface", routingPrompt: "trigger", describeDslReference: "first-call" },
  { id: "T3", label: "T3 tool-embedded（trigger + 完整 manual）", kind: "tool-surface", routingPrompt: "tool-embedded", describeDslReference: "none" },
  { id: "T4", label: "T4 tool-embedded-mini（trigger + 极简 manual）", kind: "tool-surface", routingPrompt: "tool-embedded-mini", describeDslReference: "none" },
  { id: "P0", label: "P0 positive（system prompt neutral + inline signatures）", kind: "positive" },
];

export interface R7CliFlags {
  task: R7TaskId | "all";
  arms: readonly R7ArmId[];
  samples: number;
  rounds: number;
  /** 断点续跑：已有 report.json 的目录（相对 REPO_ROOT 或绝对路径）。 */
  resume?: string;
}

export function parseR7Flags(argv: readonly string[]): R7CliFlags {
  const flags: R7CliFlags = { task: "all", arms: R7_ARMS.map((arm) => arm.id), samples: 1, rounds: 10 };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "task" && (value === "A" || value === "B" || value === "H" || value === "all")) flags.task = value;
    if (key === "arm") {
      const ids = (value ?? "").split(",").filter((id): id is R7ArmId => (R7_ARMS.map((arm) => arm.id) as string[]).includes(id));
      if (ids.length > 0) flags.arms = ids;
    }
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
    if (key === "resume" && value !== undefined && value.length > 0) flags.resume = value;
  }
  return flags;
}

function selectedTasks(task: R7TaskId | "all"): readonly R7Task[] {
  if (task === "H") return [createR7HTask()];
  const development = r7DevelopmentTasks().filter((item) => task === "all" || item.id === task);
  return task === "all" ? [...development, createR7HTask()] : development;
}

function runOptionsForArm(arm: R7ArmDef): Parameters<typeof runR5Run>[4] {
  if (arm.kind === "control") {
    return { systemPromptOverride: r5ControlSystemPrompt(), stopAfterSubmit: true };
  }
  if (arm.kind === "positive") {
    return {
      contractMode: "eager-signatures",
      stopAfterSubmit: true,
      boundaryPolicy: false,
    };
  }
  // tool-surface：system prompt 与 control 完全一致，所有信息只来自工具定义。
  return {
    systemPromptOverride: r5ControlSystemPrompt(),
    routingPrompt: arm.routingPrompt,
    describeDslReference: arm.describeDslReference,
    describeTools: true,
    dslSignatures: true,
    stopAfterSubmit: true,
  };
}

function formatCell(arm: R7ArmDef, taskId: R7TaskId, runs: readonly R5RunMetrics[]): void {
  const aggregate = aggregateR5(runs, arm.kind === "control" ? "control" : "treatment", taskId as R5TaskId);
  const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
  console.log(
    `  [${arm.id}/${taskId}] runs=${aggregate.runs} ` +
      `taskCompleted=${pct(aggregate.taskCompletionRate)} ` +
      `adoption=${pct(aggregate.adoptionRate)} ` +
      `precision=${pct(aggregate.offloadPrecision)} ` +
      `clean=${pct(aggregate.cleanOffloadRate)} ` +
      `unnecessary=${pct(aggregate.unnecessaryOffloadRate ?? 0)} ` +
      `avgTokens=${Math.round(aggregate.avgTokens)} ` +
      `avgRounds=${aggregate.avgRounds.toFixed(1)}`,
  );
}

function efficiencyScore(runs: readonly R5RunMetrics[], taskId: R7TaskId, armKind: R7ArmDef["kind"]): number {
  const aggregate = aggregateR5(runs, armKind === "control" ? "control" : "treatment", taskId as R5TaskId);
  return aggregate.taskCompletionRate > 0 ? aggregate.avgTokens / aggregate.taskCompletionRate : Number.POSITIVE_INFINITY;
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const flags = parseR7Flags(process.argv.slice(2));
  const tasks = selectedTasks(flags.task);
  const arms = R7_ARMS.filter((arm) => flags.arms.includes(arm.id));
  const runtime: PiRuntime = createDeepSeekPiRuntime({ reasoning: false });

  console.log(`[R7] task=${flags.task} arms=${arms.map((arm) => arm.id).join(",")} samples=${flags.samples} rounds=${flags.rounds}`);

  const outDir = flags.resume === undefined
    ? path.join(REPO_ROOT, "logs", "experiments", `r7-routing-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    : path.resolve(REPO_ROOT, flags.resume);
  const reportPath = path.join(outDir, "report.json");
  fs.mkdirSync(outDir, { recursive: true });

  let runsByCell = new Map<string, R7AnnotatedRun[]>();
  let completedSamplesByCell = new Map<string, Set<number>>();
  if (flags.resume !== undefined && fs.existsSync(reportPath)) {
    const resumed = JSON.parse(fs.readFileSync(reportPath, "utf8")) as R7ResumeReport;
    const state = buildR7ResumeState(resumed);
    runsByCell = state.runsByCell;
    completedSamplesByCell = state.completedSamplesByCell;
    console.log(`[R7 resume] 已载入 ${runsByCell.size} 个 cell 的 ${[...runsByCell.values()].flat().length} 条历史 run`);
  }

  const totalRuns = tasks.length * arms.length * flags.samples;
  let completedRuns = [...runsByCell.values()].flat().length;

  const writePartialReport = (): void => {
    const allRuns = [...runsByCell.values()].flat();
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          mode: "r7-routing-discovery",
          config: {
            task: flags.task,
            arms: flags.arms,
            samples: flags.samples,
            rounds: flags.rounds,
            protocol: { reasoning: "off", stopAfterSubmit: true, boundaryPolicy: "none-in-system-prompt" },
          },
          model: "deepseek-v4-flash",
          timestamp: new Date().toISOString(),
          armDefs: arms.map((arm) => ({
            id: arm.id,
            label: arm.label,
            kind: arm.kind,
            routingPrompt: arm.routingPrompt ?? null,
            describeDslReference: arm.describeDslReference ?? null,
          })),
          tasks: tasks.map((task) => ({
            id: task.id,
            name: task.name,
            prompt: task.prompt,
            oracle: task.oracle.map(String),
          })),
          aggregates: Object.fromEntries(
            arms.map((arm) => [
              `${arm.id}`,
              Object.fromEntries(
                tasks.map((task) => {
                  const cellRuns = runsByCell.get(`${arm.id}/${task.id}`) ?? [];
                  return [
                    task.id,
                    {
                      ...aggregateR5(cellRuns, arm.kind === "control" ? "control" : "treatment", task.id as R5TaskId),
                      efficiencyScore: efficiencyScore(cellRuns, task.id, arm.kind),
                    },
                  ];
                }),
              ),
            ]),
          ),
          runs: allRuns,
        },
        null,
        2,
      )}\n`,
    );
  };

  for (const task of tasks) {
    for (let sample = 1; sample <= flags.samples; sample += 1) {
      // 时间漂移控制：奇数样本按 C0→P0，偶数样本逆序。
      const orderedArms = sample % 2 === 1 ? arms : [...arms].reverse();
      for (const arm of orderedArms) {
        const cellKey = `${arm.id}/${task.id}`;
        if (completedSamplesByCell.get(cellKey)?.has(sample) === true) continue;
        completedRuns += 1;
        console.log(`\n===== [${arm.id}/${task.id}] ${arm.label}（sample ${sample}/${flags.samples}，overall ${completedRuns}/${totalRuns}）=====`);
        const run = await runR5Run(task as R5Task, arm.kind === "control" ? "control" : "treatment", runtime, flags.rounds, runOptionsForArm(arm));
        runsByCell.set(cellKey, [...(runsByCell.get(cellKey) ?? []), { ...run, r7Arm: arm.id, sampleIndex: sample }]);
        writePartialReport();
        console.log(
          `→ rounds=${run.rounds} tokens=${run.tokens.total} answer=${run.answerCorrect ? "✓" : "✗"} ` +
            `completed=${run.taskCompleted ? "✓" : "✗"} ` +
            `jitAttempted=${run.jitAttempted} semantic=${run.jitSemanticCorrect === undefined ? "n/a" : run.jitSemanticCorrect} ` +
            `describe=${run.describeCalls} execute=${run.executeCalls}`,
        );
      }
    }
  }

  console.log("\n===== R7 aggregate =====");
  for (const task of tasks) {
    for (const arm of arms) formatCell(arm, task.id, runsByCell.get(`${arm.id}/${task.id}`) ?? []);
  }
  console.log(`\n[report] ${reportPath}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
