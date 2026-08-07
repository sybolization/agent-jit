#!/usr/bin/env node

/**
 * 三臂受控语言实验：只测 callable reference 一种语法形状。
 *
 *   A  arm = quoted-zero-shot     tool="github.get_repository"（字符串，无 few-shot）
 *   B  arm = quoted-few-shot      tool="github.get_repository"（字符串，含 few-shot）
 *   C  arm = symbolic-zero-shot   tool=github.get_repository（裸标识符，无 few-shot）
 *
 * 三臂共享完全相同的任务、IR、runtime，唯一变量是 tool 参数的表达方式。
 * 指标：first-attempt conformance / repair 次数 / output tokens / prompt tokens /
 *      error 分布（模型摩擦指标）/ 最终成功率。
 *
 * 运行：npm run experiment -- --arm=all --samples=10 --rounds=5
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDsl, ExecutionDslCompileError } from "../compiler/compiler.js";
import { renderExecutionToolCatalog } from "../compiler/catalog.js";
import { githubTools } from "../compiler/registry.js";
import { createDeepSeekGateway, type LlmGateway, type LlmMessage, type LlmUsage } from "../llm/gateway.js";
import { createMockGithubTools } from "../runtime/mockTools.js";
import { execute } from "../runtime/runtime.js";

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
  label: string;
  allowCallableRef: boolean;
  fewShot: boolean;
}

const ARMS: readonly ArmConfig[] = [
  { id: "A", label: "quoted-zero-shot", allowCallableRef: false, fewShot: false },
  { id: "B", label: "quoted-few-shot", allowCallableRef: false, fewShot: true },
  { id: "C", label: "symbolic-zero-shot", allowCallableRef: true, fewShot: false },
];

const TASK =
  "请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 " +
  '"agent framework language:typescript"），取前 10 个，然后并行获取每个仓库的详细信息（用 full_name），' +
  "最后截取前 3 个作为最终结果并返回。";

function toolWriting(arm: ArmConfig): string {
  return arm.allowCallableRef
    ? "tool 参数用裸标识符（callable reference），如 tool=github.get_repository"
    : "tool 参数必须是双引号字符串，如 tool=\"github.get_repository\"";
}

function fewShotExample(arm: ArmConfig): string {
  const toolExpr = arm.allowCallableRef ? "tool=github.get_repository" : 'tool="github.get_repository"';
  return [
    "## 完整示例",
    'repos = github.search_repositories(query="agent framework", limit=10)',
    `details = map(source=repos, ${toolExpr}, key="full_name", concurrency=5)`,
    "top = take(source=details, count=3)",
    "return(value=top)",
  ].join("\n");
}

function buildSystemPrompt(arm: ArmConfig): string {
  const lines = [
    "你是一名 Agent Execution DSL 编程助手。你的任务是用下面这门小语言写出程序，程序会被编译并在 Harness 上执行。",
    "",
    "## 语法（newline 分隔语句，每条独占一行）",
    "<name> = <callee>(<key>=<value>, <key>=<value>, ...)",
    "- <name>：变量名（[a-zA-Z_][a-zA-Z0-9_]*），变量名即图中的节点",
    "- <callee>：已注册工具 id，或语言关键字 map / take / return",
    "- <value>：字符串（双引号）、数字、布尔、null，或先前定义的变量名（裸标识符即引用，定义数据流边）",
    "- map：source 必须是先前定义的数组变量；key 指定从每个元素取哪个字段作为工具参数；concurrency 为并发上限（默认 5）",
    `- ${toolWriting(arm)}`,
    "- take：source 是数组变量引用，count 是要截取的条数",
    "- return：value 是最终结果的变量引用",
  ];
  if (arm.fewShot) lines.push("", fewShotExample(arm));
  lines.push(
    "",
    "## 可用工具",
    renderExecutionToolCatalog(githubTools),
    "",
    "## 硬约束",
    "1. 只输出 DSL 代码本身，不要 Markdown 围栏，不要任何解释文字",
    "2. 参数名必须与工具目录完全一致，不得自创参数名",
    "3. 变量必须先定义再引用（不允许前向引用）",
    "4. 编译失败时，根据返回的诊断修正 DSL 并重新提交，直到成功为止",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 单次运行
// ---------------------------------------------------------------------------

interface RunResult {
  success: boolean;
  rounds_used: number;
  first_attempt: boolean;
  final_dsl: string;
  result_size: number;
  error_codes: string[];
  usage: LlmUsage;
  rounds: Array<{
    round: number;
    llm_output: string;
    diagnostics: Array<{ line: number; code: string; message: string }>;
  }>;
}

async function runOnce(gateway: LlmGateway, arm: ArmConfig, task: string, maxRounds: number): Promise<RunResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt(arm) },
    { role: "user", content: task },
  ];
  const usage: LlmUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const errorCodes: string[] = [];
  const rounds: RunResult["rounds"] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const { content, usage: turnUsage } = await gateway.complete(messages);
    usage.input += turnUsage.input;
    usage.output += turnUsage.output;
    usage.cacheRead += turnUsage.cacheRead;
    usage.totalTokens += turnUsage.totalTokens;

    const dsl = content.trim();
    rounds.push({ round, llm_output: dsl, diagnostics: [] });
    messages.push({ role: "assistant", content: dsl });

    if (!dsl) {
      messages.push({ role: "user", content: "你的输出为空。请重新提交一段完整的 DSL 程序（只输出 DSL 代码本身）。" });
      continue;
    }

    try {
      const { graph, diagnostics } = compileExecutionDsl(dsl, {
        tools: githubTools,
        allowCallableRef: arm.allowCallableRef,
      });
      if (graph.nodes.length === 0) {
        messages.push({ role: "user", content: "编译通过但程序为空（没有任何语句）。请重新提交一段完整的 DSL 程序。" });
        continue;
      }
      const registry = new Map(createMockGithubTools().map((tool) => [tool.spec.id, tool]));
      const execution = await execute(graph, registry);
      const resultArray = Array.isArray(execution.result) ? (execution.result as unknown[]) : [];
      return {
        success: true,
        rounds_used: round,
        first_attempt: round === 1,
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
          "编译失败，请根据以下诊断修正 DSL 后重新提交（只输出修正后的 DSL）：",
          ...diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
        ].join("\n");
        messages.push({ role: "user", content: feedback });
        continue;
      }
      return {
        success: false,
        rounds_used: round,
        first_attempt: false,
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
    final_dsl: "",
    result_size: 0,
    error_codes: errorCodes,
    usage,
    rounds,
  };
}

// ---------------------------------------------------------------------------
// 单臂汇总
// ---------------------------------------------------------------------------

interface ArmSummary {
  arm: ArmId;
  label: string;
  samples: number;
  success_count: number;
  success_rate: number;
  first_attempt_count: number;
  first_attempt_rate: number;
  avg_rounds_to_success: number;
  total_rounds: number;
  error_code_counts: Record<string, number>;
  usage_total: LlmUsage;
  runs: RunResult[];
}

function summarize(gateway: LlmGateway, arm: ArmConfig, task: string, samples: number, maxRounds: number): Promise<ArmSummary> {
  return (async () => {
    const runs: RunResult[] = [];
    for (let i = 0; i < samples; i += 1) {
      process.stdout.write(`  [${arm.id}] 样本 ${i + 1}/${samples} ... `);
      const run = await runOnce(gateway, arm, task, maxRounds);
      runs.push(run);
      process.stdout.write(`${run.success ? "成功" : "失败"}（${run.rounds_used} 轮）\n`);
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

    return {
      arm: arm.id,
      label: arm.label,
      samples,
      success_count: successRuns.length,
      success_rate: successRuns.length / samples,
      first_attempt_count: runs.filter((run) => run.first_attempt).length,
      first_attempt_rate: runs.filter((run) => run.first_attempt).length / samples,
      avg_rounds_to_success:
        successRuns.length > 0 ? successRuns.reduce((sum, run) => sum + run.rounds_used, 0) / successRuns.length : 0,
      total_rounds: runs.reduce((sum, run) => sum + run.rounds_used, 0),
      error_code_counts: errorCodeCounts,
      usage_total: usageTotal,
      runs,
    };
  })();
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { arms: ArmConfig[]; samples: number; rounds: number } {
  const read = (name: string, fallback: string): string => {
    const eq = argv.find((item) => item.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const armArg = read("--arm", "all").toUpperCase();
  const arms = armArg === "ALL" ? [...ARMS] : ARMS.filter((arm) => arm.id === armArg);
  const samples = Number(read("--samples", "10"));
  const rounds = Number(read("--rounds", "5"));
  return {
    arms,
    samples: Number.isInteger(samples) && samples > 0 ? samples : 10,
    rounds: Number.isInteger(rounds) && rounds > 0 ? rounds : 5,
  };
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { arms, samples, rounds } = parseArgs(process.argv.slice(2));
  if (arms.length === 0) {
    console.error("[FAIL] 无效的 --arm（应为 A / B / C / all）");
    return 1;
  }

  const gateway = createDeepSeekGateway();
  const summaries: ArmSummary[] = [];
  for (const arm of arms) {
    console.log(`\n===== 臂 ${arm.id}（${arm.label}）— ${samples} 个样本 =====`);
    const summary = await summarize(gateway, arm, TASK, samples, rounds);
    summaries.push(summary);
  }

  const outDir = path.join(REPO_ROOT, "logs", "experiments", `callable-ref-ab-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify({ task: TASK, arms: summaries }, null, 2)}\n`);

  console.log("\n===== 汇总 =====");
  for (const summary of summaries) {
    console.log(`\n臂 ${summary.arm}（${summary.label}）: 成功率 ${(summary.success_rate * 100).toFixed(0)}%` +
      ` | first-attempt ${(summary.first_attempt_rate * 100).toFixed(0)}%` +
      ` | 成功者平均轮数 ${summary.avg_rounds_to_success.toFixed(1)}` +
      ` | 总轮数 ${summary.total_rounds}`);
    console.log(`  error 分布: ${Object.entries(summary.error_code_counts).map(([code, count]) => `${code}=${count}`).join(", ")}`);
    console.log(`  usage: input=${summary.usage_total.input} output=${summary.usage_total.output} total=${summary.usage_total.totalTokens}`);
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
