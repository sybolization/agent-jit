import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDsl, ExecutionDslCompileError } from "../compiler/compile.js";
import { renderExecutionToolCatalog } from "../compiler/catalog.js";
import { buildDslSystemPrompt as buildDslPrompt } from "../prompt/systemPrompt.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, JIT_META_TOOLS, describeToolsResult } from "../tools/jitTools.js";
import { githubTools } from "../tools/providers/github/contracts.js";
import type { RegisteredTool, ToolContract } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDeepSeekGateway, type LlmGateway, type LlmMessage, type LlmUsage } from "../llm/gateway.js";
import { mapLimit } from "../runtime/executor.js";
import { createRealGithubTools } from "../tools/providers/github/real.js";
import { execute } from "../runtime/runtime.js";
import { matchAnswer, runIterativeToolCalling, toPiToolName } from "./iterativeToolCalling.js";
import { checkTaskCorrectness } from "./taskSpec.js";

/**
 * R4b：Programmatic Tool Calling Benchmark。
 *
 * 同任务 / 同模型 / 同真实 GitHub 后端，对比两条执行架构随 fan-out
 * 复杂度（N=2/5/10/20）的指标增长：
 * - DSL 臂：一次 jit_execute_program + deterministic runtime 调度；
 * - Traditional 臂：迭代工具调用 agent loop。
 * 指标：round trips / exposed bytes / tokens / 端到端延迟 / task correctness。
 */

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
// 梯度任务集
// ---------------------------------------------------------------------------

const FANOUT_SIZES = [2, 5, 10, 20] as const;
const TAKE_COUNT = 3;

interface BenchmarkTask {
  n: number;
  k: number;
  dslPrompt: string;
  iterativePrompt: string;
  tools: readonly ToolContract[];
}

const GITHUB_QUERY = "agent framework language:typescript";

export function buildBenchmarkTasks(): BenchmarkTask[] {
  const tools = githubTools.filter((tool) =>
    ["github.search_repositories", "github.get_repository"].includes(tool.id),
  );
  return FANOUT_SIZES.map((n) => {
    const k = Math.min(TAKE_COUNT, n);
    return {
      n,
      k,
      dslPrompt:
        `请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 "${GITHUB_QUERY}"），` +
        `取前 ${n} 个，然后对每个仓库获取其详细信息（每个仓库元素的字段 full_name 要传给 github.get_repository 的 full_name 参数）。` +
        `最后截取前 ${k} 个作为最终结果并返回（return）。`,
      iterativePrompt:
        `使用提供的工具完成任务：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 "${GITHUB_QUERY}"），` +
        `取前 ${n} 个仓库，然后对每个仓库获取其详细信息。` +
        `最终在文本中给出前 ${k} 个仓库的完整名称（owner/repo），每条一行。`,
      tools,
    };
  });
}

/** ground truth：真实 search 的前 K 个 full_name（确定性，两臂共用）。 */
export async function fetchGroundTruth(searchTool: RegisteredTool, n: number, k: number): Promise<string[]> {
  const result = await searchTool.execute({ query: GITHUB_QUERY, limit: n });
  const items = Array.isArray(result) ? (result as Array<{ full_name: string }>) : [];
  return items.slice(0, k).map((item) => item.full_name);
}

// ---------------------------------------------------------------------------
// DSL 臂
// ---------------------------------------------------------------------------

function buildDslSystemPrompt(): string {
  return buildDslPrompt({
    constructs: ["map", "take", "return"],
  });
}

interface DslArmResult {
  ok: boolean;
  round_trips: number;
  exposed_bytes: number;
  llm_ms: number;
  runtime_ms: number;
  e2e_ms: number;
  usage: LlmUsage;
  answered: string[];
  task_pass: boolean;
  maxed_out: boolean;
}

async function runDslArm(
  gateway: LlmGateway,
  task: BenchmarkTask,
  maxRounds: number,
  tools: readonly RegisteredTool[],
  groundTruth: readonly string[],
): Promise<DslArmResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: buildDslSystemPrompt() },
    { role: "user", content: task.dslPrompt },
  ];
  const usage: LlmUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const started = performance.now();
  let llmMs = 0;
  let exposedBytes = 0;

  const taskSpec = {
    query: "agent framework",
    queryTokens: ["agent framework", "language:typescript"],
    limit: task.n,
    takeCount: task.k,
    bindings: { full_name: "full_name" },
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    const t0 = performance.now();
    const { content, toolCalls, usage: turnUsage } = await gateway.complete(messages, { tools: JIT_META_TOOLS });
    llmMs += performance.now() - t0;
    usage.input += turnUsage.input;
    usage.output += turnUsage.output;
    usage.cacheRead += turnUsage.cacheRead;
    usage.totalTokens += turnUsage.totalTokens;
    messages.push({ role: "assistant", content, toolCalls });

    // 元工具 dispatch：模型先调 jit_describe_tools 获取契约，再写程序提交
    const describe = toolCalls.find((call) => call.name === DESCRIBE_TOOLS_TOOL.name);
    if (describe) {
      messages.push(describeToolsResult(new ToolRegistry(task.tools), describe));
      continue;
    }

    const submit = toolCalls.find((call) => call.name === EXECUTE_PROGRAM_TOOL.name);
    const source = typeof submit?.arguments.source === "string" ? submit.arguments.source.trim() : "";
    if (!source) {
      messages.push({
        role: "user",
        content: `你没有通过 ${EXECUTE_PROGRAM_TOOL.name} 工具提交程序。请调用 ${EXECUTE_PROGRAM_TOOL.name} 工具，把完整 DSL 程序放在 source 参数里。`,
      });
      continue;
    }
    exposedBytes += Buffer.byteLength(source, "utf8");

    try {
      const { graph } = compileExecutionDsl(source, {
        tools: new ToolRegistry(task.tools),
      });
      const correctness = checkTaskCorrectness(graph, taskSpec);
      const registry = new ToolRegistry(tools);
      const t1 = performance.now();
      const execution = await execute(graph, registry);
      const runtimeMs = performance.now() - t1;

      const result = execution.status === "success" ? execution.result : undefined;
      const resultArray = Array.isArray(result) ? (result as unknown[]) : [];
      const answered = resultArray
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => String(item["full_name"] ?? ""));
      exposedBytes += Buffer.byteLength(JSON.stringify(resultArray), "utf8");

      return {
        ok: execution.status === "success",
        round_trips: round,
        exposed_bytes: exposedBytes,
        llm_ms: llmMs,
        runtime_ms: runtimeMs,
        e2e_ms: performance.now() - started,
        usage,
        answered,
        task_pass: matchAnswer(answered, groundTruth, task.k) && correctness.pass,
        maxed_out: false,
      };
    } catch (error) {
      if (error instanceof ExecutionDslCompileError) {
        const feedback = [
          "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
          ...error.diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
        ].join("\n");
        messages.push({ role: "toolResult", toolCallId: submit!.id, toolName: EXECUTE_PROGRAM_TOOL.name, content: feedback, isError: true });
        continue;
      }
      return {
        ok: false,
        round_trips: round,
        exposed_bytes: exposedBytes,
        llm_ms: llmMs,
        runtime_ms: 0,
        e2e_ms: performance.now() - started,
        usage,
        answered: [],
        task_pass: false,
        maxed_out: false,
      };
    }
  }

  return {
    ok: false,
    round_trips: maxRounds,
    exposed_bytes: exposedBytes,
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

interface ArmResult {
  ok: boolean;
  round_trips: number;
  exposed_bytes: number;
  llm_ms: number;
  /** DSL 臂以 runtime_ms 计量运行时，传统臂用 tool_ms——共用类型上 tool_ms 仅可选 */
  tool_ms?: number;
  e2e_ms: number;
  usage: LlmUsage;
  answered: string[];
  task_pass: boolean;
  maxed_out: boolean;
}

function parseArgs(argv: string[]): { samples: number; rounds: number; parallel: number } {
  const read = (name: string, fallback: string): string => {
    const eq = argv.find((item) => item.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const samples = Number(read("--samples", "10"));
  const rounds = Number(read("--rounds", "5"));
  const parallel = Number(read("--parallel", "4"));
  return {
    samples: Number.isInteger(samples) && samples > 0 ? samples : 10,
    rounds: Number.isInteger(rounds) && rounds > 0 ? rounds : 5,
    parallel: Number.isInteger(parallel) && parallel > 0 ? parallel : 4,
  };
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY || !process.env.GITHUB_TOKEN) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY 或 GITHUB_TOKEN（请在 .env 中配置）");
    return 1;
  }

  const { samples, rounds, parallel } = parseArgs(process.argv.slice(2));
  const gateway = createDeepSeekGateway();
  const realTools = createRealGithubTools();
  const tasks = buildBenchmarkTasks();

  // 预生成 ground truth（每档一次 search，两臂共用同一基准）
  const searchTool = realTools.find((tool) => tool.id === "github.search_repositories");
  if (!searchTool) {
    console.error("[FAIL] 未找到 github.search_repositories");
    return 1;
  }
  const groundTruthByN = new Map<number, string[]>();
  for (const task of tasks) {
    groundTruthByN.set(task.n, await fetchGroundTruth(searchTool, task.n, task.k));
  }
  console.log("ground truth:", [...groundTruthByN.entries()].map(([n, names]) => `N=${n}: [${names.join(", ")}]`).join("\n  "));

  const iterativeSystem = (task: BenchmarkTask): string =>
    [
      "你是一个 GitHub 数据分析助手。你可以调用以下工具获取数据：",
      renderExecutionToolCatalog(new ToolRegistry(task.tools), toPiToolName),
      "",
      "请依次调用工具完成任务；任务完成后，在最后一条回复的文本中给出答案（每条一行）。",
    ].join("\n");

  const arms = ["dsl", "iterative"] as const;
  const combos = arms.flatMap((arm) => tasks.map((task) => ({ arm, n: task.n })));
  const results = await mapLimit(combos, parallel, async ({ arm, n }) => {
    const task = tasks.find((item) => item.n === n)!;
    const groundTruth = groundTruthByN.get(n)!;
    const taskTools = realTools.filter((tool) => task.tools.some((spec) => spec.id === tool.id));
    const runs: ArmResult[] = [];
    for (let i = 0; i < samples; i += 1) {
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
              maxSteps: n + 10,
              groundTruth,
              required: task.k,
            });
      runs.push(run);
      process.stdout.write(
        `  [${arm}|N=${n}] 样本 ${i + 1}/${samples} ... ${run.task_pass ? "对" : "错"}（${run.round_trips} 次往返）\n`,
      );
    }
    return { arm, n, runs };
  });

  // 汇总
  console.log("\n\n===== R4b 汇总（DSL vs 迭代工具调用，真实 GitHub） =====");
  const header = ["臂", "N", "task%", "roundTrips", "exposedBytes", "tokens", "llmMs", "e2eMs", "失败"].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const { arm, n, runs } of results) {
    const ok = runs.filter((run) => run.ok);
    const tokens = Math.round(runs.reduce((sum, run) => sum + run.usage.totalTokens, 0) / runs.length);
    const llmMs = Math.round(runs.reduce((sum, run) => sum + run.llm_ms, 0) / runs.length);
    const taskRate = Math.round((runs.filter((run) => run.task_pass).length / runs.length) * 100);
    const roundTrips = Math.round((runs.reduce((sum, run) => sum + run.round_trips, 0) / runs.length) * 10) / 10;
    const exposed = Math.round(runs.reduce((sum, run) => sum + run.exposed_bytes, 0) / runs.length);
    const e2eMs = Math.round(runs.reduce((sum, run) => sum + run.e2e_ms, 0) / runs.length);
    const failed = runs.filter((run) => !run.ok || run.maxed_out).length;
    console.log([arm, String(n), `${taskRate}%`, String(roundTrips), String(exposed), String(tokens), String(llmMs), String(e2eMs), String(failed)].join(" | "));
  }

  const outDir = path.join(REPO_ROOT, "logs", "experiments", `programmatic-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify({ mode: "r4b-programmatic-benchmark", samples, groundTruth: Object.fromEntries(groundTruthByN), results }, null, 2)}\n`,
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
