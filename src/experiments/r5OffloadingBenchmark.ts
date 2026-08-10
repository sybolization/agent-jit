#!/usr/bin/env node

/**
 * R5 — Autonomous Offloading：模型自己决定是否把确定性工作 offload 给 JIT。
 *
 * 实验问题：**仅仅给 Agent 多一个 JIT 能力，它会不会自己正确使用？**
 * 因此不再告诉模型"请用 DSL 完成任务"，只告诉它"你拥有普通工具，以及 Agent JIT；
 * 当一段后续工作可以确定性程序化时可以选择 describe + execute，是否使用由你决定"。
 *
 * 两个 arm（其他条件完全一样）：
 * - control：普通 Agent + atomic tools；
 * - treatment：同一个 Agent + 相同 atomic tools + jit_describe_tools + jit_execute_program。
 * 不做 forced-JIT arm（R4 系列已有大量这类结果）。
 *
 * 三类任务（见 src/experiments/r5Tasks.ts）：
 * - A 不值得 JIT（单次调用）；B 明显值得 JIT（批量流水线）；C 混合型（语义判断 + 确定性段）。
 *
 * 新指标（在 task correctness / tokens / round trips / latency 之上）：
 * - JIT adoption rate：多少任务主动用了 JIT（path === "dsl"）；
 * - offload precision：该 JIT 的任务（B/C）中用了多少；
 * - unnecessary offload rate：一个工具就能解决的任务（A）是否反而 describe → execute 把事情搞复杂；
 * - compressed path length：一次 jit_execute_program 实际替代了多少原子操作
 *   （tool nodes + map fanout + compute/join/filter）。
 *
 * 工具调用循环由 pi-agent-core `Agent` 负责（普通工具与 jit_* 都是 AgentTool）——
 * harness 只做观测，对任何工具都没有特殊 dispatch（createPiTools 见 src/integrations/pi）。
 *
 * 运行：npx tsx src/experiments/r5OffloadingBenchmark.ts [--arm=both|control|treatment] [--task=A|B|C|all] [--samples=2] [--rounds=10]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime, type PiRuntime } from "../llm/gateway.js";
import { adaptRegisteredTool, createPiTools } from "../integrations/pi/toolAdapter.js";
import type { JitExecuteProgramDetails } from "../integrations/pi/jit.js";
import type { ExecutionGraph } from "../compiler/ir.js";
import type { TraceEntry } from "../runtime/trace.js";
import type { RegisteredTool } from "../tools/definition.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";
import { ToolRegistry } from "../tools/registry.js";
import { checkTaskCorrectness } from "./taskSpec.js";
import { runPiAgent } from "./agentRunner.js";
import { R5_TASKS, type R5Task } from "./r5Tasks.js";

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
// 系统提示词（两个 arm 唯一差异：是否告知 JIT 能力）
// ---------------------------------------------------------------------------

/** control 臂：普通 Agent，只有 atomic tools，完全不知道 JIT。 */
export function r5ControlSystemPrompt(): string {
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。",
    "使用提供的工具逐步完成；工具名与参数见工具定义。",
    "完成后，在回复文本中直接给出最终结果。",
  ].join("\n");
}

/** treatment 臂：普通工具 + Agent JIT；是否 offload 由模型自己决定。 */
export function r5TreatmentSystemPrompt(): string {
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。你有两类工具：",
    "",
    "## 普通业务工具（单次调用）",
    "系统已注册的业务工具可以直接调用（工具名与参数见工具定义），适合单次查询/操作。",
    "",
    "## Agent JIT 元工具（把确定性工作程序化）",
    `- ${DESCRIBE_TOOLS_TOOL.name}(tool_names=[...])：获取指定工具在 Agent Execution DSL 中的用法契约（输入参数 + 输出字段）；`,
    `- ${EXECUTE_PROGRAM_TOOL.name}(source="...")：提交一段 DSL 程序源码，编译并执行。`,
    "",
    "## 什么时候用 JIT，由你决定",
    "- 单个查询或几次调用就能完成：直接调用普通业务工具，不要用 JIT；",
    "- 一段后续工作可以确定性程序化（对列表每个元素做同样处理、过滤/排序/合并/取前 N 等）：可以先用 jit_describe_tools 获取要编排工具的契约，再写一段 DSL 程序，用 jit_execute_program 一次提交。",
    "",
    "## DSL 语法（newline 分隔语句，每条独占一行）",
    "<name> = <callee>(<参数>, ...)",
    "- <name>：变量名（[a-zA-Z_][a-zA-Z0-9_]*）",
    "- <callee>：已注册工具 id（canonical 或 host alias 均可），或语言关键字 map / take / filter / sort / compute / select / join / return",
    "- map：第二个参数是“绑定调用”：<工具>(<参数名>=_.<字段>)，把每个元素的 <字段> 传给该工具的 <参数名>",
    "- take：截取前 N 条；sort(key=\"<字段>\", desc=true)；filter 等值条件；compute(<源>, <字段>=\"<表达式>\"）；select(<源>, \"<谓词>\"）；join(<源1>, <源2>, ..., key=\"<字段>\")",
    "示例：",
    "items = demo.search_all(limit=10)",
    "details = map(items, demo.get_detail(key=_.id))",
    "top = take(details, 3)",
    "return top",
    "",
    "工具名两种写法等价：canonical（github.get_repository）与 host alias（github_get_repository），无需换算。",
    "",
    "## 结束方式",
    "- 用普通工具完成：在回复文本中直接给出最终结果。",
    "- 用 JIT 完成：程序以 return <变量> 结尾，通过 jit_execute_program 提交；提交后如有需要再给出总结。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// compressed path length：一次 JIT 执行替代了多少原子操作
// ---------------------------------------------------------------------------

export interface CompressedPath {
  toolNodes: number;
  mapNodes: number;
  /** map 的实际展开数（每个元素一次工具调用），来自执行 trace */
  fanoutSum: number;
  computeNodes: number;
  joinNodes: number;
  returnNodes: number;
  /** 原子操作总数：tool 节点 + map 展开执行数 + compute/join/return 各一 */
  atomicOps: number;
}

export function compressedPath(graph: ExecutionGraph, trace: readonly TraceEntry[]): CompressedPath {
  let toolNodes = 0;
  let mapNodes = 0;
  let computeNodes = 0;
  let joinNodes = 0;
  let returnNodes = 0;
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "tool":
        toolNodes += 1;
        break;
      case "map":
        mapNodes += 1;
        break;
      case "compute":
        computeNodes += 1;
        break;
      case "join":
        joinNodes += 1;
        break;
      case "return":
        returnNodes += 1;
        break;
    }
  }
  const fanoutSum = trace.filter((entry) => entry.kind === "map").reduce((sum, entry) => sum + (entry.fanout ?? 0), 0);
  return {
    toolNodes,
    mapNodes,
    fanoutSum,
    computeNodes,
    joinNodes,
    returnNodes,
    atomicOps: toolNodes + fanoutSum + computeNodes + joinNodes + returnNodes,
  };
}

function matchesOracle(haystack: string, oracle: readonly (string | RegExp)[]): boolean {
  return oracle.every((needle) =>
    typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack),
  );
}

// ---------------------------------------------------------------------------
// 单次运行
// ---------------------------------------------------------------------------

export type R5Arm = "control" | "treatment";

export interface R5RunMetrics {
  arm: R5Arm;
  taskId: "A" | "B" | "C";
  path: "dsl" | "ordinary" | "maxed_out";
  rounds: number;
  tokens: { input: number; output: number; cacheRead: number; total: number };
  latencyMs: number;
  /** 普通路径调用的业务工具（host alias，按序） */
  businessCalls: readonly string[];
  describeCalls: number;
  executeCalls: number;
  /** 最后一次成功执行 jit_execute_program 的程序记录 */
  lastProgram?: {
    source: string;
    dslCorrect: boolean | undefined;
    compressed?: CompressedPath;
  };
  /** 失败的 jit_execute_program 尝试（编译失败 / 执行失败的错误文本，截断，最多 5 条） */
  executeErrors?: readonly string[];
  answerCorrect: boolean;
  finalText: string;
  error?: string;
}

export async function runR5Run(
  task: R5Task,
  arm: R5Arm,
  runtime: PiRuntime,
  maxRounds = 10,
): Promise<R5RunMetrics> {
  const registry = new ToolRegistry<RegisteredTool>(task.tools);
  // 双 arm 唯一差异：control 只有 atomic tools；treatment 再挂上 jit_* 元工具
  const piTools = arm === "control" ? registry.all().map((tool) => adaptRegisteredTool(registry, tool)) : createPiTools(registry);

  let describeCalls = 0;
  let executeCalls = 0;
  const businessCalls: string[] = [];
  const executeErrors: string[] = [];
  let lastProgramDetails: JitExecuteProgramDetails | undefined;

  const run = await runPiAgent({
    systemPrompt: arm === "control" ? r5ControlSystemPrompt() : r5TreatmentSystemPrompt(),
    tools: piTools,
    prompt: task.prompt,
    runtime,
    maxRounds,
    onToolCall: ({ name }) => {
      if (name === DESCRIBE_TOOLS_TOOL.name) {
        describeCalls += 1;
        return;
      }
      if (name === EXECUTE_PROGRAM_TOOL.name) {
        executeCalls += 1;
        return;
      }
      businessCalls.push(name);
    },
    onToolEnd: ({ name, isError, result }) => {
      if (name !== EXECUTE_PROGRAM_TOOL.name) return;
      const details = (result as { details?: JitExecuteProgramDetails } | null)?.details;
      if (details && details.status === "success") {
        lastProgramDetails = details;
        return;
      }
      if (isError) {
        const text = (result as { content?: Array<{ text?: string }> } | null)?.content?.map((c) => c.text ?? "").join("") ?? "";
        if (text.trim() && executeErrors.length < 5) executeErrors.push(text.trim().slice(0, 300));
      }
    },
  });

  const path: R5RunMetrics["path"] = executeCalls > 0 ? "dsl" : run.maxedOut ? "maxed_out" : "ordinary";

  let lastProgram: R5RunMetrics["lastProgram"];
  let dslCorrect: boolean | undefined;
  let compressed: CompressedPath | undefined;
  if (lastProgramDetails) {
    dslCorrect = task.spec ? checkTaskCorrectness(lastProgramDetails.graph, task.spec).pass : undefined;
    compressed = compressedPath(lastProgramDetails.graph, lastProgramDetails.trace);
    lastProgram = {
      source: lastProgramDetails.source,
      dslCorrect,
      compressed,
    };
  }

  // 答案正确性：DSL 成功路径看程序结果 + 最终文本；其余看最终文本（oracle 全命中）
  const haystack =
    lastProgramDetails && path === "dsl"
      ? `${JSON.stringify(lastProgramDetails.result)}\n${run.finalText}`
      : run.finalText;
  const answerCorrect = matchesOracle(haystack, task.oracle);

  return {
    arm,
    taskId: task.id,
    path,
    rounds: run.rounds,
    tokens: run.tokens,
    latencyMs: run.latencyMs,
    businessCalls,
    describeCalls,
    executeCalls,
    ...(lastProgram ? { lastProgram } : {}),
    ...(executeErrors.length > 0 ? { executeErrors } : {}),
    answerCorrect,
    finalText: run.finalText,
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// 汇总指标
// ---------------------------------------------------------------------------

export interface R5Aggregate {
  arm: R5Arm;
  runs: number;
  /** JIT adoption rate：多少任务主动用了 JIT（path === "dsl"） */
  adoptionRate: number;
  /** offload precision：该 JIT 的任务（B/C）中主动用 JIT 的比例 */
  offloadPrecision: number;
  /** unnecessary offload rate：不该 JIT 的任务（A）中反而用 JIT 的比例 */
  unnecessaryOffloadRate: number;
  /** compressed path length：成功 JIT 执行的原子操作压缩数均值 */
  avgCompressedOps: number;
  avgRounds: number;
  avgTokens: number;
  correctRate: number;
}

export function aggregateR5(runs: readonly R5RunMetrics[], arm: R5Arm): R5Aggregate {
  const armRuns = runs.filter((run) => run.arm === arm);
  const total = armRuns.length;
  const adopted = armRuns.filter((run) => run.path === "dsl").length;
  const shouldOffload = armRuns.filter((run) => run.taskId !== "A").length;
  const shouldAndAdopted = armRuns.filter((run) => run.taskId !== "A" && run.path === "dsl").length;
  const aRuns = armRuns.filter((run) => run.taskId === "A").length;
  const aAdopted = armRuns.filter((run) => run.taskId === "A" && run.path === "dsl").length;
  const compressedOps = armRuns
    .filter((run) => run.path === "dsl" && run.lastProgram?.compressed)
    .map((run) => run.lastProgram!.compressed!.atomicOps);
  const avg = (values: number[]): number => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  return {
    arm,
    runs: total,
    adoptionRate: total > 0 ? adopted / total : 0,
    offloadPrecision: shouldOffload > 0 ? shouldAndAdopted / shouldOffload : 0,
    unnecessaryOffloadRate: aRuns > 0 ? aAdopted / aRuns : 0,
    avgCompressedOps: avg(compressedOps),
    avgRounds: avg(armRuns.map((run) => run.rounds)),
    avgTokens: avg(armRuns.map((run) => run.tokens.total)),
    correctRate: avg(armRuns.map((run) => (run.answerCorrect ? 1 : 0))),
  };
}

// ---------------------------------------------------------------------------
// 结果落盘：logs/experiments/r5-offloading-<ts>/report.json（与 r4e 等实验约定一致，
// logs/ 纳入版本控制——实验可复现性要求保留原始 report.json）
// ---------------------------------------------------------------------------

export interface R5ReportConfig {
  arm: R5Arm | "both";
  task: "A" | "B" | "C" | "all";
  samples: number;
  rounds: number;
}

/**
 * 把一次 R5 实验的结果完整写入 report.json：
 * 配置 + 任务元数据（prompt / oracle）+ 每个 run 的全部指标 + 双 arm 汇总。
 * 返回 report.json 的绝对路径。
 */
export function writeR5Report(
  outDir: string,
  config: R5ReportConfig,
  tasks: readonly R5Task[],
  runs: readonly R5RunMetrics[],
  aggregates: Record<R5Arm, R5Aggregate>,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r5-autonomous-offloading",
        config,
        model: "deepseek-chat",
        timestamp: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          prompt: task.prompt,
          oracle: task.oracle.map(String),
        })),
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

function parseFlags(argv: readonly string[]): { arm: R5Arm | "both"; task: "A" | "B" | "C" | "all"; samples: number; rounds: number } {
  const flags: { arm: R5Arm | "both"; task: "A" | "B" | "C" | "all"; samples: number; rounds: number } = {
    arm: "both",
    task: "all",
    samples: 1,
    rounds: 10,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "arm" && (value === "control" || value === "treatment" || value === "both")) flags.arm = value;
    if (key === "task" && (value === "A" || value === "B" || value === "C" || value === "all")) flags.task = value;
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
  }
  return flags;
}

const ARM_LABEL: Record<R5Arm, string> = {
  control: "Control（普通 Agent）",
  treatment: "Treatment（+ JIT）",
};

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { arm, task, samples, rounds } = parseFlags(process.argv.slice(2));
  const tasks = R5_TASKS.filter((item) => task === "all" || item.id === task);
  const arms: R5Arm[] = arm === "both" ? ["control", "treatment"] : [arm];
  const runtime = createDeepSeekPiRuntime();

  const runs: R5RunMetrics[] = [];
  for (const currentArm of arms) {
    for (const currentTask of tasks) {
      for (let i = 1; i <= samples; i += 1) {
        console.log(`\n===== [${currentArm}/${currentTask.id}] ${currentTask.name}（sample ${i}/${samples}）=====`);
        const run = await runR5Run(currentTask, currentArm, runtime, rounds);
        runs.push(run);
        console.log(`→ path=${run.path} rounds=${run.rounds} tokens=${run.tokens.total} latency=${run.latencyMs}ms answer=${run.answerCorrect ? "✓" : "✗"}`);
        console.log(`  describe=${run.describeCalls} execute=${run.executeCalls} business=[${run.businessCalls.join(", ") || "无"}]`);
        if (run.lastProgram) {
          console.log(`  DSL 正确：${run.lastProgram.dslCorrect === undefined ? "n/a" : run.lastProgram.dslCorrect}`);
          console.log(`  程序源码：\n${run.lastProgram.source.replace(/^/gm, "    ")}`);
          if (run.lastProgram.compressed) {
            const c = run.lastProgram.compressed;
            console.log(`  压缩路径：atomicOps=${c.atomicOps}（tool=${c.toolNodes} map=${c.mapNodes} fanout=${c.fanoutSum} compute=${c.computeNodes} join=${c.joinNodes} return=${c.returnNodes}）`);
          }
        }
        for (const errorText of run.executeErrors ?? []) {
          console.log(`  [execute 失败] ${errorText.replace(/\n/g, " ").slice(0, 200)}`);
        }
        if (run.finalText.trim()) console.log(`  最终文本：${run.finalText.slice(0, 300)}`);
      }
    }
  }

  console.log("\n\n===== R5 汇总 =====");
  const aggregates: Record<R5Arm, R5Aggregate> = {
    control: aggregateR5(runs, "control"),
    treatment: aggregateR5(runs, "treatment"),
  };
  for (const currentArm of arms) {
    const agg = aggregates[currentArm];
    console.log(`\n${ARM_LABEL[currentArm]}（${agg.runs} runs）`);
    console.log(`  JIT adoption rate：${(agg.adoptionRate * 100).toFixed(0)}%`);
    console.log(`  offload precision（B/C 中用了 JIT）：${(agg.offloadPrecision * 100).toFixed(0)}%`);
    console.log(`  unnecessary offload rate（A 反而用 JIT）：${(agg.unnecessaryOffloadRate * 100).toFixed(0)}%`);
    console.log(`  compressed path length（均值）：${agg.avgCompressedOps.toFixed(1)} 原子操作`);
    console.log(`  correct rate：${(agg.correctRate * 100).toFixed(0)}%`);
    console.log(`  avg rounds：${agg.avgRounds.toFixed(1)}；avg tokens：${Math.round(agg.avgTokens)}`);
  }

  const outDir = path.join(
    REPO_ROOT,
    "logs",
    "experiments",
    `r5-offloading-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const reportPath = writeR5Report(outDir, { arm, task, samples, rounds }, tasks, runs, aggregates);
  console.log(`\n报告已写入: ${reportPath}`);
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
