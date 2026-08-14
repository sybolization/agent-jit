#!/usr/bin/env node

/**
 * 真 Agent integration benchmark（#11）：普通业务工具 + JIT 元工具**双通道**。
 *
 * 与 DSL 臂（模型只看到 jit_describe_tools / jit_execute_program 两个元工具）不同，
 * 这里模型**同时拥有**：
 * - 普通业务工具：Pi 工具注册通道直接注册（host alias 名，如 crm_search_customers）；
 * - JIT 元工具：jit_describe_tools / jit_execute_program（DSL 通道）。
 *
 * task prompt **不点名工具、不预设机制**（不说"请用 Agent Execution DSL"），
 * 观察模型是否自主选择：
 *   普通 Tool Calling（逐次调用业务工具）
 *      或
 *   describe → compile → execute（一次程序化）
 *
 * 工具名两种写法等价（canonical / host alias，ToolIdResolver 无感解析）。
 *
 * 本轮改动（JIT 变成真正的 Pi Agent Tool）：工具调用循环由 pi-agent-core `Agent`
 * 统一负责——普通工具与 jit_* 工具都是 `createPiTools(registry)` 注册的 AgentTool，
 * harness **不再对 JIT 工具做特殊 dispatch**（删除 describe/execute 分支，
 * 改由 jit 工具的 execute 内部完成 compile → execute(graph, 同一 registry)）。
 *
 * 运行：npx tsx src/experiments/hybridAgentBenchmark.ts [taskId]（缺省 4：customer-detail，字段异名区分度最高）
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepSeekPiRuntime, type PiRuntime } from "../llm/gateway.js";
import { createPiTools } from "../integrations/pi/toolAdapter.js";
import type { JitExecuteProgramDetails } from "../integrations/pi/jit.js";
import type { RegisteredTool } from "../tools/definition.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";
import { createMockDomainTools } from "../tools/providers/domain/mock.js";
import { createMockGithubTools } from "../tools/providers/github/mock.js";
import { toolIdAlias, ToolRegistry } from "../tools/registry.js";
import { runPiAgent } from "./agentRunner.js";
import { R3_TASKS, type R3Task } from "./r3Tasks.js";
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

/**
 * 中性 task prompt（#11 约束：不点名工具、不预设机制）——复用 R3 的工具集与 spec，
 * 只把"请用 Agent Execution DSL 编写程序：调用 xxx"改写为纯任务描述。
 */
export const NEUTRAL_PROMPTS: Record<number, string> = {
  1: "搜索 GitHub 上活跃的 TypeScript agent 框架仓库（查询条件用 agent framework language:typescript，取前 10 个），然后获取每个仓库的详细信息，最后返回前 3 个仓库的完整信息。",
  2: "搜索 GitHub 上活跃的 TypeScript agent 框架仓库（查询条件用 agent framework language:typescript，取前 10 个），然后获取每个仓库的语言构成，最后返回前 3 个仓库。",
  3: "搜索 GitHub 上活跃的 TypeScript agent 框架仓库（查询条件用 agent framework language:typescript，取前 10 个），然后获取每个仓库的贡献者列表，最后返回前 3 个仓库。",
  4: "CRM 系统有客户数据。先获取客户列表（取前 10 个），再获取每个客户的详情，最后返回前 3 个客户。",
  5: "系统有用户列表。为每个用户构造一封邮件，最后返回前 3 封邮件。",
};

/** 双通道系统提示词：普通业务工具 + JIT 元工具并存，选择权交给模型。 */
export function hybridSystemPrompt(): string {
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。你有两类工具：",
    "",
    "## 普通业务工具（单次调用）",
    "系统已注册的业务工具可以直接调用（工具名与参数见工具定义）。适合单次查询/操作。",
    "",
    "## Agent JIT 元工具（把重复性工作程序化）",
    `- ${DESCRIBE_TOOLS_TOOL.name}(tool_names=[...])：获取指定工具在 Agent Execution DSL 中的用法契约（输入参数 + 输出字段）；`,
    `- ${EXECUTE_PROGRAM_TOOL.name}(source="...")：提交一段 DSL 程序源码，Harness 编译并执行。`,
    "适合“对列表每个元素做同样处理”的场景：先 describe 拿契约，再写程序，再 execute 一次提交。",
    "",
    "## DSL 语法（newline 分隔语句，每条独占一行）",
    "<name> = <callee>(<参数>, ...)",
    "- <name>：变量名（[a-zA-Z_][a-zA-Z0-9_]*）",
    "- <callee>：已注册工具 id 或语言关键字 map / take / return",
    "- map：第二个参数是“绑定调用”：<工具>(<参数名>=_.<字段>)，把每个元素的 <字段> 传给该工具的 <参数名>",
    "- take：截取前 N 条；return：返回变量（如 return top）",
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
    "- 用 DSL 完成：程序以 return <变量> 结尾，通过 jit_execute_program 提交。",
  ].join("\n");
}

interface HybridResult {
  path: "dsl" | "ordinary" | "maxed_out";
  rounds: number;
  describeCalls: number;
  executeCalls: number;
  /** 普通路径调用的业务工具（host alias，按序） */
  businessCalls: string[];
  dslCorrect: boolean | undefined;
  finalText: string;
}

async function runHybrid(task: R3Task, runtime: PiRuntime): Promise<HybridResult> {
  const allowed = new Set(task.tools.map((tool) => tool.id));
  const mockAll = task.tools.some((tool) => tool.id.startsWith("github."))
    ? createMockGithubTools()
    : createMockDomainTools();
  const registry = new ToolRegistry<RegisteredTool>(mockAll.filter((tool) => allowed.has(tool.id)));
  const piTools = createPiTools(registry);

  let describeCalls = 0;
  let executeCalls = 0;
  const businessCalls: string[] = [];
  let lastProgramDetails: JitExecuteProgramDetails | undefined;

  const run = await runPiAgent({
    systemPrompt: hybridSystemPrompt(),
    tools: piTools,
    prompt: task.prompt,
    runtime,
    maxRounds: 8,
    onToolCall: ({ name, arguments: args }) => {
      if (name === DESCRIBE_TOOLS_TOOL.name) {
        describeCalls += 1;
        console.log(`  [describe] ${JSON.stringify(args)}`);
        return;
      }
      if (name === EXECUTE_PROGRAM_TOOL.name) {
        executeCalls += 1;
        const source = typeof args["source"] === "string" ? args["source"] : "";
        console.log(`\n[提交程序]\n${source}\n`);
        return;
      }
      businessCalls.push(name);
      console.log(`  [业务] ${name}(${JSON.stringify(args)})`);
    },
    onToolEnd: ({ name, isError, result }) => {
      if (name !== EXECUTE_PROGRAM_TOOL.name) return;
      const details = (result as { details?: JitExecuteProgramDetails } | null)?.details;
      if (details && details.status === "success") {
        lastProgramDetails = details;
        const correctness = checkTaskCorrectness(details.graph, task.spec);
        console.log(`[执行] status=success task_correctness=${correctness.pass}`);
        console.log(`[结果] ${JSON.stringify(details.result).slice(0, 300)}`);
        return;
      }
      if (isError) {
        const text = (result as { content?: Array<{ text?: string }> } | null)?.content?.map((c) => c.text ?? "").join("") ?? "";
        console.log(`[执行失败] ${text.slice(0, 400)}`);
      }
    },
  });

  const path: HybridResult["path"] = executeCalls > 0 ? "dsl" : run.maxedOut ? "maxed_out" : "ordinary";
  const dslCorrect = lastProgramDetails ? checkTaskCorrectness(lastProgramDetails.graph, task.spec).pass : undefined;

  return {
    path,
    rounds: run.rounds,
    describeCalls,
    executeCalls,
    businessCalls,
    dslCorrect: path === "dsl" ? dslCorrect : undefined,
    finalText: run.finalText,
  };
}

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const taskId = Number(process.argv[2] ?? "4");
  const task = R3_TASKS.find((item) => item.id === taskId);
  if (!task) {
    console.error(`[FAIL] 未知任务 id ${taskId}（可选 1-5）`);
    return 1;
  }
  // reasoning 显式冻结：--reasoning 开启；缺省 false，不依赖 gateway 默认值
  const reasoning = process.argv.includes("--reasoning");
  const runtime = createDeepSeekPiRuntime({ reasoning });
  const taskWithNeutralPrompt: R3Task = { ...task, prompt: NEUTRAL_PROMPTS[task.id] ?? task.prompt };

  console.log(`任务 ${taskWithNeutralPrompt.id}（${taskWithNeutralPrompt.name}）— 双通道：业务工具 ${taskWithNeutralPrompt.tools.map((t) => toolIdAlias(t.id)).join(", ")} + ${DESCRIBE_TOOLS_TOOL.name} / ${EXECUTE_PROGRAM_TOOL.name}`);
  console.log(`task prompt（中性，不点名工具）：${taskWithNeutralPrompt.prompt}`);
  console.log(`reasoningEnabled=${reasoning}`);
  console.log("===== 循环开始 =====\n");

  const result = await runHybrid(taskWithNeutralPrompt, runtime);

  console.log(`\n===== 结论 =====`);
  console.log(`执行路径：${result.path === "dsl" ? "describe → compile → execute（DSL 程序化）" : result.path === "ordinary" ? "普通 Tool Calling（逐次调用）" : "达到最大轮数"}`);
  console.log(`轮数：${result.rounds}`);
  console.log(`describe 次数：${result.describeCalls}；execute 次数：${result.executeCalls}`);
  console.log(`业务工具调用序列：${result.businessCalls.join(" → ") || "（无）"}`);
  if (result.path === "dsl") console.log(`DSL 任务正确：${result.dslCorrect}`);
  if (result.finalText.trim()) console.log(`最终文本：${result.finalText.slice(0, 400)}`);
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
