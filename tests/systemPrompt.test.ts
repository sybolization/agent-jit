import { describe, expect, test } from "vitest";

import { buildDslSystemPrompt, DSL_CONSTRUCTS } from "../src/prompt/systemPrompt.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../src/tools/jitTools.js";

describe("buildDslSystemPrompt — 统一 DSL 系统提示词（契约按需获取）", () => {
  test("三段结构：工作方式 / 语法 / 硬约束", () => {
    const prompt = buildDslSystemPrompt({ constructs: ["map", "take", "return"] });
    expect(prompt).toContain("## 工作方式（工具契约按需获取，提示词不内嵌工具目录）");
    expect(prompt).toContain("## 语法（newline 分隔语句，每条独占一行）");
    expect(prompt).toContain("## 硬约束");
  });

  test("两个元工具的名称与工作流顺序写进提示词（describe → 写程序 → execute）", () => {
    const prompt = buildDslSystemPrompt({ constructs: ["take", "return"] });
    const describeAt = prompt.indexOf('jit_describe_tools(tool_names=["工具 id", ...])');
    const executeAt = prompt.indexOf('jit_execute_program(source="...")');
    expect(describeAt).toBeGreaterThan(-1);
    expect(executeAt).toBeGreaterThan(describeAt);
  });

  test("提示词不内嵌业务工具目录（契约按需经 jit_describe_tools 获取）", () => {
    const prompt = buildDslSystemPrompt({ constructs: ["map", "take", "return"] });
    expect(prompt).not.toContain("github.search_repositories(");
    expect(prompt).not.toContain("RepositorySummary");
    expect(prompt).not.toContain("## 可用工具");
  });

  test("关键字列表由 constructs 推导（map-lambda 不算关键字）", () => {
    const prompt = buildDslSystemPrompt({ constructs: ["take", "return", "map-lambda"] });
    expect(prompt).toContain("语言关键字 map / take / return");
  });

  test("constructs 条目按启用子集渲染（r4e 全量含 compute/select/join）", () => {
    const prompt = buildDslSystemPrompt({
      constructs: ["map", "take", "filter", "sort", "compute", "select", "join", "return"],
    });
    expect(prompt).toContain('ratio = compute(details, ratio="forks / stars")');
    expect(prompt).toContain('merged = join(ratio, contrib, commit, key="full_name")');
  });

  test("默认硬约束自动编号，额外约束追加", () => {
    const prompt = buildDslSystemPrompt({
      constructs: ["map", "take"],
      constraints: ["分支要互补：ratio > 0.15 与 ratio <= 0.15 各写一次 select"],
    });
    expect(prompt).toContain("1. 必须通过调用 jit_execute_program 工具提交程序");
    expect(prompt).toContain("4. 引用字段（map 绑定 _.字段、sort key、filter 条件）必须来自 jit_describe_tools 返回契约中的输出字段");
    expect(prompt).toContain("7. 分支要互补：ratio > 0.15 与 ratio <= 0.15 各写一次 select");
  });

  test("提示词引用的元工具名与 jitTools 定义一致（单一事实源）", () => {
    const prompt = buildDslSystemPrompt({ constructs: ["take", "return"] });
    expect(prompt).toContain(DESCRIBE_TOOLS_TOOL.name);
    expect(prompt).toContain(EXECUTE_PROGRAM_TOOL.name);
  });
});

describe("DSL_CONSTRUCTS — 语言构造条目注册表", () => {
  test("覆盖 canonical 全部构造 + map 三种绑定形态", () => {
    for (const key of ["map", "take", "filter", "sort", "compute", "select", "join", "return", "map-key", "map-lambda"]) {
      expect(DSL_CONSTRUCTS[key]?.length, key).toBeGreaterThan(0);
    }
  });
});
