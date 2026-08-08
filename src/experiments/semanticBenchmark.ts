#!/usr/bin/env node

/**
 * R4d：Sequential Dependency Depth Benchmark（DSL vs 迭代工具调用）。
 *
 * 与 R4c（width 轴：N↑）不同，R4d 测 **顺序依赖深度**：
 * 完成最终任务所需的、必须等待上一阶段结果才能确定下一阶段输入的工具调用层数。
 * - D1：search(N) → get_repository × N → sort(forks desc) → take 3 → return；
 * - D2：D1 + filter(language="TypeScript") → get_contributor_stats × M → sort(total_contributions desc) → take 3；
 * - D3：D2 的排序结果 → take 5 → list_commits × 5 → sort(total_commits desc) → take 3。
 * 深度轴 D1/D2/D3 × 成本轴 N∈{10,30} = 6 cells。
 *
 * 每个阶段工具返回一个可排序标量字段（forks / total_contributions / total_commits）——
 * 跳过任何一步必然拿不到排序依据；两臂都必须真跑完整依赖链。
 *
 * 正确率侧（R4d 核心修复）：
 * - iterative 臂改为**严格答案接口**：模型必须调用 submit_answer(repositories=[...]) 提交最终列表，
 *   未调用 = 未提交 = 失败；不再从正文 regex 抽答案。
 * - 两臂共用 exactAnswerMatch（长度 + 逐元素 + 顺序）。
 * - DSL 臂 task_pass = exactAnswerMatch(answered, groundTruth) && 图语义正确。
 *
 * 运行：npx tsx src/experiments/semanticBenchmark.ts --samples=10 --rounds=5 --parallel=4 --pacing=1000
 * 环境：DEEPSEEK_API_KEY + GITHUB_TOKEN（.env，gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";

import { compileExecutionDsl, ExecutionDslCompileError } from "../compiler/compiler.js";
import { renderExecutionToolCatalog } from "../compiler/catalog.js";
import { githubTools } from "../compiler/registry.js";
import type { ToolDefinition } from "../tools/definition.js";
import { createDeepSeekGateway, type LlmGateway, type LlmMessage, type LlmUsage } from "../llm/gateway.js";
import { compareValues, mapLimit } from "../runtime/executor.js";
import { createRealGithubTools } from "../runtime/githubAdapter.js";
import { execute, type RuntimeTool } from "../runtime/runtime.js";
import { exactAnswerMatch, runIterativeToolCalling, sumMessageBytes, toPiToolName, type IterativeToolResult } from "./iterativeToolCalling.js";
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
// 任务集（深度 × 成本梯度）
// ---------------------------------------------------------------------------

const GITHUB_QUERY = "agent framework";
const TAKE_COUNT = 3;
const MID_TAKE = 5;
const FANOUT_SIZES = [10, 30] as const;

export type R4dLevel = "D1" | "D2" | "D3";

export interface R4dTask {
  depth: R4dLevel;
  n: number;
  /** 最终要求答出的数量（恒 3；filter 后不足则 oracle 全返回） */
  k: number;
  takeCount: number;
  /** D3 的中间截取数（contributor 排序后进入 commits 阶段的数量） */
  midTake?: number;
  /** D2/D3 的 filter 等值条件；D1 无 */
  filterConditions?: Record<string, unknown>;
  /** 最终排序键：D1=forks / D2=total_contributions / D3=total_commits */
  sortKey: string;
  sortDesc: boolean;
  /** return 数据流上按序（return 侧在前）出现的阶段工具 id */
  stageTools: readonly string[];
  /** return 数据流上按序出现的 take count（return 侧在前），D3=[3,5] */
  takeCounts?: readonly number[];
  dslPrompt: string;
  iterativePrompt: string;
  tools: readonly ToolDefinition[];
}

const ALL_GITHUB_TOOLS = githubTools.filter((tool) =>
  [
    "github.search_repositories",
    "github.get_repository",
    "github.get_contributor_stats",
    "github.list_commits",
  ].includes(tool.id),
);

/** 各 depth 的工具集（阶段工具逐步增加，避免无关工具干扰模型）。 */
function toolsForDepth(depth: R4dLevel): readonly ToolDefinition[] {
  const ids =
    depth === "D1"
      ? ["github.search_repositories", "github.get_repository"]
      : depth === "D2"
        ? ["github.search_repositories", "github.get_repository", "github.get_contributor_stats"]
        : ["github.search_repositories", "github.get_repository", "github.get_contributor_stats", "github.list_commits"];
  return ALL_GITHUB_TOOLS.filter((tool) => ids.includes(tool.id));
}

export function buildR4dTasks(): R4dTask[] {
  const cells: Array<{ depth: R4dLevel; n: number }> = [
    { depth: "D1", n: 10 },
    { depth: "D1", n: 30 },
    { depth: "D2", n: 10 },
    { depth: "D2", n: 30 },
    { depth: "D3", n: 10 },
    { depth: "D3", n: 30 },
  ];
  return cells.map(({ depth, n }) => {
    const filterConditions = depth === "D1" ? undefined : { language: "TypeScript" };
    const sortKey =
      depth === "D1" ? "forks" : depth === "D2" ? "total_contributions" : "total_commits";
    const sortPhrase = `最后按 ${sortKey} 字段从高到低排序（sort key="${sortKey}", desc=true）`;
    const filterPhrase =
      depth === "D1"
        ? ""
        : '只保留 language="TypeScript" 的仓库（filter(details, language="TypeScript")），';
    const stagePhrase =
      depth === "D1"
        ? ""
        : depth === "D2"
          ? "然后对每个保留的仓库调用 github.get_contributor_stats（把每个元素的 full_name 传给其 full_name 参数）获取贡献者统计，"
          : "然后对每个保留的仓库调用 github.get_contributor_stats（把每个元素的 full_name 传给其 full_name 参数）获取贡献者统计，按 total_contributions 从高到低排序后先截取前 5 个（take ... 5），再对这 5 个调用 github.list_commits（把每个元素的 full_name 传给其 full_name 参数）获取提交统计，";
    return {
      depth,
      n,
      k: TAKE_COUNT,
      takeCount: TAKE_COUNT,
      midTake: depth === "D3" ? MID_TAKE : undefined,
      filterConditions,
      sortKey,
      sortDesc: true,
      stageTools:
        depth === "D1"
          ? ["github.get_repository"]
          : depth === "D2"
            ? ["github.get_contributor_stats", "github.get_repository"]
            : ["github.list_commits", "github.get_contributor_stats", "github.get_repository"],
      takeCounts: depth === "D3" ? [TAKE_COUNT, MID_TAKE] : undefined,
      dslPrompt:
        `请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 agent 框架仓库（query 用 "${GITHUB_QUERY}"），` +
        `取前 ${n} 个，然后对每个仓库获取其详细信息（把每个元素的 full_name 传给 github.get_repository 的 full_name 参数）。` +
        `${filterPhrase}${stagePhrase}${sortPhrase}，截取前 ${TAKE_COUNT} 个作为最终结果并返回（return）。`,
      iterativePrompt:
        `使用提供的工具完成任务：搜索 GitHub 上活跃的 agent 框架仓库（query 用 "${GITHUB_QUERY}"），` +
        `取前 ${n} 个仓库，然后对每个仓库获取其详细信息（github.get_repository）。` +
        `${filterPhrase}${stagePhrase}${sortPhrase}，把前 ${TAKE_COUNT} 个仓库的完整名称（owner/repo）按排名从高到低，通过 submit_answer 工具的 repositories 参数提交。`,
      tools: toolsForDepth(depth),
    };
  });
}

// ---------------------------------------------------------------------------
// 确定性答案（oracle）：每 depth 一个纯函数，两臂共用同一 ground truth
// ---------------------------------------------------------------------------

export interface RepoDetail {
  full_name: string;
  stars: number;
  forks: number;
  archived: boolean;
  language: string;
}

export interface ContributorStats {
  full_name: string;
  contributor_count: number;
  total_contributions: number;
}

export interface CommitStats {
  full_name: string;
  total_commits: number;
  latest_commit_at: string | null;
}

function filterDetails(
  details: readonly RepoDetail[],
  task: Pick<R4dTask, "filterConditions">,
): RepoDetail[] {
  if (!task.filterConditions) return [...details];
  return details.filter((item) =>
    Object.entries(task.filterConditions).every(([field, literal]) => item[field as keyof RepoDetail] === literal),
  );
}

/** 按字段排序 → 截取 → full_name（与 executor 的 compute 语义共用 compareValues）。 */
function sortTake<T extends { full_name: string }>(
  items: readonly T[],
  key: string,
  desc: boolean,
  take: number,
): string[] {
  const ranked = [...items].sort((left, right) => {
    const base = compareValues(
      (left as unknown as Record<string, unknown>)[key],
      (right as unknown as Record<string, unknown>)[key],
    );
    return desc ? -base : base;
  });
  return ranked.slice(0, take).map((item) => item.full_name);
}

/** D1：sort(forks desc) → take 3（R4c 语义保留）。 */
export function computeDeterministicAnswer(
  details: readonly RepoDetail[],
  task: Pick<R4dTask, "filterConditions" | "sortKey" | "sortDesc" | "takeCount">,
): string[] {
  return sortTake(filterDetails(details, task), task.sortKey, task.sortDesc, task.takeCount);
}

/** D2：filter → 按 full_name 映射 contributor stats → sort(total_contributions desc) → take 3。 */
export function computeD2Answer(
  details: readonly RepoDetail[],
  statsMap: Readonly<Record<string, ContributorStats>>,
  task: Pick<R4dTask, "filterConditions" | "sortDesc" | "takeCount">,
): string[] {
  const filtered = filterDetails(details, task);
  const stats = filtered
    .map((item) => statsMap[item.full_name])
    .filter((item): item is ContributorStats => item !== undefined);
  return sortTake(stats, "total_contributions", task.sortDesc, task.takeCount);
}

/** D3：filter → contributor sort → take 5 → commit sort(total_commits desc) → take 3。 */
export function computeD3Answer(
  details: readonly RepoDetail[],
  statsMap: Readonly<Record<string, ContributorStats>>,
  commitMap: Readonly<Record<string, CommitStats>>,
  task: Pick<R4dTask, "filterConditions" | "sortDesc" | "takeCount" | "midTake">,
): string[] {
  const filtered = filterDetails(details, task);
  const stats = filtered
    .map((item) => statsMap[item.full_name])
    .filter((item): item is ContributorStats => item !== undefined);
  const topP = sortTake(stats, "total_contributions", task.sortDesc, task.midTake ?? MID_TAKE);
  const commits = topP
    .map((name) => commitMap[name])
    .filter((item): item is CommitStats => item !== undefined);
  return sortTake(commits, "total_commits", task.sortDesc, task.takeCount);
}

/** 按 depth 分发 oracle（ground truth 计算入口）。 */
export function computeR4dAnswer(
  data: R4dCellData,
  task: R4dTask,
): string[] {
  if (task.depth === "D1") return computeDeterministicAnswer(data.details, task);
  if (task.depth === "D2") return computeD2Answer(data.details, data.statsMap, task);
  return computeD3Answer(data.details, data.statsMap, data.commitMap, task);
}

// ---------------------------------------------------------------------------
// ground truth：真实链式取数（两臂共用快照）+ filter 淘汰统计
// ---------------------------------------------------------------------------

export interface R4dCellData {
  details: RepoDetail[];
  statsMap: Record<string, ContributorStats>;
  commitMap: Record<string, CommitStats>;
}

export async function fetchR4dCellData(
  searchTool: RuntimeTool,
  repoTool: RuntimeTool,
  statsTools: Record<string, RuntimeTool>,
  task: R4dTask,
): Promise<R4dCellData> {
  const result = await searchTool.execute!({ query: GITHUB_QUERY, limit: task.n });
  const items = Array.isArray(result) ? (result as Array<{ full_name: string }>) : [];
  const details = await mapLimit(items, 5, async (item) => {
    const detail = await repoTool.execute!({ full_name: item.full_name });
    return detail as RepoDetail;
  });

  const statsMap: Record<string, ContributorStats> = {};
  if (task.depth !== "D1") {
    const statsTool = statsTools["github.get_contributor_stats"];
    const stats = await mapLimit(details, 5, async (detail) => {
      const stat = await statsTool.execute!({ full_name: detail.full_name });
      return stat as ContributorStats;
    });
    for (const stat of stats) statsMap[stat.full_name] = stat;
  }

  const commitMap: Record<string, CommitStats> = {};
  if (task.depth === "D3") {
    // 与 oracle 一致：先按 contributor 排序取前 midTake 个，再取 commits
    const filtered = filterDetails(details, task);
    const stats = filtered
      .map((item) => statsMap[item.full_name])
      .filter((item): item is ContributorStats => item !== undefined);
    const topP = sortTake(stats, "total_contributions", task.sortDesc, task.midTake ?? MID_TAKE);
    const commitTool = statsTools["github.list_commits"];
    const commits = await mapLimit(topP, 5, async (name) => {
      const commit = await commitTool.execute!({ full_name: name });
      return commit as CommitStats;
    });
    for (const commit of commits) commitMap[commit.full_name] = commit;
  }

  return { details, statsMap, commitMap };
}

/** ground truth：真实链式取数 → 确定性答案。 */
export async function fetchR4dGroundTruth(
  searchTool: RuntimeTool,
  repoTool: RuntimeTool,
  statsTools: Record<string, RuntimeTool>,
  task: R4dTask,
): Promise<string[]> {
  const data = await fetchR4dCellData(searchTool, repoTool, statsTools, task);
  return computeR4dAnswer(data, task);
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

function buildDslSystemPrompt(task: R4dTask): string {
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
    "  示例：active = filter(details, language=\"TypeScript\")",
    "- sort：第一个位置参数是源数组，key=<字段名> 必填（字符串字面量），desc=true|false 可选（默认升序）",
    "  示例：ranked = sort(contribs, key=\"total_contributions\", desc=true)",
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
  task: R4dTask,
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
    ...tool,
    execute: async (args) => {
      const result = await tool.execute!(args);
      runtimeInternal.bytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      return result;
    },
  }));

  const taskSpec: TaskSpec = {
    query: GITHUB_QUERY,
    queryTokens: [GITHUB_QUERY],
    limit: task.n,
    takeCount: task.k,
    bindings: { full_name: "full_name" },
    filterConditions: task.filterConditions,
    sortKey: task.sortKey,
    sortDesc: task.sortDesc,
    stageTools: task.stageTools,
    takeCounts: task.takeCounts,
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
      const registry = new Map(recordingTools.map((tool) => [tool.id, tool]));
      const t1 = performance.now();
      const execution = await execute(graph, registry);
      const runtimeMs = performance.now() - t1;

      const resultArray = Array.isArray(execution.result) ? (execution.result as unknown[]) : [];
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
  const tasks = buildR4dTasks();

  const findTool = (id: string): RuntimeTool => {
    const tool = realTools.find((item) => item.id === id);
    if (!tool) throw new Error(`[FAIL] 未找到工具 ${id}`);
    return tool;
  };
  const statsTools: Record<string, RuntimeTool> = {
    "github.get_contributor_stats": findTool("github.get_contributor_stats"),
    "github.list_commits": findTool("github.list_commits"),
  };

  // 每 cell 一次 ground truth 快照（真实链式取数），两臂共用；
  // 同时输出 filter 淘汰统计与跨 depth/N 的分叉校验（冒烟诊断用）。
  const groundTruthByCell = new Map<string, string[]>();
  const keptByCell = new Map<string, { kept: number; total: number }>();
  console.log("ground truth（每 cell 一次快照）:");
  for (const task of tasks) {
    const key = `${task.depth}|${task.n}`;
    const data = await fetchR4dCellData(findTool("github.search_repositories"), findTool("github.get_repository"), statsTools, task);
    groundTruthByCell.set(key, computeR4dAnswer(data, task));
    const total = data.details.length;
    const kept = task.filterConditions
      ? filterDetails(data.details, task).length
      : total;
    keptByCell.set(key, { kept, total });
    const filterNote = task.depth === "D1" ? "" : `（filter 保留 ${kept}/${total}，淘汰 ${total - kept}）`;
    console.log(`  ${key}: [${groundTruthByCell.get(key)!.join(", ")}]${filterNote}`);
  }
  // 分叉校验：同一 N 下 D1≠D2≠D3；同一 depth 下 N=10 vs N=30 是否变化
  for (const n of FANOUT_SIZES) {
    const names = (depth: R4dLevel) => groundTruthByCell.get(`${depth}|${n}`)!.join(",");
    const d1d2 = names("D1") !== names("D2");
    const d2d3 = names("D2") !== names("D3");
    console.log(`  N=${n} 分叉校验：D1≠D2=${d1d2}，D2≠D3=${d2d3}${!d1d2 || !d2d3 ? "（存在重合 cell，报告需标注）" : ""}`);
  }
  for (const depth of ["D1", "D2", "D3"] as const) {
    const differs = groundTruthByCell.get(`${depth}|10`)!.join(",") !== groundTruthByCell.get(`${depth}|30`)!.join(",");
    console.log(`  ${depth} 随 N 变化：${differs ? "是" : "否（N=10 与 N=30 ground truth 重合，报告需标注）"}`);
  }

  const iterativeSystem = (task: R4dTask): string =>
    [
      "你是一个 GitHub 数据分析助手。你可以调用以下工具获取数据：",
      renderExecutionToolCatalog(task.tools, toPiToolName),
      "",
      "请依次调用工具完成任务；任务完成后，必须调用 submit_answer 工具提交最终答案（repositories 参数：按排名从高到低排列的仓库完整名称列表）。不要只在文本中给出答案。",
    ].join("\n");

  const arms = ["dsl", "iterative"] as const;
  const combos = arms.flatMap((arm) => tasks.map((task) => ({ arm, task })));
  const results = await mapLimit(combos, parallel, async ({ arm, task }) => {
    const groundTruth = groundTruthByCell.get(`${task.depth}|${task.n}`)!;
    const taskTools = realTools.filter((tool) => task.tools.some((spec) => spec.id === tool.id));
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
              maxSteps: task.n + 15,
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
        `  [${arm}|${task.depth}|N=${task.n}] 样本 ${i + 1}/${samples} ... ${run.task_pass ? "对" : "错"}（${run.round_trips} 次往返）\n`,
      );
    }
    return { arm, task, runs };
  });

  // 汇总
  console.log("\n\n===== R4d 汇总（DSL vs 迭代工具调用，顺序依赖深度 × 真实 GitHub） =====");
  const header = [
    "臂", "深度", "N", "task%", "roundTrips", "modelIngress", "modelEgress", "runtimeInternal",
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
        arm, task.depth, String(task.n), `${taskRate}%`, String(roundTrips),
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
        mode: "r4d-semantic-benchmark",
        samples,
        groundTruth: Object.fromEntries(groundTruthByCell),
        kept: Object.fromEntries(keptByCell),
        results: results.map(({ arm, task, runs }) => ({ arm, depth: task.depth, n: task.n, runs })),
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
