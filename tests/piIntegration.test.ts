import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { adaptRegisteredTool, createPiTools } from "../src/integrations/pi/toolAdapter.js";
import {
  createJitDescribeTool,
  createJitExecuteProgramTool,
  MINIMAL_DSL_REFERENCE,
  type JitExecuteProgramDetails,
} from "../src/integrations/pi/jit.js";
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

  test("DSL manual 按需加载：第一次 describe 附带极简语法参考，后续不再重复", async () => {
    const lazyTool = createJitDescribeTool(makeRegistry());
    const first = await lazyTool.execute("c1", { tool_names: ["github.get_repository"] });
    const firstText = (first.content[0] as { type: "text"; text: string }).text;
    expect(firstText).toContain("Agent Execution DSL 极简参考");
    expect(firstText).toContain("merge_by_key("); // R5 review：join → merge_by_key（base+overlay 语义）
    expect(firstText).toContain("concat("); // 真正的列表拼接
    expect(firstText).toContain("github.get_repository("); // 契约仍然返回
    const second = await lazyTool.execute("c2", { tool_names: ["github.get_repository"] });
    const secondText = (second.content[0] as { type: "text"; text: string }).text;
    expect(secondText).not.toContain("Agent Execution DSL 极简参考");
    expect(secondText).toContain("github.get_repository(");
  });

  test("DSL manual 不泄露任务常量（B 型：query/limit/阈值/take）", async () => {
    const lazyTool = createJitDescribeTool(makeRegistry());
    const result = await lazyTool.execute("c1", { tool_names: ["github.get_repository"] });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    // B 型任务的设计常量（r5Tasks.ts R5_B_SPEC）绝不能出现在参考示例里——否则示例变成可复制模板
    expect(text).not.toContain('query="agent framework"');
    expect(text).not.toContain("limit=30");
    expect(text).not.toContain("ratio > 0.15");
    expect(text).not.toContain("score >= 100");
    expect(text).not.toContain("take(ranked, 3)");
  });

  test("DSL manual 只含 primitive 级示例（不再包含完整 workflow 拓扑模板）", () => {
    const manual = MINIMAL_DSL_REFERENCE;
    // 完整流水线示例的三个结构标志都不应出现（R5-B 与模板拓扑同构会让模型照抄控制流，无法归因于语义澄清）：
    expect(manual).not.toMatch(/^\s*\w+\s*=\s*[a-z_]+\./m); // 以业务工具调用起步（如 repos = github.search_repositories(...)）
    expect(manual).not.toMatch(/^\s*return\s+\w+/m); // 以 return 收尾的完整流水线
    expect(manual).not.toMatch(/select\([^,]+, "\w+ <=/); // 同一字段的互补分支对（B 拓扑：> 与 <= 成对）
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
