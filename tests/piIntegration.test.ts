import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { adaptRegisteredTool, createPiTools } from "../src/integrations/pi/toolAdapter.js";
import {
  createJitDescribeTool,
  createJitExecuteProgramTool,
  type JitExecuteProgramDetails,
} from "../src/integrations/pi/jit.js";
import { renderDslReference } from "../src/integrations/pi/dslReference.js";
import { defineTool, type RegisteredTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createMockGithubTools } from "../src/tools/providers/github/mock.js";

const GITHUB_IDS = ["github.search_repositories", "github.get_repository"];

function makeRegistry(): ToolRegistry<RegisteredTool> {
  return new ToolRegistry(createMockGithubTools().filter((tool) => GITHUB_IDS.includes(tool.id)));
}

describe("createPiTools — ToolRegistry → Pi AgentTool（JIT 变成真正的 Pi Agent Tool）", () => {
  test("返回普通业务工具（host alias 名）+ jit_describe_tools + jit_execute_program", () => {
    const tools = createPiTools(makeRegistry());
    expect(tools.map((tool) => tool.name)).toEqual([
      "github_search_repositories",
      "github_get_repository",
      "jit_describe_tools",
      "jit_execute_program",
    ]);
  });

  test("每个 AgentTool 都有 label / description / parameters / execute", () => {
    const tools = createPiTools(makeRegistry());
    for (const tool of tools) {
      expect(tool.label).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("普通业务工具：execute 透传原 RegisteredTool.execute，结果序列化为文本 content", async () => {
    const tools = createPiTools(makeRegistry());
    const repoTool = tools[1]!;
    const result = await repoTool.execute("call-1", { full_name: "mock/org-repo-0" });
    const text = result.content[0] as { type: "text"; text: string };
    expect(text.type).toBe("text");
    expect(text.text).toContain("mock/org-repo-0");
  });

  test("description 缺省回退到 label", () => {
    const bare = defineTool({
      id: "demo.no_description",
      label: "No Description Tool",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
    });
    const registry = new ToolRegistry<RegisteredTool>([{ ...bare, execute: async () => ({ ok: true }) }]);
    const [adapted] = createPiTools(registry);
    expect(adapted!.description).toBe("No Description Tool");
  });

  test("adaptRegisteredTool 用 host alias 作为 Pi 工具名", () => {
    const registry = makeRegistry();
    const [search] = registry.all();
    const adapted = adaptRegisteredTool(registry, search!);
    expect(adapted.name).toBe("github_search_repositories");
  });
});

describe("jit_describe_tools（AgentTool）— 严格语义", () => {
  const registry = makeRegistry();
  const tool = createJitDescribeTool(registry);

  test("tool_names 走 resolver：canonical / host alias 等价解析，返回契约文本", async () => {
    const result = await tool.execute("c1", { tool_names: ["github.get_repository", "github_get_repository"] });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("github.get_repository(");
    expect(text).toContain("full_name: string");
    expect(text).toContain("Repository");
  });

  test("任一 id 未知 → 整体失败（UNKNOWN_TOOL 全列），不返回部分契约", async () => {
    await expect(
      tool.execute("c2", { tool_names: ["github.get_repository", "nope.tool", "also_missing"] }),
    ).rejects.toThrow(/UNKNOWN_TOOL: nope\.tool, also_missing/);
  });

  test("tool_names 为空 → 报错", async () => {
    await expect(tool.execute("c3", { tool_names: [] })).rejects.toThrow(/tool_names 为空/);
  });

  test("DSL manual 按需加载：第一次 describe 附带语法参考（默认 primitive），后续只返回契约 + bindings", async () => {
    const lazyTool = createJitDescribeTool(makeRegistry());
    const first = await lazyTool.execute("c1", { tool_names: ["github.get_repository"] });
    const firstText = (first.content[0] as { type: "text"; text: string }).text;
    expect(firstText).toContain("## 1. Tool calls"); // manual 只随首次 describe 返回
    expect(firstText).not.toContain("Composition patterns"); // 默认 primitive：只含核心参考
    expect(firstText).toContain("merge_by_key("); // R5 review：join → merge_by_key（base+overlay 语义）
    expect(firstText).toContain("concat("); // 真正的列表拼接
    expect(firstText).toContain("github.get_repository("); // 契约仍然返回
    const second = await lazyTool.execute("c2", { tool_names: ["github.get_repository"] });
    const secondText = (second.content[0] as { type: "text"; text: string }).text;
    expect(secondText).not.toContain("## 1. Tool calls"); // manual 不再重复
    expect(secondText).toContain("github.get_repository(");
  });

  test("DSL manual 不泄露任务常量（B 型：query/limit/阈值/take，三种模式 + describe 输出全检查）", async () => {
    const B_CONSTANTS = ['query="agent framework"', "limit=30", "ratio > 0.15", "score >= 100", "take(ranked, 3)"];
    for (const mode of ["primitive", "patterns", "full-example"] as const) {
      const manual = renderDslReference(mode);
      for (const constant of B_CONSTANTS) {
        expect(manual, `mode=${mode} 不应含 ${constant}`).not.toContain(constant);
      }
    }
    // describe 首次返回（默认 primitive）同样不含
    const lazyTool = createJitDescribeTool(makeRegistry());
    const result = await lazyTool.execute("c1", { tool_names: ["github.search_repositories", "github.get_repository"] });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    for (const constant of B_CONSTANTS) expect(text).not.toContain(constant);
  });

  test("renderDslReference 三模式：primitive 无组合模式；patterns 教局部 idiom；只有 full-example 含端到端链", () => {
    // primitive：只有三层语言模型，无组合模式、无端到端链
    const primitive = renderDslReference("primitive");
    expect(primitive).toContain("## 1. Tool calls");
    expect(primitive).toContain("## 2. Array dataflow operators");
    expect(primitive).toContain("## 3. Return");
    expect(primitive).not.toContain("Composition patterns");
    expect(primitive).not.toContain("Full workflow example");

    // patterns：核心 + 组合模式；允许局部拓扑（互补 select 对作为 idiom），禁止端到端 B 链
    const patterns = renderDslReference("patterns");
    expect(patterns).toContain("Composition patterns");
    expect(patterns).toContain("Pattern A: Fan-out");
    expect(patterns).toContain("Pattern B: Split + recombine");
    expect(patterns).toContain("Pattern C: Enrichment");
    expect(patterns).toContain('select(items, "value <= 0")'); // 互补 select 对 = 允许的局部 idiom
    expect(patterns).toContain("merge_by_key(base, overlays..., key=...)");
    expect(patterns).not.toContain("github.get_contributor_stats"); // 端到端 B 链分支工具禁止
    expect(patterns).not.toContain("github.list_commits");
    expect(patterns).not.toContain('"score >=');
    expect(patterns).not.toContain('key="score"');
    expect(patterns).not.toContain("Full workflow example");

    // full-example：唯一允许端到端链的模式（B 常量由"不泄露任务常量"测试把关）
    const full = renderDslReference("full-example");
    expect(full).toContain("Full workflow example");
    expect(full).toContain("github.get_contributor_stats");
    expect(full).toContain("github.list_commits");
    expect(full).toContain("return top");
  });

  test("四段式输出：manual + # Requested Tool Contracts + ## Compatible bindings（patterns 模式每次返回）", async () => {
    const lazyTool = createJitDescribeTool(makeRegistry(), { guidance: "patterns" });
    const first = await lazyTool.execute("c1", {
      tool_names: ["github.search_repositories", "github.get_repository"],
    });
    const firstText = (first.content[0] as { type: "text"; text: string }).text;
    // 段 1-3：语言模型 + 核心算子 + 组合模式（manual）
    expect(firstText).toContain("## 1. Tool calls");
    expect(firstText).toContain("## 2. Array dataflow operators");
    expect(firstText).toContain("Composition patterns");
    // 段 4：请求的工具契约
    expect(firstText).toContain("# Requested Tool Contracts");
    expect(firstText).toContain("github.search_repositories(");
    // 段 5：Schema 推导的局部兼容连接
    expect(firstText).toContain("## Compatible bindings");
    expect(firstText).toContain("github.search_repositories[].full_name");
    expect(firstText).toContain("→ github.get_repository(full_name)");
    // 第二次 describe 不重复 manual，但 bindings 仍针对本次请求返回
    const second = await lazyTool.execute("c2", {
      tool_names: ["github.search_repositories", "github.get_repository"],
    });
    const secondText = (second.content[0] as { type: "text"; text: string }).text;
    expect(secondText).not.toContain("## 1. Tool calls");
    expect(secondText).toContain("# Requested Tool Contracts");
    expect(secondText).toContain("## Compatible bindings");
    expect(secondText).toContain("github.search_repositories[].full_name");
  });

  test("guidance 影响 describe 输出：primitive 无组合模式与 bindings；full-example 含端到端示例", async () => {
    const primitiveTool = createJitDescribeTool(makeRegistry(), { guidance: "primitive" });
    const primitiveText = (
      (await primitiveTool.execute("c1", {
        tool_names: ["github.search_repositories", "github.get_repository"],
      })).content[0] as { type: "text"; text: string }
    ).text;
    expect(primitiveText).toContain("## 1. Tool calls");
    expect(primitiveText).not.toContain("Composition patterns");
    expect(primitiveText).not.toContain("## Compatible bindings"); // Z 下界：无组合模式、无 hints

    const fullTool = createJitDescribeTool(makeRegistry(), { guidance: "full-example" });
    const fullText = (
      (await fullTool.execute("c1", {
        tool_names: ["github.search_repositories", "github.get_repository"],
      })).content[0] as { type: "text"; text: string }
    ).text;
    expect(fullText).toContain("Full workflow example");
    expect(fullText).toContain("return top");
    expect(fullText).not.toContain("## Compatible bindings"); // F 上界：只有完整示例，无 hints
  });
});

describe("jit_execute_program（AgentTool）— 编译 + 同一 registry 执行", () => {
  const registry = makeRegistry();
  const tool = createJitExecuteProgramTool(registry);

  const PROGRAM = [
    'repos = github.search_repositories(query="agent framework", limit=10)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    "top = take(details, 3)",
    "return top",
  ].join("\n");

  test("DSL 程序在**同一 registry** 上编译并执行，返回结果与结构化 details", async () => {
    const result = await tool.execute("c1", { source: PROGRAM });
    const details = result.details as JitExecuteProgramDetails;
    expect(result.content[0]?.type).toBe("text");
    expect(details.status).toBe("success");
    expect(Array.isArray(details.result)).toBe(true);
    expect(details.result).toHaveLength(3);
    // IR 节点：search + map + take + return（同一 registry 解析，canonical id）
    const tools = details.graph.nodes
      .filter((node) => node.kind === "tool" || node.kind === "map")
      .map((node) => (node.kind === "tool" ? node.tool : node.tool));
    expect(tools).toContain("github.search_repositories");
    expect(tools).toContain("github.get_repository");
    expect(details.trace.some((entry) => entry.kind === "map" && entry.fanout === 10)).toBe(true);
  });

  test("编译失败 → throw（含诊断反馈 + 期望语义提示，模型据此一次修复）", async () => {
    await expect(tool.execute("c2", { source: 'x = github.nope(query="a")' })).rejects.toThrow(/编译失败/);
    await expect(tool.execute("c2", { source: 'x = github.nope(query="a")' })).rejects.toThrow(/unknown_tool/);
    await expect(tool.execute("c2", { source: 'x = github.nope(query="a")' })).rejects.toThrow(/期望/);
  });

  test("执行失败（运行时错误）→ throw", async () => {
    // map 的 source 是对象而非数组 → 运行时错误
    const source = [
      'x = github.get_repository(full_name="mock/org-repo-0")',
      "y = map(x, github.get_repository(full_name=_.full_name))",
      "return y",
    ].join("\n");
    await expect(tool.execute("c3", { source })).rejects.toThrow(/执行失败/);
  });

  test("source 为空 → 报错", async () => {
    await expect(tool.execute("c4", { source: "   " })).rejects.toThrow(/source 为空/);
  });
});
