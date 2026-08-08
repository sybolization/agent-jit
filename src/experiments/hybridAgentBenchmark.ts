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
 * 运行：npx tsx src/experiments/hybridAgentBenchmark.ts [taskId]（缺省 4：customer-detail，字段异名区分度最高）
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Tool } from "@earendil-works/pi-ai";

import { compileExecutionDsl, ExecutionDslCompileError } from "../compiler/compile.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, JIT_META_TOOLS, describeToolsResult } from "../tools/jitTools.js";
import { createMockDomainTools } from "../tools/providers/domain/mock.js";
import { createMockGithubTools } from "../tools/providers/github/mock.js";
import { toolIdAlias, ToolRegistry } from "../tools/registry.js";
import { createDeepSeekGateway, type LlmMessage } from "../llm/gateway.js";
import { execute } from "../runtime/runtime.js";
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

async function runHybrid(task: R3Task, gateway: ReturnType<typeof createDeepSeekGateway>): Promise<HybridResult> {
  // 双通道：业务工具（host alias 名）+ JIT 元工具
  const businessTools: Tool[] = task.tools.map((tool) => ({
    name: toolIdAlias(tool.id),
    description: tool.description ?? tool.label,
    parameters: tool.inputSchema,
  }));
  const allTools: readonly Tool[] = [...businessTools, ...JIT_META_TOOLS];

  const allowed = new Set(task.tools.map((tool) => tool.id));
  const mockAll = task.tools.some((tool) => tool.id.startsWith("github."))
    ? createMockGithubTools()
    : createMockDomainTools();
  const registry = new ToolRegistry(mockAll.filter((tool) => allowed.has(tool.id)));

  const messages: LlmMessage[] = [
    { role: "system", content: hybridSystemPrompt() },
    { role: "user", content: task.prompt },
  ];

  const result: HybridResult = {
    path: "maxed_out",
    rounds: 0,
    describeCalls: 0,
    executeCalls: 0,
    businessCalls: [],
    dslCorrect: undefined,
    finalText: "",
  };

  const maxRounds = 8;
  for (let round = 1; round <= maxRounds; round += 1) {
    const { content, toolCalls } = await gateway.complete(messages, { tools: allTools });
    // 协议要求：toolResult 必须跟在带 tool_calls 的 assistant 消息之后
    messages.push({ role: "assistant", content, toolCalls });

    if (toolCalls.length === 0) {
      // 普通路径：模型不再调用工具，直接给出最终答案
      result.path = "ordinary";
      result.rounds = round;
      result.finalText = content;
      return result;
    }

    for (const call of toolCalls) {
      if (call.name === DESCRIBE_TOOLS_TOOL.name) {
        result.describeCalls += 1;
        const toolResult = describeToolsResult(registry, call);
        console.log(`  [describe] ${JSON.stringify(call.arguments)} → ${toolResult.content.slice(0, 200)}`);
        messages.push(toolResult);
        continue;
      }

      if (call.name === EXECUTE_PROGRAM_TOOL.name) {
        result.executeCalls += 1;
        const source = typeof call.arguments["source"] === "string" ? call.arguments["source"].trim() : "";
        console.log(`\n[提交程序]\n${source}\n`);
        if (!source) {
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: EXECUTE_PROGRAM_TOOL.name,
            content: `错误：source 为空。请把完整 DSL 程序放在 source 参数里。`,
            isError: true,
          });
          continue;
        }
        try {
          const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry(task.tools) });
          const correctness = checkTaskCorrectness(graph, task.spec);
          const execution = await execute(graph, registry);
          console.log(`[执行] status=${execution.status} task_correctness=${correctness.pass}`);
          if (execution.status === "success") {
            console.log(`[结果] ${JSON.stringify(execution.result).slice(0, 300)}`);
            result.path = "dsl";
            result.rounds = round;
            result.dslCorrect = correctness.pass;
            result.finalText = content;
            return result;
          }
          // 执行失败（如运行时错误）→ 回填错误让模型修正
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: EXECUTE_PROGRAM_TOOL.name,
            content: `执行失败：${(execution.error ?? "").slice(0, 400)}`,
            isError: true,
          });
        } catch (error) {
          if (error instanceof ExecutionDslCompileError) {
            const feedback = [
              "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
              ...error.diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
            ].join("\n");
            console.log(`[编译失败]\n${feedback}\n`);
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: EXECUTE_PROGRAM_TOOL.name,
              content: feedback,
              isError: true,
            });
          } else {
            throw error;
          }
        }
        continue;
      }

      // 普通业务工具：registry.get 经 resolver 解析（canonical / host alias 无感）
      const tool = registry.get(call.name);
      result.businessCalls.push(call.name);
      if (!tool || typeof tool.execute !== "function") {
        console.log(`  [业务] 未知工具 ${call.name}`);
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: `未知工具：${call.name}`,
          isError: true,
        });
        continue;
      }
      console.log(`  [业务] ${call.name}(${JSON.stringify(call.arguments)})`);
      let resultText: string;
      let isError = false;
      try {
        resultText = JSON.stringify(await tool.execute(call.arguments));
      } catch (error) {
        resultText = String((error as Error).message);
        isError = true;
      }
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: resultText,
        isError,
      });
    }
    result.rounds = round;
  }
  return result;
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
  const gateway = createDeepSeekGateway();
  const taskWithNeutralPrompt: R3Task = { ...task, prompt: NEUTRAL_PROMPTS[task.id] ?? task.prompt };

  console.log(`任务 ${taskWithNeutralPrompt.id}（${taskWithNeutralPrompt.name}）— 双通道：业务工具 ${taskWithNeutralPrompt.tools.map((t) => toolIdAlias(t.id)).join(", ")} + ${JIT_META_TOOLS.map((t) => t.name).join(" / ")}`);
  console.log(`task prompt（中性，不点名工具）：${taskWithNeutralPrompt.prompt}`);
  console.log("===== 循环开始 =====\n");

  const result = await runHybrid(taskWithNeutralPrompt, gateway);

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
