import { describe, expect, test } from "vitest";

import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../src/tools/jitTools.js";
import { R3_TASKS } from "../src/experiments/r3Tasks.js";
import { NEUTRAL_PROMPTS, hybridSystemPrompt } from "../src/experiments/hybridAgentBenchmark.js";

describe("hybridSystemPrompt — 双通道，选择权交给模型", () => {
  const prompt = hybridSystemPrompt();

  test("同时包含普通业务工具通道与 JIT 元工具通道", () => {
    expect(prompt).toContain("普通业务工具（单次调用）");
    expect(prompt).toContain(DESCRIBE_TOOLS_TOOL.name);
    expect(prompt).toContain(EXECUTE_PROGRAM_TOOL.name);
  });

  test("DSL 语法（map/take/return）说明在提示词内", () => {
    expect(prompt).toContain("map：第二个参数是“绑定调用”");
    expect(prompt).toContain("take：截取前 N 条");
    expect(prompt).toContain("return：返回变量");
  });

  test("工具名两种写法等价（canonical / host alias），不要求换算", () => {
    expect(prompt).toContain("host alias（github_get_repository）");
    expect(prompt).toContain("无需换算");
  });

  test("不强制某一条路径（不出现“必须用 DSL”）", () => {
    expect(prompt).not.toContain("必须用");
  });
});

describe("NEUTRAL_PROMPTS — task prompt 不点名工具、不预设机制（#11 约束）", () => {
  test("覆盖全部 R3 任务（1-5）", () => {
    expect(Object.keys(NEUTRAL_PROMPTS).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("每个任务的中性 prompt 不含任何工具 id（无点号名）", () => {
    for (const task of R3_TASKS) {
      const prompt = NEUTRAL_PROMPTS[task.id]!;
      for (const tool of task.tools) {
        expect(prompt, `任务 ${task.id} 不应点名工具 ${tool.id}`).not.toContain(tool.id);
      }
      expect(prompt, `任务 ${task.id} 不应出现点号工具名`).not.toMatch(/[a-z]+\.[a-z_]+/);
    }
  });

  test("中性 prompt 不预设 DSL 机制（不含“Agent Execution DSL”）", () => {
    for (const task of R3_TASKS) {
      expect(NEUTRAL_PROMPTS[task.id], `任务 ${task.id}`).not.toContain("Agent Execution DSL");
      expect(NEUTRAL_PROMPTS[task.id], `任务 ${task.id}`).not.toContain("编写程序");
    }
  });

  test("保留任务的取数要求（前 N 个 / 截取）与 query 约束，spec 判定可复用", () => {
    expect(NEUTRAL_PROMPTS[1]).toContain("取前 10 个");
    expect(NEUTRAL_PROMPTS[4]).toContain("前 3 个客户");
    expect(NEUTRAL_PROMPTS[5]).toContain("前 3 封邮件");
    // R3 spec.queryTokens 要求 query 含 language:typescript——中性 prompt 保留任务约束
    for (const id of [1, 2, 3]) {
      expect(NEUTRAL_PROMPTS[id]).toContain("language:typescript");
    }
  });
});
