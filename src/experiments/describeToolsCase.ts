#!/usr/bin/env node

/**
 * JIT describe_tools 冒烟 case：真实调用 DeepSeek 模型，
 * 验证模型是否会主动调用 jit_describe_tools 获取 DSL 契约，再写程序提交。
 *
 * 任务：R3 任务 4（CRM customer-detail）——字段**异名**（id → customer_id），
 * 模型不调用 describe 就不知道 crm.get_customer 的参数名与输出字段，
 * 是对"模型会不会用 describe 工具"最有区分度的一个 case。
 *
 * 运行：npx tsx src/experiments/describeToolsCase.ts
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileExecutionDslLegacy } from "./languageVariants/legacyCompile.js";
import { ExecutionDslCompileError } from "../compiler/compile.js";
import { buildDslSystemPrompt } from "../prompt/systemPrompt.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL, JIT_META_TOOLS, describeToolsResult } from "../tools/jitTools.js";
import { createMockDomainTools } from "../tools/providers/domain/mock.js";
import { ToolRegistry } from "../tools/registry.js";
import { createDeepSeekGateway, type LlmMessage } from "../llm/gateway.js";
import { execute } from "../runtime/runtime.js";
import { R3_TASKS } from "./r3Tasks.js";
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

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const task = R3_TASKS.find((item) => item.id === 4)!; // customer-detail（字段异名，区分度最高）
  const gateway = createDeepSeekGateway();
  const messages: LlmMessage[] = [
    { role: "system", content: buildDslSystemPrompt({ constructs: ["take", "return", "map"] }) },
    { role: "user", content: task.prompt },
  ];

  let describeCalls = 0;
  let executeCalls = 0;
  const maxRounds = 6;

  console.log(`任务 ${task.id}（${task.name}）— 对模型可见工具：${task.tools.map((t) => t.id).join(", ")}`);
  console.log(`提示词不内嵌工具目录；元工具：${JIT_META_TOOLS.map((t) => t.name).join(" / ")}`);
  console.log("===== 循环开始 =====\n");

  for (let round = 1; round <= maxRounds; round += 1) {
    const { content, toolCalls } = await gateway.complete(messages, { tools: JIT_META_TOOLS });
    console.log(`--- 第 ${round} 轮 ---`);
    if (content.trim()) console.log(`text: ${content.slice(0, 300)}`);
    for (const call of toolCalls) {
      console.log(`toolCall: ${call.name} ${JSON.stringify(call.arguments)}`);
    }
    // 协议要求：toolResult 必须跟在带 tool_calls 的 assistant 消息之后
    messages.push({ role: "assistant", content, toolCalls });

    const describe = toolCalls.find((call) => call.name === DESCRIBE_TOOLS_TOOL.name);
    if (describe) {
      describeCalls += 1;
      const result = describeToolsResult(new ToolRegistry(task.tools), describe);
      console.log(`\n[describe_tools 返回]（${result.content.length} 字符）\n${result.content}\n`);
      messages.push(result);
      continue;
    }

    const submit = toolCalls.find((call) => call.name === EXECUTE_PROGRAM_TOOL.name);
    const source = typeof submit?.arguments.source === "string" ? submit.arguments.source.trim() : "";

    if (!source) {
      console.log("（无 jit_execute_program 提交，提示模型）");
      messages.push({
        role: "user",
        content: `你没有通过 ${EXECUTE_PROGRAM_TOOL.name} 工具提交程序。请调用 ${EXECUTE_PROGRAM_TOOL.name} 工具，把完整 DSL 程序放在 source 参数里（不要写在回复文本中）。`,
      });
      continue;
    }
    executeCalls += 1;
    console.log(`\n[提交程序]\n${source}\n`);

    try {
      const { graph } = compileExecutionDslLegacy(source, {
        tools: task.tools,
        allowCallableRef: false,
        allowMapBinding: "call",
      });
      const correctness = checkTaskCorrectness(graph, task.spec);
      const allowed = new Set(task.tools.map((t) => t.id));
      const registry = new ToolRegistry(createMockDomainTools().filter((tool) => allowed.has(tool.id)));
      const execution = await execute(graph, registry);
      const result = execution.status === "success" ? execution.result : undefined;
      const rows = Array.isArray(result) ? (result as Array<{ id: string }>) : []; // 契约输出字段：id
      console.log(`\n[执行] status=${execution.status} rows=${rows.length} task_correctness=${correctness.pass}`);
      if (execution.status !== "success") {
        console.log(`  错误：${(execution.error ?? "").slice(0, 400)}`);
      }
      console.log(`[结果] ${rows.map((r) => r.id).join(", ")}`);
      console.log(`\n===== 结论 =====`);
      console.log(`describe_tools 调用次数：${describeCalls}`);
      console.log(`execute_program 调用次数：${executeCalls}`);
      console.log(`是否先 describe 再写程序：${describeCalls > 0 ? "是" : "否"}`);
      console.log(`任务正确：${correctness.pass}`);
      return 0;
    } catch (error) {
      if (error instanceof ExecutionDslCompileError) {
        const feedback = [
          "编译失败，请根据以下诊断修正 DSL 后再次调用 jit_execute_program 重新提交：",
          ...error.diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`),
        ].join("\n");
        console.log(`\n[编译失败]\n${feedback}\n`);
        messages.push({
          role: "toolResult",
          toolCallId: submit!.id,
          toolName: EXECUTE_PROGRAM_TOOL.name,
          content: feedback,
          isError: true,
        });
        continue;
      }
      console.log(`\n[异常] ${(error as Error).message}`);
      return 1;
    }
  }

  console.log(`\n===== 达到最大轮数 ${maxRounds} =====`);
  console.log(`describe_tools 调用次数：${describeCalls}`);
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
