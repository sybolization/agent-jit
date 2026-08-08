#!/usr/bin/env node

/**
 * R4e：Branching + Recombination Benchmark（DSL vs 迭代工具调用）。
 *
 * 与 R4d（深而直的流水线）不同，R4e 增加四种复杂度：
 * - Dependency depth：4 层（details → 分支决策 → 阶段工具 → join → 最终计算）；
 * - Branching factor：2 条路径（ratio>0.15 → contributors；否则 → commits）；
 * - Recombination burden：3 来源（details + 两路 score）按 full_name 合并；
 * - State cardinality：N 个对象 ×（ratio + 分组 + score）。
 *
 * 数据后端：**可控 mock/adversarial dataset**（createAdversarialGithubTools）——
 * 保证"分错一次支 / 漏掉 join / 用错字段 / 漏掉阈值"任一错误 → 最终答案必变。
 * 两路工具产出同名字段 score（统一尺度），join 后直接按 score 排序。
 *
 * DSL 臂首次使用三个新语言关键字（R4e = 语言能力压力测试）：
 * - compute(<源>, <字段>="<算术表达式>")：元素级字段计算；
 * - select(<源>, "<比较谓词>")：谓词过滤（filter 的推广）；
 * - join(<源1>, <源2>, ..., key="<字段>")：多输入按 key 合并字段。
 *
 * iterative 臂：严格答案接口（submit_answer + exactAnswerMatch），模型自己
 * 判断分支、自己维护 30 个对象的对应关系——State cardinality 压力在 LLM context。
 *
 * 运行：npx tsx src/experiments/r4eBenchmark.ts --samples=10 --rounds=5 --parallel=4
 * 环境：DEEPSEEK_API_KEY（mock 数据，无真实 API / 无限流）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDsl, ExecutionDslCompileError } from "../compiler/compile.js";
import { renderExecutionToolCatalog } from "./executionCatalog.js";
import { buildDslSystemPrompt as buildDslPrompt } from "../prompt/systemPrompt.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, JIT_META_TOOLS, describeToolsResult } from "../tools/jitTools.js";
import type { RegisteredTool, ToolContract } from "../tools/definition.js";
import { toolIdAlias, ToolRegistry } from "../tools/registry.js";
import { createDeepSeekGateway, type LlmGateway, type LlmMessage, type LlmUsage } from "../llm/gateway.js";
import { mapLimit } from "../runtime/executor.js";
import { createAdversarialGithubTools, ADVERSARIAL_REPOS } from "../tools/providers/github/mock.js";
import { execute } from "../runtime/runtime.js";
import { exactAnswerMatch, runIterativeToolCalling, sumMessageBytes, type IterativeToolResult } from "./iterativeToolCalling.js";
import { checkTaskCorrectness, type TaskSpec } from "./taskSpec.js";

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
// 任务集（N ∈ {15, 30}，State cardinality 梯度）
// ---------------------------------------------------------------------------

const QUERY = "agent framework";
const TAKE_COUNT = 3;
const RATIO_THRESHOLD = 0.15;
const SCORE_THRESHOLD = 100;

export interface R4eTask {
  n: number;
  k: number;
  takeCount: number;
  /** 分支阈值：ratio > 0.15 → contributors 路径；否则 → commits 路径 */
  ratioThreshold: number;
  /** 统一 score 的保留阈值（score >= 100 才允许进 top3） */
  scoreThreshold: number;
  dslPrompt: string;
  iterativePrompt: string;
  tools: readonly ToolContract[];
}

const R4E_TOOLS = createAdversarialGithubTools().filter((tool) =>
  [
    "github.search_repositories",
    "github.get_repository",
    "github.get_contributor_stats",
    "github.list_commits",
  ].includes(tool.id),
);

export function buildR4eTasks(): R4eTask[] {
  const branchRule = `fork/star 比值（ratio = forks / stars）> ${RATIO_THRESHOLD} 的仓库走 contributors 路径（调用 github.get_contributor_stats），其余（ratio <= ${RATIO_THRESHOLD}）走 commits 路径（调用 github.list_commits）。两条路径都返回 score 字段（统一可比尺度）。`;
  const finalRule = `把每个仓库的 score 重新对应回该仓库（join），只保留 score >= ${SCORE_THRESHOLD} 的仓库，按 score 从高到低排序，返回前 ${TAKE_COUNT} 个仓库的完整名称（owner/repo）。`;
  return [15, 30].map((n) => ({
    n,
    k: TAKE_COUNT,
    takeCount: TAKE_COUNT,
    ratioThreshold: RATIO_THRESHOLD,
    scoreThreshold: SCORE_THRESHOLD,
    dslPrompt:
      `请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 agent 框架仓库（query 用 "${QUERY}"），取前 ${n} 个，` +
      `然后对每个仓库获取其详细信息（map 到 github.get_repository，绑定 full_name）。` +
      `先用 compute 计算每个仓库的 ratio = forks / stars（compute(details, ratio="forks / stars")）。` +
      `然后分支：${branchRule}` +
      `最后 ${finalRule} 编写程序时依次用 compute → select 分支（两次，互补）→ map 到两条路径 → join(details, contributors结果, commits结果, key="full_name") → select(score >= ${SCORE_THRESHOLD}) → sort(key="score", desc=true) → take(${TAKE_COUNT}) → return。`,
    iterativePrompt:
      `使用提供的工具完成任务：搜索 GitHub 上活跃的 agent 框架仓库（query 用 "${QUERY}"），取前 ${n} 个仓库，然后对每个仓库获取其详细信息（github.get_repository，返回 forks/stars）。` +
      `对每个仓库计算 ratio = forks / stars。${branchRule}` +
      `把每一条路径返回的 score 记到正确的仓库名下（同一仓库的 score 只能来自它走的那条路径）。${finalRule}` +
      `把前 ${TAKE_COUNT} 个仓库的完整名称按排名从高到低，通过 submit_answer 工具的 repositories 参数提交。`,
    tools: R4E_TOOLS,
  }));
}

// ---------------------------------------------------------------------------
// 确定性答案（oracle）：与 DSL executor 共用表达式语义（evalExpr / compareValues）
// ---------------------------------------------------------------------------

export interface AdversarialDetail {
  full_name: string;
  stars: number;
  forks: number;
  language: string;
}

export function computeR4eAnswer(
  details: readonly AdversarialDetail[],
  statsMap: Readonly<Record<string, { score: number }>>,
  commitMap: Readonly<Record<string, { score: number }>>,
  task: Pick<R4eTask, "ratioThreshold" | "scoreThreshold" | "takeCount">,
): string[] {
  const scored = details.map((detail) => {
    const ratio = detail.forks / detail.stars;
    const pathScore =
      ratio > task.ratioThreshold ? statsMap[detail.full_name]?.score : commitMap[detail.full_name]?.score;
    return { full_name: detail.full_name, score: pathScore ?? Number.NEGATIVE_INFINITY };
  });
  const kept = scored
    .filter((item) => item.score >= task.scoreThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, task.takeCount)
    .map((item) => item.full_name);
  return kept;
}

/** ground truth：确定性 mock 链式取数（search → details → 按 ratio 分支取两路 score）→ oracle。 */
export async function fetchR4eGroundTruth(
  searchTool: RegisteredTool,
  repoTool: RegisteredTool,
  statsTool: RegisteredTool,
  commitTool: RegisteredTool,
  task: R4eTask,
): Promise<string[]> {
  const result = await searchTool.execute({ query: QUERY, limit: task.n });
  const items = Array.isArray(result) ? (result as Array<{ full_name: string }>) : [];
  const details = (await mapLimit(items, 5, async (item) => {
    const detail = await repoTool.execute({ full_name: item.full_name });
    return detail as AdversarialDetail;
  })) as AdversarialDetail[];

  const statsMap: Record<string, { score: number }> = {};
  const commitMap: Record<string, { score: number }> = {};
  await mapLimit(details, 5, async (detail) => {
    if (detail.forks / detail.stars > task.ratioThreshold) {
      statsMap[detail.full_name] = (await statsTool.execute({ full_name: detail.full_name })) as { score: number };
    } else {
      commitMap[detail.full_name] = (await commitTool.execute({ full_name: detail.full_name })) as { score: number };
    }
  });
  return computeR4eAnswer(details, statsMap, commitMap, task);
}

// ---------------------------------------------------------------------------
// DSL 臂
// ---------------------------------------------------------------------------

function buildDslSystemPrompt(): string {
  return buildDslPrompt({
    constructs: ["map", "take", "filter", "sort", "compute", "select", "join", "return"],
    constraints: ["分支要互补：ratio > 0.15 与 ratio <= 0.15 各写一次 select"],
  });
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
  /** 提交的 DSL 程序源码（诊断：正确率失败时定位是编译/图语义/执行哪一环） */
  program?: string;
  /** 图语义检查未过时记录失败明细（诊断用） */
  correctness_failures?: string[];
  error?: string;
}

async function runDslArm(
  gateway: LlmGateway,
  task: R4eTask,
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
  let modelIngressBytes = 0;
  let modelEgressBytes = 0;

  const runtimeInternal = { bytes: 0 };
  const recordingTools: RegisteredTool[] = tools.map((tool) => ({
    ...tool,
    execute: async (args) => {
      const result = await tool.execute(args);
      runtimeInternal.bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      return result;
    },
  }));

  const taskSpec: TaskSpec = {
    query: QUERY,
    queryTokens: [QUERY],
    limit: task.n,
    takeCount: task.k,
    bindings: { full_name: "full_name" },
    sortKey: "score",
    sortDesc: true,
    stageTools: ["github.get_repository"],
    computeExprs: { ratio: "forks / stars" },
    selectPreds: [`ratio > ${task.ratioThreshold}`, `ratio <= ${task.ratioThreshold}`, `score >= ${task.scoreThreshold}`],
    joinSpec: {
      key: "full_name",
      sourceCount: 3,
      extraTools: ["github.get_contributor_stats", "github.list_commits"],
    },
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    modelIngressBytes += sumMessageBytes(messages);
    const t0 = performance.now();
    const { content, toolCalls, usage: turnUsage } = await gateway.complete(messages, { tools: JIT_META_TOOLS });
    llmMs += performance.now() - t0;
    modelEgressBytes +=
      Buffer.byteLength(content, "utf8") +
      toolCalls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments), "utf8"), 0);
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

    try {
      const { graph } = compileExecutionDsl(source, {
        tools: new ToolRegistry(task.tools),
      });
      const correctness = checkTaskCorrectness(graph, taskSpec);
      const registry = new ToolRegistry(recordingTools);
      const t1 = performance.now();
      const execution = await execute(graph, registry);
      const runtimeMs = performance.now() - t1;

      const result = execution.status === "success" ? execution.result : undefined;
      const resultArray = Array.isArray(result) ? (result as unknown[]) : [];
      const answered = resultArray
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => String(item["full_name"] ?? ""));

      return {
        ok: execution.status === "success",
        round_trips: round,
        model_ingress_bytes: modelIngressBytes,
        model_egress_bytes: modelEgressBytes,
        runtime_internal_bytes: runtimeInternal.bytes,
        llm_ms: llmMs,
        runtime_ms: runtimeMs,
        e2e_ms: performance.now() - started,
        usage,
        answered,
        task_pass: exactAnswerMatch(answered, groundTruth) && correctness.pass,
        maxed_out: false,
        program: source,
        ...(correctness.pass ? {} : { correctness_failures: correctness.failures }),
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
        program: source,
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
  final_text?: string;
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
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { samples, rounds, parallel } = parseArgs(process.argv.slice(2));
  const gateway = createDeepSeekGateway();
  const mockTools = createAdversarialGithubTools();
  const tasks = buildR4eTasks();
  const findTool = (id: string): RegisteredTool => {
    const tool = mockTools.find((item) => item.id === id);
    if (!tool) throw new Error(`[FAIL] 未找到工具 ${id}`);
    return tool;
  };
  const searchTool = findTool("github.search_repositories");
  const repoTool = findTool("github.get_repository");
  const statsTool = findTool("github.get_contributor_stats");
  const commitTool = findTool("github.list_commits");

  // 每 cell 一次 ground truth（确定性 mock）+ 分支/阈值分布预检
  const groundTruthByCell = new Map<string, string[]>();
  console.log("ground truth（确定性 mock 链式取数）:");
  for (const task of tasks) {
    const key = `R4e|${task.n}`;
    const gt = await fetchR4eGroundTruth(searchTool, repoTool, statsTool, commitTool, task);
    groundTruthByCell.set(key, gt);
    const rows = ADVERSARIAL_REPOS.slice(0, task.n);
    const contribCount = rows.filter((row) => row.forks / row.stars > task.ratioThreshold).length;
    const commitCount = rows.length - contribCount;
    const thresholdPass = rows.filter((row) =>
      (row.forks / row.stars > task.ratioThreshold ? row.contributor_count * 3 : row.total_commits * 2) >= task.scoreThreshold,
    ).length;
    console.log(
      `  ${key}: [${gt.join(", ")}]（分支 contributors=${contribCount} / commits=${commitCount}；阈值后保留 ${thresholdPass} 个）`,
    );
  }
  const differs = groundTruthByCell.get("R4e|15")!.join(",") !== groundTruthByCell.get("R4e|30")!.join(",");
  console.log(`  N 梯度分叉校验（N=15 vs N=30 ground truth）：${differs ? "不同" : "相同（弱 cell）"}`);

  const iterativeSystem = (task: R4eTask): string =>
    [
      "你是一个 GitHub 数据分析助手。你可以调用以下工具获取数据：",
      renderExecutionToolCatalog(new ToolRegistry(task.tools), toolIdAlias),
      "",
      "请依次调用工具完成任务；任务完成后，必须调用 submit_answer 工具提交最终答案（repositories 参数：按排名从高到低排列的仓库完整名称列表）。不要只在文本中给出答案。",
    ].join("\n");

  const arms = ["dsl", "iterative"] as const;
  const combos = arms.flatMap((arm) => tasks.map((task) => ({ arm, task })));
  const results = await mapLimit(combos, parallel, async ({ arm, task }) => {
    const groundTruth = groundTruthByCell.get(`R4e|${task.n}`)!;
    const taskTools = mockTools.filter((tool) => task.tools.some((spec) => spec.id === tool.id));
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
              maxSteps: task.n + 20,
              groundTruth,
              required: Math.min(3, groundTruth.length),
              minConsecutiveNoTool: 1,
              strictAnswer: true,
            });
      const toolMs = arm === "dsl" ? (run as DslArmResult).runtime_ms : (run as { tool_ms: number }).tool_ms;
      runs.push({
        ...(run as DslArmResult),
        tool_ms: toolMs,
        ...(arm === "iterative" ? { final_text: (run as IterativeToolResult).final_text } : {}),
      });
      process.stdout.write(
        `  [${arm}|R4e|N=${task.n}] 样本 ${i + 1}/${samples} ... ${run.task_pass ? "对" : "错"}（${run.round_trips} 次往返）\n`,
      );
    }
    return { arm, task, runs };
  });

  console.log("\n\n===== R4e 汇总（DSL vs 迭代工具调用，分支 + 重组 × mock adversarial） =====");
  const header = [
    "臂", "N", "task%", "roundTrips", "modelIngress", "modelEgress", "runtimeInternal",
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
        arm, String(task.n), `${taskRate}%`, String(roundTrips),
        String(avg((run) => run.model_ingress_bytes)), String(avg((run) => run.model_egress_bytes)),
        String(avg((run) => run.runtime_internal_bytes)), String(avg((run) => run.usage.totalTokens)),
        String(avg((run) => run.llm_ms)), String(execMs), String(avg((run) => run.e2e_ms)), String(failed),
      ].join(" | "),
    );
  }

  const outDir = path.join(REPO_ROOT, "logs", "experiments", `r4e-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        mode: "r4e-branching-recombination",
        samples,
        difficultyAxes: {
          dependencyDepth: 4,
          branchingFactor: 2,
          recombinationBurden: 3,
          stateCardinality: "N × (ratio + 分组 + score)",
        },
        groundTruth: Object.fromEntries(groundTruthByCell),
        results: results.map(({ arm, task, runs }) => ({ arm, depth: "R4e", n: task.n, runs })),
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
