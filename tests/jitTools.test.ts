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
    expect(DESCRIBE_TOOLS_TOOL.description).toContain("函数签名");
    expect(DESCRIBE_TOOLS_TOOL.description).toContain("按需查询");
    expect(DESCRIBE_TOOLS_TOOL.description).not.toContain("先调用本工具"); // 不再是必经步骤
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

describe("describeToolContracts — signature 格式（production 默认，与 inline DSL 签名同源）", () => {
  test("函数式单行签名：参数 + 返回类型，无四段式类型定义", () => {
    const text = describeToolContracts(githubCatalog(), ["github.search_repositories", "github.get_repository"]);
    expect(text).toContain("github.search_repositories(query: str, limit?: int)");
    expect(text).toContain("->");
    expect(text).toContain("github.get_repository(full_name: str)");
    // 与 legacy 四段式的区别：没有类型定义段与参数格式说明
    expect(text).not.toContain("## 类型定义");
    expect(text).not.toContain("# 参数格式");
    expect(text).not.toContain("github.list_commits");
  });

  test("header 可选（DSH/Pi describe 传 # Requested Tool Contracts）", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository"], {
      header: "# Requested Tool Contracts",
    });
    expect(text.startsWith("# Requested Tool Contracts")).toBe(true);
    expect(text).toContain("github.get_repository(full_name: str)");
  });

  test("host alias 无感解析 + 重复去重 + 保持请求顺序（与 legacy 同规则）", () => {
    const text = describeToolContracts(githubCatalog(), ["github_get_repository", "github.search_repositories"]);
    expect(text.indexOf("github.get_repository(")).toBeLessThan(text.indexOf("github.search_repositories("));
    expect(text.match(/github\.get_repository\(/g) ?? []).toHaveLength(1);
  });

  test("signature 与 inline 渲染同源：字段带语义标签（fieldLabels）", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository"]);
    expect(text).toContain("github.get_repository(full_name: str)");
  });
});

describe("describeToolContracts — legacy 格式（历史 eager 臂，逐字节复现）", () => {
  test("子集渲染：只包含请求的工具，输入 + 输出契约齐备", () => {
    const text = describeToolContracts(githubCatalog(), ["github.search_repositories", "github.get_repository"], {
      format: "legacy",
    });
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
    const text = describeToolContracts(githubCatalog(), ["github.search_repositories", "github.get_repository"], {
      format: "legacy",
    });
    expect(text.indexOf("github.search_repositories(")).toBeLessThan(text.indexOf("github.get_repository("));
  });

  test("请求顺序颠倒时按请求顺序回显", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "github.search_repositories"], {
      format: "legacy",
    });
    expect(text.indexOf("github.get_repository(")).toBeLessThan(text.indexOf("github.search_repositories("));
  });

  test("重复 id 去重", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "github.get_repository"], {
      format: "legacy",
    });
    expect(text.match(/github\.get_repository\(/g) ?? []).toHaveLength(1);
  });

  test("host alias 可无感解析（github_get_repository → github.get_repository）", () => {
    const text = describeToolContracts(githubCatalog(), ["github_get_repository"], { format: "legacy" });
    expect(text).toContain("github.get_repository(");
    expect(text).toContain("-> Repository");
  });

  test("canonical 与 host alias 同时请求去重为一次", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "github_get_repository"], {
      format: "legacy",
    });
    expect(text.match(/github\.get_repository\(/g) ?? []).toHaveLength(1);
  });

  test("禁止 partial success：[known, unknown] 整体失败，不返回任何契约", () => {
    const text = describeToolContracts(githubCatalog(), ["github.get_repository", "foo.bar"], {
      format: "legacy",
    });
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("UNKNOWN_TOOL: foo.bar");
    expect(text).not.toContain("github.get_repository(");
    expect(text).not.toContain("Repository");
  });

  test("全部未知 → UNKNOWN_TOOL，不 dump 全部 registry", () => {
    const text = describeToolContracts(githubCatalog(), ["foo.bar"], { format: "legacy" });
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("UNKNOWN_TOOL: foo.bar");
    expect(text).not.toContain("可用工具");
    expect(text).not.toContain("github.search_repositories");
  });

  test("多个未知一次性全部列出，并带确定性近似建议（alias + canonical）", () => {
    const text = describeToolContracts(githubCatalog(), ["github_get_repositry", "foo.bar"], {
      format: "legacy",
    });
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("UNKNOWN_TOOL: github_get_repositry, foo.bar");
    expect(text).toContain("github_get_repository");
    expect(text).toContain("github.get_repository");
  });

  test("相似度太低的未知工具不硬推荐", () => {
    const text = describeToolContracts(githubCatalog(), ["totally_unrelated"], { format: "legacy" });
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("UNKNOWN_TOOL: totally_unrelated");
    expect(text).not.toContain("你是否指");
  });

  test("tool_names 超过上限（>20）→ 错误，提示分批查询", () => {
    const names = Array.from({ length: 21 }, (_, i) => `github.tool_${i}`);
    const text = describeToolContracts(githubCatalog(), names, { format: "legacy" });
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("最多 20 个");
  });

  test("空列表 → 错误文本", () => {
    const text = describeToolContracts(githubCatalog(), [], { format: "legacy" });
    expect(text.startsWith("错误")).toBe(true);
    expect(text).toContain("tool_names 为空");
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
