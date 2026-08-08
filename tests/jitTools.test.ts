import { describe, expect, test } from "vitest";

import { githubTools } from "../src/tools/providers/github/contracts.js";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  DESCRIBE_TOOLS_TOOL,
  EXECUTE_PROGRAM_TOOL,
  JIT_META_TOOLS,
  describeToolContracts,
  describeToolsResult,
} from "../src/tools/jitTools.js";

const githubCatalog = (): ToolRegistry => new ToolRegistry(githubTools);

describe("JIT 元工具定义", () => {
  test("jit_describe_tools：tool_names 数组参数", () => {
    expect(DESCRIBE_TOOLS_TOOL.name).toBe("jit_describe_tools");
    expect(DESCRIBE_TOOLS_TOOL.description).toContain("契约");
    expect(DESCRIBE_TOOLS_TOOL.parameters).toBeDefined();
  });

  test("jit_execute_program：source 字符串参数", () => {
    expect(EXECUTE_PROGRAM_TOOL.name).toBe("jit_execute_program");
    expect(EXECUTE_PROGRAM_TOOL.description).toContain("source");
    expect(EXECUTE_PROGRAM_TOOL.parameters).toBeDefined();
  });

  test("JIT_META_TOOLS 恰好两个元工具", () => {
    expect(JIT_META_TOOLS.map((tool) => tool.name)).toEqual(["jit_describe_tools", "jit_execute_program"]);
  });
});

describe("describeToolContracts — 确定性 DSL 契约渲染（tool_names → SchemaView → 文本）", () => {
  test("子集渲染：只包含请求的工具，输入 + 输出契约齐备", () => {
    const text = describeToolContracts(githubCatalog(), ["github.search_repositories", "github.get_repository"]);
    expect(text).toContain("github.search_repositories(");
    expect(text).toContain("  query: string");
    expect(text).toContain("-> RepositorySummary[]");
    expect(text).toContain("github.get_repository(");
    expect(text).toContain("-> Repository");
    expect(text).toContain("Repository {");
    expect(text).toContain("  full_name: string");
    // 未请求的工具不出现在结果里
    expect(text).not.toContain("github.list_commits");
  });

  test("保持请求顺序（search 先于 get_repository）", () => {
    const text = describeToolContracts(githubCatalog(), ["github.search_repositories", "github.get_repository"]);
    expect(text.indexOf("github.search_repositories(")).toBeLessThan(text.indexOf("github.get_repository("));
  });

  test("请求顺序颠倒时按请求顺序回显", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "github.search_repositories"]);
    expect(text.indexOf("github.get_repository(")).toBeLessThan(text.indexOf("github.search_repositories("));
  });

  test("重复 id 去重", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "github.get_repository"]);
    expect(text.match(/github\.get_repository\(/g) ?? []).toHaveLength(1);
  });

  test("未注册 id 忽略并在结尾注明，可用 id 列出", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "foo.bar"]);
    expect(text).toContain("github.get_repository(");
    expect(text).toContain("foo.bar");
    expect(text).toContain("以下工具未注册，已忽略");
  });

  test("全部未知 → 错误文本（含可用 id）", () => {
    const text = describeToolContracts(githubCatalog(), ["foo.bar"]);
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("github.search_repositories");
  });

  test("空列表 → 错误文本", () => {
    const text = describeToolContracts(githubCatalog(), []);
    expect(text.startsWith("错误")).toBe(true);
  });
});

describe("describeToolsResult — dispatch 消息构造", () => {
  test("正常契约 → 非错误 toolResult", () => {
    const call = { id: "call-1", name: "jit_describe_tools", arguments: { tool_names: ["github.get_repository"] } };
    const message = describeToolsResult(githubCatalog(), call);
    expect(message.role).toBe("toolResult");
    expect(message.toolCallId).toBe("call-1");
    expect(message.toolName).toBe("jit_describe_tools");
    expect(message.isError).toBe(false);
    expect(message.content).toContain("github.get_repository(");
  });

  test("未知工具 → 错误 toolResult", () => {
    const call = { id: "call-2", name: "jit_describe_tools", arguments: { tool_names: ["foo.bar"] } };
    const message = describeToolsResult(githubCatalog(), call);
    expect(message.isError).toBe(true);
  });

  test("tool_names 缺失/非数组 → 空列表错误", () => {
    const call = { id: "call-3", name: "jit_describe_tools", arguments: {} };
    const message = describeToolsResult(githubCatalog(), call);
    expect(message.isError).toBe(true);
    expect(message.content).toContain("tool_names 为空");
  });
});
