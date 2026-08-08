#!/usr/bin/env node

/**
 * R3 语言实验：map data binding 三臂（key= / 占位符调用 / lambda）。
 *
 * 只测一个语法变量——map 的 element→argument 绑定表达方式，IR/runtime 一致：
 *   A = key=    （`map(repos, "github.get_repository", key="full_name")`）
 *   B = call    （`map(repos, github.get_repository(full_name=_.full_name))`）
 *   C = lambda  （`map(repos, lambda repo: github.get_repository(full_name=repo.full_name))`）
 *
 * 全部 zero-shot + compiler repair（few-shot 留 R3b）；5 个任务 × 每臂 × 样本数。
 * 核心指标：binding correctness（编译成功 + 绑定映射与期望一致，与执行成功解耦）。
 *
 * 运行：npm run experiment -- --arm=all --tasks=all --samples=10 --rounds=5
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDslLegacy } from "./languageVariants/legacyCompile.js";
import { ExecutionDslCompileError } from "../compiler/compile.js";
import { buildDslSystemPrompt as buildDslPrompt } from "../prompt/systemPrompt.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, JIT_META_TOOLS, describeToolsResult } from "../tools/jitTools.js";
import { mapLimit } from "../runtime/executor.js";
import { createMockGithubTools } from "../tools/providers/github/mock.js";
import { createMockDomainTools } from "../tools/providers/domain/mock.js";
import { createRealGithubTools } from "../tools/providers/github/real.js";
import { execute } from "../runtime/runtime.js";
import type { RegisteredTool } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDeepSeekGateway, type LlmGateway, type LlmMessage, type LlmUsage } from "../llm/gateway.js";
import { R3_TASKS, type R3Task } from "./r3Tasks.js";
import { checkTaskCorrectness, type TaskSpec } from "./taskSpec.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// ---------------------------------------------------------------------------
// .env 加载（不依赖 dotenv）
// ---------------------------------------------------------------------------

function loadEnv(root: string): void {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// 三臂定义
// ---------------------------------------------------------------------------

export type ArmId = "A" | "B" | "C";

interface ArmConfig {
  id: ArmId;
  binding: "key" | "call" | "lambda";
}

const ARMS: readonly ArmConfig[] = [
  { id: "A", binding: "key" },
  { id: "B", binding: "call" },
  { id: "C", binding: "lambda" },
];

function buildSystemPrompt(arm: ArmConfig): string {
  const mapConstruct = arm.binding === "key" ? "map-key" : arm.binding === "lambda" ? "map-lambda" : "map";
  return buildDslPrompt({
    constructs: ["take", "return", mapConstruct],
  });
}

// ---------------------------------------------------------------------------
// 单次运行
// ---------------------------------------------------------------------------

interface RoundRecord {
  round: number;
  llm_output: string;
  /** 模型 text 输出（留档；不参与程序解析——transport 协议分层） */
  text: string;
  /** 本轮是否成功通过 jit_execute_program 拿到非空 source */
  transport_ok: boolean;
  diagnostics: Array<{ line: number; code: string; message: string }>;
}

interface RunResult {
  success: boolean;
  rounds_used: number;
  first_attempt: boolean;
  /** 首轮是否成功 transport（jit_execute_program 调用且 source 非空） */
  transport_pass: boolean;
  first_round_parse_ok: boolean;
  task_pass: boolean;
  task_failures: string[];
  binding_pass: boolean | undefined;
  binding_failures: string[];
  final_dsl: string;
  result_size: number;
  error_codes: string[];
  usage: LlmUsage;
  rounds: RoundRecord[];
}

function buildRuntimeRegistry(
  task: R3Task,
  backend: "real" | "mock",
): ToolRegistry<RegisteredTool> {
  const githubRuntime = backend === "real" ? createRealGithubTools() : createMockGithubTools();
  const tools = [...githubRuntime, ...createMockDomainTools()];
  const allowed = new Set(task.tools.map((tool) => tool.id));
  return new ToolRegistry(tools.filter((tool) => allowed.has(tool.id)));
}

async function runOnce(
  gateway: LlmGateway,
  arm: ArmConfig,
  task: R3Task,
  maxRounds: number,
  backend: "real" | "mock",
): Promise<RunResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt(arm) },
    { role: "user", content: task.prompt },
  ];
  const usage: LlmUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const errorCodes: string[] = [];
  const rounds: RoundRecord[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const { content, toolCalls, usage: turnUsage } = await gateway.complete(messages, { tools: JIT_META_TOOLS });
    usage.input += turnUsage.input;
    usage.output += turnUsage.output;
    usage.cacheRead += turnUsage.cacheRead;
    usage.totalTokens += turnUsage.totalTokens;

    // 协议要求：toolResult 必须跟在带 tool_calls 的 assistant 消息之后
    messages.push({ role: "assistant", content, toolCalls });

    // 元工具 dispatch：模型先调 jit_describe_tools 获取契约，再写程序提交
    const describe = toolCalls.find((call) => call.name === DESCRIBE_TOOLS_TOOL.name);
    if (describe) {
      messages.push(describeToolsResult(new ToolRegistry(task.tools), describe));
      continue;
    }

    // 传输协议：程序只从 jit_execute_program 的 source 参数取，text 通道不参与解析
    const submit = toolCalls.find((call) => call.name === EXECUTE_PROGRAM_TOOL.name);
    const dsl = typeof submit?.arguments.source === "string" ? submit.arguments.source.trim() : "";
    const transportOk = submit !== undefined && dsl !== "";
    rounds.push({ round, llm_output: dsl, text: content, transport_ok: transportOk, diagnostics: [] });

    if (!transportOk) {
      messages.push({
        role: "user",
        content: `你没有通过 ${EXECUTE_PROGRAM_TOOL.name} 工具提交程序。请调用 ${EXECUTE_PROGRAM_TOOL.name} 工具，把完整 DSL 程序放在 source 参数里（不要写在回复文本中）。`,
      });
      continue;
    }

    try {
      const { graph, diagnostics } = compileExecutionDslLegacy(dsl, {
        tools: task.tools,
        allowCallableRef: false,
        allowMapBinding: arm.binding,
      });
      if (graph.nodes.length === 0) {
        messages.push({ role: "toolResult", toolCallId: submit.id, toolName: EXECUTE_PROGRAM_TOOL.name, content: "编译通过但程序为空（没有任何语句）。请重新提交一段完整的 DSL 程序。", isError: true });
        continue;
      }
      const correctness = checkTaskCorrectness(graph, task.spec);
      const registry = buildRuntimeRegistry(task, backend);
      const execution = await execute(graph, registry);
      const result = execution.status === "success" ? execution.result : undefined;
      const resultArray = Array.isArray(result) ? (result as unknown[]) : [];
      return {
        success: true,
        rounds_used: round,
        first_attempt: round === 1,
        transport_pass: round === 1 && transportOk,
        first_round_parse_ok: !rounds[0]?.diagnostics.some((item) => item.code === "syntax"),
        task_pass: correctness.pass,
        task_failures: correctness.failures,
        binding_pass: correctness.bindingPass,
        binding_failures: correctness.bindingFailures ?? [],
        final_dsl: dsl,
        result_size: resultArray.length,
        error_codes: errorCodes,
        usage,
        rounds,
      };
    } catch (error) {
      if (error instanceof ExecutionDslCompileError) {
        const diagnostics = error.diagnostics.map((item) => ({ line: item.line, code: item.code, message: item.message }));
        errorCodes.push(...diagnostics.map((item) => item.code));
        rounds[rounds.length - 1]!.diagnostics = diagnostics;
        const feedback = [
          "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
          ...diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
        ].join("\n");
        messages.push({ role: "toolResult", toolCallId: submit.id, toolName: EXECUTE_PROGRAM_TOOL.name, content: feedback, isError: true });
        continue;
      }
      return {
        success: false,
        rounds_used: round,
        first_attempt: false,
        transport_pass: false,
        first_round_parse_ok: !rounds[0]?.diagnostics.some((item) => item.code === "syntax"),
        task_pass: false,
        task_failures: ["执行异常"],
        binding_pass: undefined,
        binding_failures: [],
        final_dsl: dsl,
        result_size: 0,
        error_codes: errorCodes,
        usage,
        rounds,
      };
    }
  }

  return {
    success: false,
    rounds_used: maxRounds,
    first_attempt: false,
    transport_pass: false,
    first_round_parse_ok: !rounds[0]?.diagnostics.some((item) => item.code === "syntax"),
    task_pass: false,
    task_failures: ["达到最大轮数仍未成功"],
    binding_pass: undefined,
    binding_failures: [],
    final_dsl: "",
    result_size: 0,
    error_codes: errorCodes,
    usage,
    rounds,
  };
}

// ---------------------------------------------------------------------------
// 汇总（per task × arm）
// ---------------------------------------------------------------------------

interface ArmTaskSummary {
  arm: ArmId;
  binding: ArmConfig["binding"];
  task_id: number;
  task_name: string;
  samples: number;
  success_count: number;
  success_rate: number;
  first_attempt_count: number;
  first_attempt_rate: number;
  /** 首轮 transport 成功率（jit_execute_program 调用且 source 非空）——与语法/编译解耦 */
  transport_success_rate: number;
  parse_success_rate: number;
  task_correctness_rate: number;
  binding_correctness_rate: number | null;
  repair_conversion_count: number;
  avg_rounds_to_success: number;
  total_rounds: number;
  tokens_per_success: number;
  error_code_counts: Record<string, number>;
  usage_total: LlmUsage;
  runs: RunResult[];
}

async function summarizeArmTask(
  gateway: LlmGateway,
  arm: ArmConfig,
  task: R3Task,
  samples: number,
  maxRounds: number,
  backend: "real" | "mock",
): Promise<ArmTaskSummary> {
  const runs: RunResult[] = [];
  for (let i = 0; i < samples; i += 1) {
    const run = await runOnce(gateway, arm, task, maxRounds, backend);
    runs.push(run);
    process.stdout.write(
      `  [${arm.id}|T${task.id}] 样本 ${i + 1}/${samples} ... ${run.success ? "成功" : "失败"}（${run.rounds_used} 轮）` +
        `task=${run.task_pass ? "对" : "错"} binding=${run.binding_pass === undefined ? "-" : run.binding_pass ? "对" : "错"}\n`,
    );
  }

  const successRuns = runs.filter((run) => run.success);
  const errorCodeCounts: Record<string, number> = {};
  for (const run of runs) {
    for (const code of run.error_codes) errorCodeCounts[code] = (errorCodeCounts[code] ?? 0) + 1;
  }

  const usageTotal: LlmUsage = runs.reduce(
    (acc, run) => ({
      input: acc.input + run.usage.input,
      output: acc.output + run.usage.output,
      cacheRead: acc.cacheRead + run.usage.cacheRead,
      totalTokens: acc.totalTokens + run.usage.totalTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
  );

  const bindingRuns = runs.filter((run) => run.binding_pass !== undefined);
  const successTokens = successRuns.reduce((sum, run) => sum + run.usage.totalTokens, 0);

  return {
    arm: arm.id,
    binding: arm.binding,
    task_id: task.id,
    task_name: task.name,
    samples,
    success_count: successRuns.length,
    success_rate: successRuns.length / samples,
    first_attempt_count: runs.filter((run) => run.first_attempt).length,
    first_attempt_rate: runs.filter((run) => run.first_attempt).length / samples,
    transport_success_rate: runs.filter((run) => run.transport_pass).length / samples,
    parse_success_rate: runs.filter((run) => run.first_round_parse_ok).length / samples,
    task_correctness_rate: runs.filter((run) => run.task_pass).length / samples,
    binding_correctness_rate:
      bindingRuns.length > 0 ? bindingRuns.filter((run) => run.binding_pass).length / bindingRuns.length : null,
    repair_conversion_count: runs.filter((run) => run.success && !run.first_attempt).length,
    avg_rounds_to_success:
      successRuns.length > 0 ? successRuns.reduce((sum, run) => sum + run.rounds_used, 0) / successRuns.length : 0,
    total_rounds: runs.reduce((sum, run) => sum + run.rounds_used, 0),
    tokens_per_success: successRuns.length > 0 ? Math.round(successTokens / successRuns.length) : 0,
    error_code_counts: errorCodeCounts,
    usage_total: usageTotal,
    runs,
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { arms: ArmConfig[]; tasks: R3Task[]; samples: number; rounds: number; parallel: number; backend: "real" | "mock" } {
  const read = (name: string, fallback: string): string => {
    const eq = argv.find((item) => item.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const armArg = read("--arm", "all").toUpperCase();
  const arms = armArg === "ALL" ? [...ARMS] : ARMS.filter((arm) => arm.id === armArg);
  const taskArg = read("--tasks", "all").toLowerCase();
  const tasks =
    taskArg === "all"
      ? [...R3_TASKS]
      : R3_TASKS.filter((task) => taskArg.split(",").map((item) => item.trim()).includes(String(task.id)));
  const samples = Number(read("--samples", "10"));
  const rounds = Number(read("--rounds", "5"));
  const parallel = Number(read("--parallel", "6"));
  const backendArg = read("--backend", "mock").toLowerCase();
  const backend: "real" | "mock" = backendArg === "real" ? "real" : "mock";
  return {
    arms,
    tasks,
    samples: Number.isInteger(samples) && samples > 0 ? samples : 10,
    rounds: Number.isInteger(rounds) && rounds > 0 ? rounds : 5,
    parallel: Number.isInteger(parallel) && parallel > 0 ? parallel : 6,
    backend,
  };
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { arms, tasks, samples, rounds, parallel, backend } = parseArgs(process.argv.slice(2));
  if (arms.length === 0) {
    console.error("[FAIL] 无效的 --arm（应为 A / B / C / all）");
    return 1;
  }
  if (tasks.length === 0) {
    console.error("[FAIL] 无效的 --tasks（应为 1..5 或 all）");
    return 1;
  }
  if (backend === "real") {
    try {
      createRealGithubTools();
      console.log(`backend=real：GitHub adapter 就绪（GITHUB_TOKEN 已配置）`);
    } catch (error) {
      console.error(`[FAIL] ${(error as Error).message}`);
      return 1;
    }
  }

  const gateway = createDeepSeekGateway();
  // 并发执行所有 arm × task 组合（每个组合内部样本串行），组合间并发上限由 --parallel 控制
  const combos = arms.flatMap((arm) => tasks.map((task) => ({ arm, task })));
  console.log(`并发执行 ${combos.length} 个组合（parallel=${parallel}, backend=${backend}）...`);
  const summaries = await mapLimit(combos, parallel, async ({ arm, task }) => {
    console.log(`\n===== 臂 ${arm.id}（${arm.binding}）| 任务 ${task.id}（${task.name}）— ${samples} 个样本 =====`);
    return summarizeArmTask(gateway, arm, task, samples, rounds, backend);
  });

  const outDir = path.join(REPO_ROOT, "logs", "experiments", `r3-binding-ab-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify({ mode: "r3-map-binding", backend, arms, tasks: summaries }, null, 2)}\n`,
  );

  console.log("\n\n===== 汇总（per task × arm） =====");
  const header = ["任务", "臂", "execution", "transport", "first-attempt", "parse", "task", "binding", "repair", "avgRound", "tokens/ok"].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const summary of summaries) {
    const pct = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
    console.log(
      [
        `${summary.task_id}.${summary.task_name}`,
        summary.arm,
        `${(summary.success_rate * 100).toFixed(0)}%`,
        `${(summary.transport_success_rate * 100).toFixed(0)}%`,
        `${(summary.first_attempt_rate * 100).toFixed(0)}%`,
        `${(summary.parse_success_rate * 100).toFixed(0)}%`,
        `${(summary.task_correctness_rate * 100).toFixed(0)}%`,
        pct(summary.binding_correctness_rate),
        `${summary.repair_conversion_count}`,
        summary.avg_rounds_to_success.toFixed(1),
        `${summary.tokens_per_success}`,
      ].join(" | "),
    );
  }

  // 按臂聚合（跨任务）
  console.log("\n===== 按臂聚合（跨任务） =====");
  for (const arm of arms) {
    const armSummaries = summaries.filter((summary) => summary.arm === arm.id);
    const totalSamples = armSummaries.reduce((sum, s) => sum + s.samples, 0);
    const taskRate = armSummaries.reduce((sum, s) => sum + s.task_correctness_rate * s.samples, 0) / totalSamples;
    const firstRate = armSummaries.reduce((sum, s) => sum + s.first_attempt_rate * s.samples, 0) / totalSamples;
    const successRate = armSummaries.reduce((sum, s) => sum + s.success_rate * s.samples, 0) / totalSamples;
    const bindingSum = armSummaries.filter((s) => s.binding_correctness_rate !== null);
    const bindingRate =
      bindingSum.length > 0
        ? bindingSum.reduce((sum, s) => sum + (s.binding_correctness_rate ?? 0) * s.samples, 0) /
          bindingSum.reduce((sum, s) => sum + s.samples, 0)
        : null;
    const errors: Record<string, number> = {};
    for (const s of armSummaries) {
      for (const [code, count] of Object.entries(s.error_code_counts)) errors[code] = (errors[code] ?? 0) + count;
    }
    console.log(
      `臂 ${arm.id}（${arm.binding}）: execution ${(successRate * 100).toFixed(0)}% | first-attempt ${(firstRate * 100).toFixed(0)}% | task ${(taskRate * 100).toFixed(0)}% | binding ${bindingRate === null ? "-" : (bindingRate * 100).toFixed(0) + "%"}`,
    );
    console.log(`  error 分布: ${Object.entries(errors).map(([code, count]) => `${code}=${count}`).join(", ") || "(无)"}`);
  }

  console.log(`\n报告已写入: ${path.join(outDir, "report.json")}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`[FAIL] ${(error as Error).message}`);
    process.exit(1);
  });
