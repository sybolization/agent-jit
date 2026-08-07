#!/usr/bin/env node

/**
 * DSL 生成实验（baseline）：让 LLM 用 Agent Execution DSL 写程序，
 * 编译器校验 + mock runtime 执行，多轮修订直到成功或达到轮数上限。
 *
 * 与真实 GitHub 无关：执行走 mock tools（固定数据），只验证
 * "agent 能否写出可编译、可执行的 DSL 程序"以及修复路径。
 *
 * 运行：npm run experiment [-- --rounds=5]
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
import { execute, type ExecutionResult } from "../runtime/runtime.js";

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
// Prompts
// ---------------------------------------------------------------------------

const DEFAULT_TASK =
  "请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 " +
  '"agent framework language:typescript"），取前 10 个，然后并行获取每个仓库的详细信息（用 full_name），' +
  "最后截取前 3 个作为最终结果并返回。";

function buildSystemPrompt(): string {
  return [
    "你是一名 Agent Execution DSL 编程助手。你的任务是用下面这门小语言写出程序，程序会被编译并在 Harness 上执行。",
    "",
    "## 语法（newline 分隔语句，每条独占一行）",
    "<name> = <callee>(<key>=<value>, <key>=<value>, ...)",
    "- <name>：变量名（[a-zA-Z_][a-zA-Z0-9_]*），变量名即图中的节点",
    "- <callee>：已注册工具 id，或语言关键字 map / take / return",
    "- <value>：字符串（双引号）、数字、布尔、null，或先前定义的变量名（裸标识符即引用，定义数据流边）",
    "- map：source 必须是先前定义的数组变量；tool 必须是已注册工具 id（**用双引号字符串**）；key 指定从每个元素取哪个字段作为工具参数；concurrency 为并发上限（默认 5）",
    "- take：source 是数组变量引用，count 是要截取的条数",
    "- return：value 是最终结果的变量引用",
    "",
    "## 完整示例（工具 id 必须加双引号）",
    'repos = github.search_repositories(query="agent framework", limit=10)',
    'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
    "top = take(source=details, count=3)",
    "return(value=top)",
    "",
    "## 可用工具",
    renderExecutionToolCatalog(githubTools),
    "",
    "## 硬约束",
    "1. 只输出 DSL 代码本身，不要 Markdown 围栏，不要任何解释文字",
    "2. 参数名必须与工具目录完全一致，不得自创参数名",
    "3. 变量必须先定义再引用（不允许前向引用）",
    "4. 编译失败时，根据返回的诊断修正 DSL 并重新提交，直到成功为止",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 实验流程
// ---------------------------------------------------------------------------

interface RoundRecord {
  round: number;
  llm_output: string;
  diagnostics: Array<{ line: number; code: string; message: string }>;
}

interface ExperimentReport {
  task: string;
  rounds_used: number;
  max_rounds: number;
  success: boolean;
  final_dsl: string;
  compile_diagnostics: Array<{ line: number; code: string; message: string }>;
  execution?: {
    ok: boolean;
    result_size: number;
    result_sample: unknown[];
    trace: ExecutionResult["trace"];
  };
  usage_total: LlmUsage;
  rounds: RoundRecord[];
  error?: string;
}

async function runExperiment(
  gateway: LlmGateway,
  task: string,
  maxRounds: number,
): Promise<ExperimentReport> {
  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: task },
  ];

  const usageTotal: LlmUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const rounds: RoundRecord[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    console.log(`[round ${round}/${maxRounds}] 请求模型...`);
    const { content, usage } = await gateway.complete(messages);
    usageTotal.input += usage.input;
    usageTotal.output += usage.output;
    usageTotal.cacheRead += usage.cacheRead;
    usageTotal.totalTokens += usage.totalTokens;

    const dsl = content.trim();
    rounds.push({ round, llm_output: dsl, diagnostics: [] });
    messages.push({ role: "assistant", content: dsl });

    // 空输出或空程序不算成功：反馈后继续修订。
    if (!dsl) {
      console.log(`[round ${round}] 模型输出为空，要求重新生成`);
      messages.push({ role: "user", content: "你的输出为空。请重新提交一段完整的 DSL 程序（只输出 DSL 代码本身）。" });
      continue;
    }

    try {
      const { graph, diagnostics } = compileExecutionDsl(dsl, { tools: githubTools });
      if (graph.nodes.length === 0) {
        console.log(`[round ${round}] 程序为空（0 节点），要求重新生成`);
        messages.push({ role: "user", content: "编译通过但程序为空（没有任何语句）。请重新提交一段包含 search、map、take、return 的完整 DSL 程序。" });
        continue;
      }
      console.log(`[round ${round}] 编译成功：${graph.nodes.length} 个节点，开始执行（mock）...`);

      const registry = new Map(createMockGithubTools().map((tool) => [tool.spec.id, tool]));
      const execution = await execute(graph, registry);
      const resultArray = Array.isArray(execution.result) ? (execution.result as unknown[]) : [];
      console.log(`[round ${round}] 执行完成：ok=${execution.ok}，结果 ${resultArray.length} 条`);

      return {
        task,
        rounds_used: round,
        max_rounds: maxRounds,
        success: true,
        final_dsl: dsl,
        compile_diagnostics: diagnostics.map((item) => ({ line: item.line, code: item.code, message: item.message })),
        execution: {
          ok: execution.ok,
          result_size: resultArray.length,
          result_sample: resultArray.slice(0, 3),
          trace: execution.trace,
        },
        usage_total: usageTotal,
        rounds,
      };
    } catch (error) {
      if (error instanceof ExecutionDslCompileError) {
        const diagnostics = error.diagnostics.map((item) => ({ line: item.line, code: item.code, message: item.message }));
        rounds[rounds.length - 1]!.diagnostics = diagnostics;
        const feedback = [
          "编译失败，请根据以下诊断修正 DSL 后重新提交（只输出修正后的 DSL）：",
          ...diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
        ].join("\n");
        console.log(`[round ${round}] 编译失败：${diagnostics.map((item) => item.code).join(", ")}`);
        messages.push({ role: "user", content: feedback });
        continue;
      }
      return {
        task,
        rounds_used: round,
        max_rounds: maxRounds,
        success: false,
        final_dsl: dsl,
        compile_diagnostics: [],
        usage_total: usageTotal,
        rounds,
        error: (error as Error).message,
      };
    }
  }

  return {
    task,
    rounds_used: maxRounds,
    max_rounds: maxRounds,
    success: false,
    final_dsl: "",
    compile_diagnostics: [],
    usage_total: usageTotal,
    rounds,
    error: `达到最大轮数 ${maxRounds} 仍未成功`,
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { task: string; rounds: number } {
  const read = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? (argv[index + 1] as string) : fallback;
  };
  const rounds = Number(read("--rounds", "5"));
  return {
    task: read("--task", DEFAULT_TASK),
    rounds: Number.isInteger(rounds) && rounds > 0 ? rounds : 5,
  };
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { task, rounds } = parseArgs(process.argv.slice(2));
  const gateway = createDeepSeekGateway();

  const report = await runExperiment(gateway, task, rounds);

  const outDir = path.join(REPO_ROOT, "logs", "experiments", `dsl-generation-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log("");
  console.log("==== 实验报告 ====");
  console.log(`成功: ${report.success}（用了 ${report.rounds_used}/${report.max_rounds} 轮）`);
  console.log(`usage: input=${report.usage_total.input} output=${report.usage_total.output} total=${report.usage_total.totalTokens}`);
  if (report.execution) {
    console.log(`执行结果: ok=${report.execution.ok} size=${report.execution.result_size}`);
    console.log(`样例: ${JSON.stringify(report.execution.result_sample, null, 2)}`);
  }
  console.log("");
  console.log("最终 DSL:");
  console.log(report.final_dsl);
  console.log("");
  console.log(`报告已写入: ${path.join(outDir, "report.json")}`);
  return report.success ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`[FAIL] ${(error as Error).message}`);
    process.exit(1);
  });
