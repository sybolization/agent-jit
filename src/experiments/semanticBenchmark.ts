#!/usr/bin/env node

/**
 * R4c：Semantic Dependency Scaling Benchmark（DSL vs 迭代工具调用）。
 *
 * 与 R4b 的区别：任务答案**必须**依赖 get_repository 返回的字段（forks），
 * 中间数据真实参与决策——search 结果不足以直接答题。任务计算深度分层：
 * - L1：search(N) → get_repository × N → sort(forks desc) → take 3 → return；
 * - L2：同上 + filter(archived=false, language="TypeScript") → sort → take 3。
 * 深度轴（L1/L2）× 成本轴（N∈{5,20}）= 4 cells。
 *
 * DSL 臂首次使用 filter / sort 两个新语言关键字（R4c 语言能力压力测试）；
 * iterative 臂必须把 N 个 detail 对象带进 context 完成筛选排序。
 * 指标沿用 R4b 的 tokens/llm_ms/e2e_ms，并把 exposed_bytes 拆成三份：
 * model_ingress_bytes（送进模型的输入累计）/ model_egress_bytes（模型输出累计）/
 * runtime_internal_bytes（留在 runtime 的中间数据，iterative 恒 0）。
 *
 * 运行：npx tsx src/experiments/semanticBenchmark.ts --samples=10 --rounds=5 --parallel=4
 * 环境：DEEPSEEK_API_KEY + GITHUB_TOKEN（.env，gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";

import { compileExecutionDsl, ExecutionDslCompileError } from "../compiler/compiler.js";
import { renderExecutionToolCatalog } from "../compiler/catalog.js";
import { githubTools, type ToolSpec } from "../compiler/registry.js";
import { createDeepSeekGateway, type LlmGateway, type LlmMessage, type LlmUsage } from "../llm/gateway.js";
import { compareValues, mapLimit } from "../runtime/executor.js";
import { createRealGithubTools } from "../runtime/githubAdapter.js";
import { execute, type RuntimeTool } from "../runtime/runtime.js";
import { matchAnswer, runIterativeToolCalling, sumMessageBytes, toPiToolName, type IterativeToolResult } from "./iterativeToolCalling.js";
import { checkTaskCorrectness } from "./taskSpec.js";

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
// 任务集（深度 × 成本梯度）
// ---------------------------------------------------------------------------

const GITHUB_QUERY = "agent framework language:typescript";
const TAKE_COUNT = 3;
const FANOUT_SIZES = [5, 20] as const;

export type R4cLevel = "L1" | "L2";

export interface R4cTask {
  level: R4cLevel;
  n: number;
  /** 最终要求答出的数量 = min(TAKE_COUNT, n) */
  k: number;
  takeCount: number;
  /** L2 的 filter 等值条件；L1 无 */
  filterConditions?: Record<string, unknown>;
  sortKey: string;
  sortDesc: boolean;
  dslPrompt: string;
  iterativePrompt: string;
  tools: readonly ToolSpec[];
}

export function buildR4cTasks(): R4cTask[] {
  const tools = githubTools.filter((tool) =>
    ["github.search_repositories", "github.get_repository"].includes(tool.id),
  );
  const cells: Array<{ level: R4cLevel; n: number }> = [
    { level: "L1", n: 5 },
    { level: "L1", n: 20 },
    { level: "L2", n: 5 },
    { level: "L2", n: 20 },
  ];
  return cells.map(({ level, n }) => {
    const k = Math.min(TAKE_COUNT, n);
    const filterConditions = level === "L2" ? { archived: false, language: "TypeScript" } : undefined;
    const filterPhrase =
      level === "L2"
        ? "只保留 archived=false 且 language=\"TypeScript\" 的仓库，"
        : "";
    return {
      level,
      n,
      k,
      takeCount: TAKE_COUNT,
      filterConditions,
      sortKey: "forks",
      sortDesc: true,
      dslPrompt:
        `请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 "${GITHUB_QUERY}"），` +
        `取前 ${n} 个，然后对每个仓库获取其详细信息（把每个元素的 full_name 传给 github.get_repository 的 full_name 参数）。` +
        `${filterPhrase}最后按 forks 字段从高到低排序（sort key="forks", desc=true），截取前 ${k} 个作为最终结果并返回（return）。`,
      iterativePrompt:
        `使用提供的工具完成任务：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 "${GITHUB_QUERY}"），` +
        `取前 ${n} 个仓库，然后对每个仓库获取其详细信息。` +
        `${filterPhrase}最后按 forks 从高到低排序，在文本中给出前 ${k} 个仓库的完整名称（owner/repo），每条一行。`,
      tools,
    };
  });
}

// ---------------------------------------------------------------------------
// 确定性答案（oracle）：两臂共用同一 ground truth
// ---------------------------------------------------------------------------

export interface RepoDetail {
  full_name: string;
  stars: number;
  forks: number;
  archived: boolean;
  language: string;
}

/** 纯函数：filter → sort → take → full_name。与 executor 的 compute 语义共用 compareValues。 */
export function computeDeterministicAnswer(
  details: readonly RepoDetail[],
  task: Pick<R4cTask, "filterConditions" | "sortKey" | "sortDesc" | "takeCount">,
): string[] {
  let working = [...details];
  if (task.filterConditions) {
    working = working.filter((item) =>
      Object.entries(task.filterConditions).every(
        ([field, literal]) => (item as unknown as Record<string, unknown>)[field] === literal,
      ),
    );
  }
  const key = task.sortKey;
  const desc = task.sortDesc;
  working.sort((left, right) => {
    const base = compareValues(
      (left as unknown as Record<string, unknown>)[key],
      (right as unknown as Record<string, unknown>)[key],
    );
    return desc ? -base : base;
  });
  return working.slice(0, task.takeCount).map((item) => item.full_name);
}

/** ground truth：真实 search(limit=n) → 并行 get_repository × n → 确定性答案。 */
export async function fetchR4cGroundTruth(
  searchTool: RuntimeTool,
  repoTool: RuntimeTool,
  task: R4cTask,
): Promise<string[]> {
  const result = await searchTool.execute({ query: GITHUB_QUERY, limit: task.n });
  const items = Array.isArray(result) ? (result as Array<{ full_name: string }>) : [];
  const details = await mapLimit(items, 5, async (item) => {
    const detail = await repoTool.execute({ full_name: item.full_name });
    return detail as RepoDetail;
  });
  return computeDeterministicAnswer(details, task);
}

// ---------------------------------------------------------------------------
// DSL 臂
// ---------------------------------------------------------------------------

const SUBMIT_PROGRAM_TOOL: Tool = {
  name: "submit_program",
  description:
    "提交一段 Agent Execution DSL 程序源码给 Harness 编译执行。这是唯一允许的提交方式——把完整程序放在 source 参数里，不要直接写在回复文本中。",
  parameters: Type.Object({
    source: Type.String({ description: "Agent Execution DSL 程序源码（每条语句独占一行）" }),
  }),
};

function buildDslSystemPrompt(task: R4cTask): string {
  return [
    "你是一名 Agent Execution DSL 编程助手。你的任务是用下面这门小语言写出程序，程序会被编译并在 Harness 上执行。",
    "",
    "## 语法（newline 分隔语句，每条独占一行）",
    "<name> = <callee>(<参数>, ...)",
    "- <name>：变量名（[a-zA-Z_][a-zA-Z0-9_]*），变量名即图中的节点",
    "- <callee>：已注册工具 id，或语言关键字 map / take / filter / sort / return",
    "- <value>：字符串（双引号）、数字、布尔、null，或先前定义的变量名（裸标识符即引用，定义数据流边）",
    "- take：第一个位置参数是源数组，第二个位置参数是截取条数",
    "- filter：第一个位置参数是源数组，其余参数是等值条件（<字段>=<字面量>），保留满足全部条件的元素",
    "  示例：active = filter(details, archived=false, language=\"TypeScript\")",
    "- sort：第一个位置参数是源数组，key=<字段名> 必填（字符串字面量），desc=true|false 可选（默认升序）",
    "  示例：ranked = sort(active, key=\"forks\", desc=true)",
    "- return：直接写要返回的变量名（如 return top）",
    "- map：第一个位置参数是源数组，第二个位置参数是一个“绑定调用”：<工具id>(<参数名>=_.<字段>)，表示把每个元素的 <字段> 传给该工具的 <参数名>",
    "  示例：map(repos, github.get_repository(full_name=_.full_name))",
    "",
    "## 可用工具",
    renderExecutionToolCatalog(task.tools),
    "",
    "## 硬约束",
    "1. 必须通过调用 submit_program 工具提交程序（把 DSL 源码放在 source 参数里）；不要直接在回复文本中输出代码或 Markdown",
    "2. 参数名必须与工具目录完全一致，不得自创参数名",
    "3. 变量必须先定义再引用（不允许前向引用）",
    "4. 编译失败时，根据返回的诊断修正 DSL，再次调用 submit_program 重新提交，直到成功为止",
  ].join("\n");
}

interface DslArmResult {
  ok: boolean;
  round_trips: number;
  model_ingress_bytes: number;
  model_egress_bytes: number;
  runtime_internal_bytes: number;
  llm_ms: number;
  runtime_ms: number;
  e2e_ms: number;
  usage: LlmUsage;
  answered: string[];
  task_pass: boolean;
  maxed_out: boolean;
  /** 非编译错误（执行期/API）时记录错误信息，供报告诊断 */
  error?: string;
}

async function runDslArm(
  gateway: LlmGateway,
  task: R4cTask,
  maxRounds: number,
  tools: readonly RuntimeTool[],
  groundTruth: readonly string[],
): Promise<DslArmResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: buildDslSystemPrompt(task) },
    { role: "user", content: task.dslPrompt },
  ];
  const usage: LlmUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const started = performance.now();
  let llmMs = 0;
  let modelIngressBytes = 0;
  let modelEgressBytes = 0;

  // 记录 runtime 内部产生的工具结果字节（中间数据留在 runtime，不经模型）
  const runtimeInternal = { bytes: 0 };
  const recordingTools: RuntimeTool[] = tools.map((tool) => ({
    spec: tool.spec,
    execute: async (args) => {
      const result = await tool.execute(args);
      runtimeInternal.bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      return result;
    },
  }));

  const taskSpec = {
    query: "agent framework",
    queryTokens: ["agent framework", "language:typescript"],
    limit: task.n,
    takeCount: task.k,
    bindings: { full_name: "full_name" },
    filterConditions: task.filterConditions,
    sortKey: task.sortKey,
    sortDesc: task.sortDesc,
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    modelIngressBytes += sumMessageBytes(messages);
    const t0 = performance.now();
    const { content, toolCalls, usage: turnUsage } = await gateway.complete(messages, { tools: [SUBMIT_PROGRAM_TOOL] });
    llmMs += performance.now() - t0;
    modelEgressBytes +=
      Buffer.byteLength(content, "utf8") +
      toolCalls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments), "utf8"), 0);
    usage.input += turnUsage.input;
    usage.output += turnUsage.output;
    usage.cacheRead += turnUsage.cacheRead;
    usage.totalTokens += turnUsage.totalTokens;
    messages.push({ role: "assistant", content, toolCalls });

    const submit = toolCalls.find((call) => call.name === "submit_program");
    const source = typeof submit?.arguments.source === "string" ? submit.arguments.source.trim() : "";
    if (!source) {
      messages.push({
        role: "user",
        content: "你没有通过 submit_program 工具提交程序。请调用 submit_program 工具，把完整 DSL 程序放在 source 参数里。",
      });
      continue;
    }

    try {
      const { graph } = compileExecutionDsl(source, {
        tools: task.tools,
        allowCallableRef: false,
        allowPositionalArgs: true,
        allowMapBinding: "call",
      });
      const correctness = checkTaskCorrectness(graph, taskSpec);
      const registry = new Map(recordingTools.map((tool) => [tool.spec.id, tool]));
      const t1 = performance.now();
      const execution = await execute(graph, registry);
      const runtimeMs = performance.now() - t1;

      const resultArray = Array.isArray(execution.result) ? (execution.result as unknown[]) : [];
      const answered = resultArray
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => String(item["full_name"] ?? ""));

      return {
        ok: execution.ok,
        round_trips: round,
        model_ingress_bytes: modelIngressBytes,
        model_egress_bytes: modelEgressBytes,
        runtime_internal_bytes: runtimeInternal.bytes,
        llm_ms: llmMs,
        runtime_ms: runtimeMs,
        e2e_ms: performance.now() - started,
        usage,
        answered,
        task_pass: matchAnswer(answered, groundTruth, Math.min(3, groundTruth.length)) && correctness.pass,
        maxed_out: false,
      };
    } catch (error) {
      if (error instanceof ExecutionDslCompileError) {
        const feedback = [
          "编译失败，请根据以下诊断修正 DSL 后再次调用 submit_program 重新提交：",
          ...error.diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
        ].join("\n");
        messages.push({ role: "toolResult", toolCallId: submit.id, toolName: "submit_program", content: feedback, isError: true });
        continue;
      }
      return {
        ok: false,
        round_trips: round,
        model_ingress_bytes: modelIngressBytes,
        model_egress_bytes: modelEgressBytes,
        runtime_internal_bytes: runtimeInternal.bytes,
        llm_ms: llmMs,
        runtime_ms: 0,
        e2e_ms: performance.now() - started,
        usage,
        answered: [],
        task_pass: false,
        maxed_out: false,
        error: (error as Error).message,
      };
    }
  }

  return {
    ok: false,
    round_trips: maxRounds,
    model_ingress_bytes: modelIngressBytes,
    model_egress_bytes: modelEgressBytes,
    runtime_internal_bytes: runtimeInternal.bytes,
    llm_ms: llmMs,
    runtime_ms: 0,
    e2e_ms: performance.now() - started,
    usage,
    answered: [],
    task_pass: false,
    maxed_out: true,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

interface ArmResult extends DslArmResult {
  tool_ms: number;
  /** iterative 臂的最终文本（诊断用） */
  final_text?: string;
}

function parseArgs(argv: string[]): { samples: number; rounds: number; parallel: number; pacing: number } {
  const read = (name: string, fallback: string): string => {
    const eq = argv.find((item) => item.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const samples = Number(read("--samples", "10"));
  const rounds = Number(read("--rounds", "5"));
  const parallel = Number(read("--parallel", "4"));
  const pacing = Number(read("--pacing", "1000"));
  return {
    samples: Number.isInteger(samples) && samples > 0 ? samples : 10,
    rounds: Number.isInteger(rounds) && rounds > 0 ? rounds : 5,
    parallel: Number.isInteger(parallel) && parallel > 0 ? parallel : 4,
    pacing: Number.isFinite(pacing) && pacing >= 0 ? pacing : 1000,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY || !process.env.GITHUB_TOKEN) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY 或 GITHUB_TOKEN（请在 .env 中配置）");
    return 1;
  }

  const { samples, rounds, parallel, pacing } = parseArgs(process.argv.slice(2));
  const gateway = createDeepSeekGateway();
  const realTools = createRealGithubTools();
  const tasks = buildR4cTasks();

  const searchTool = realTools.find((tool) => tool.spec.id === "github.search_repositories");
  const repoTool = realTools.find((tool) => tool.spec.id === "github.get_repository");
  if (!searchTool || !repoTool) {
    console.error("[FAIL] 未找到 github.search_repositories / github.get_repository");
    return 1;
  }

  // 每 cell 一次 ground truth 快照（真实 search + 并行 get_repository），两臂共用
  const groundTruthByCell = new Map<string, string[]>();
  for (const task of tasks) {
    const key = `${task.level}|${task.n}`;
    groundTruthByCell.set(key, await fetchR4cGroundTruth(searchTool, repoTool, task));
  }
  console.log("ground truth:");
  for (const [key, names] of groundTruthByCell) {
    console.log(`  ${key}: [${names.join(", ")}]`);
  }

  const iterativeSystem = (task: R4cTask): string =>
    [
      "你是一个 GitHub 数据分析助手。你可以调用以下工具获取数据：",
      renderExecutionToolCatalog(task.tools, toPiToolName),
      "",
      "请依次调用工具完成任务；任务完成后，在最后一条回复的文本中给出答案（每条一行）。",
    ].join("\n");

  const arms = ["dsl", "iterative"] as const;
  const combos = arms.flatMap((arm) => tasks.map((task) => ({ arm, task })));
  const results = await mapLimit(combos, parallel, async ({ arm, task }) => {
    const groundTruth = groundTruthByCell.get(`${task.level}|${task.n}`)!;
    const taskTools = realTools.filter((tool) => task.tools.some((spec) => spec.id === tool.spec.id));
    const runs: ArmResult[] = [];
    for (let i = 0; i < samples; i += 1) {
      // pacing：样本间间隔，避免相同 query 高频命中 GitHub 搜索限流
      if (i > 0) await sleep(pacing);
      const run =
        arm === "dsl"
          ? await runDslArm(gateway, task, rounds, taskTools, groundTruth)
          : await runIterativeToolCalling({
              gateway,
              initialMessages: [
                { role: "system", content: iterativeSystem(task) },
                { role: "user", content: task.iterativePrompt },
              ],
              tools: taskTools,
              toolSpecs: task.tools,
              maxSteps: task.n + 10,
              groundTruth,
              required: Math.min(3, groundTruth.length),
              minConsecutiveNoTool: 1,
            });
      const toolMs = arm === "dsl" ? (run as DslArmResult).runtime_ms : (run as { tool_ms: number }).tool_ms;
      runs.push({
        ...(run as DslArmResult),
        tool_ms: toolMs,
        ...(arm === "iterative" ? { final_text: (run as IterativeToolResult).final_text } : {}),
      });
      process.stdout.write(
        `  [${arm}|${task.level}|N=${task.n}] 样本 ${i + 1}/${samples} ... ${run.task_pass ? "对" : "错"}（${run.round_trips} 次往返）\n`,
      );
    }
    return { arm, task, runs };
  });

  // 汇总
  console.log("\n\n===== R4c 汇总（DSL vs 迭代工具调用，语义依赖梯度，真实 GitHub） =====");
  const header = [
    "臂", "层级", "N", "task%", "roundTrips", "modelIngress", "modelEgress", "runtimeInternal",
    "tokens", "llmMs", "execMs", "e2eMs", "失败",
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const { arm, task, runs } of results) {
    const taskRate = Math.round((runs.filter((run) => run.task_pass).length / runs.length) * 100);
    const avg = (pick: (run: ArmResult) => number): number => Math.round(runs.reduce((sum, run) => sum + pick(run), 0) / runs.length);
    const roundTrips = Math.round((runs.reduce((sum, run) => sum + run.round_trips, 0) / runs.length) * 10) / 10;
    const failed = runs.filter((run) => !run.ok || run.maxed_out).length;
    const execMs = arm === "dsl" ? avg((run) => run.runtime_ms) : avg((run) => run.tool_ms);
    console.log(
      [
        arm, task.level, String(task.n), `${taskRate}%`, String(roundTrips),
        String(avg((run) => run.model_ingress_bytes)), String(avg((run) => run.model_egress_bytes)),
        String(avg((run) => run.runtime_internal_bytes)), String(avg((run) => run.usage.totalTokens)),
        String(avg((run) => run.llm_ms)), String(execMs), String(avg((run) => run.e2e_ms)), String(failed),
      ].join(" | "),
    );
  }

  const outDir = path.join(REPO_ROOT, "logs", "experiments", `semantic-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        mode: "r4c-semantic-benchmark",
        samples,
        groundTruth: Object.fromEntries(groundTruthByCell),
        results: results.map(({ arm, task, runs }) => ({ arm, level: task.level, n: task.n, runs })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n报告已写入: ${path.join(outDir, "report.json")}`);
  return 0;
}

// 入口守卫：被测试 import 时不触发 main
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[FAIL]", (error as Error).message);
      process.exit(1);
    });
}
