import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import { defineTool } from "../src/tools/definition.js";
import {
  dslSignatureOf,
  dslTypeOf,
  renderDslSignature,
  renderDslType,
  type DslType,
} from "../src/tools/dslSignature.js";

const getRepositoryTool = defineTool({
  id: "github.get_repository",
  label: "Get a repository",
  description: "获取单个仓库的详细信息。",
  inputSchema: Type.Object({ full_name: Type.String() }, { additionalProperties: false }),
  outputSchema: Type.Object(
    { full_name: Type.String(), forks: Type.Integer(), stars: Type.Integer() },
    { additionalProperties: false },
  ),
});

const searchRepositoriesTool = defineTool({
  id: "github.search_repositories",
  label: "Search repositories",
  inputSchema: Type.Object(
    { query: Type.String(), limit: Type.Optional(Type.Integer()) },
    { additionalProperties: false },
  ),
  outputSchema: Type.Array(Type.Object({ repo_ref: Type.String() }, { additionalProperties: false })),
});

describe("dslSignatureOf — 契约到签名", () => {
  test("透明工具：id / parameters / returns", () => {
    const signature = dslSignatureOf(getRepositoryTool);
    expect(signature.id).toBe("github.get_repository");
    expect(signature.parameters).toEqual([{ name: "full_name", type: { kind: "str" }, required: true }]);
    expect(signature.returns).toEqual({
      kind: "object",
      fields: [
        { name: "full_name", type: { kind: "str" } },
        { name: "forks", type: { kind: "int" } },
        { name: "stars", type: { kind: "int" } },
      ],
    });
  });

  test("可选参数 required=false", () => {
    const signature = dslSignatureOf(searchRepositoriesTool);
    expect(signature.parameters).toEqual([
      { name: "query", type: { kind: "str" }, required: true },
      { name: "limit", type: { kind: "int" }, required: false },
    ]);
  });

  test("数组输出：list 元素为 object", () => {
    const returns = dslSignatureOf(searchRepositoriesTool).returns;
    expect(returns.kind).toBe("list");
    if (returns.kind === "list") {
      expect(returns.items.kind).toBe("object");
    }
  });

  test("union / record / unknown 的 kind 正确", () => {
    expect(dslTypeOf(Type.Union([Type.String(), Type.Number()])).kind).toBe("union");
    expect(dslTypeOf(Type.Record(Type.String(), Type.Number())).kind).toBe("record");
    expect(dslTypeOf(Type.Any()).kind).toBe("unknown");
  });

  test("字段 label 来自 description", () => {
    const tool = defineTool({
      id: "demo.metric",
      label: "Metric",
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ forks: Type.Integer({ description: "forks" }) }, { additionalProperties: false }),
    });
    expect(dslSignatureOf(tool).returns).toEqual({
      kind: "object",
      fields: [{ name: "forks", type: { kind: "int" }, label: "forks" }],
    });
  });
});

describe("renderDslSignature — 紧凑渲染", () => {
  test("透明工具签名精确字符串", () => {
    expect(renderDslSignature(dslSignatureOf(getRepositoryTool))).toBe(
      "github.get_repository(full_name: str) -> {full_name: str, forks: int, stars: int}",
    );
  });

  test("搜索工具签名精确字符串（list 元素对象）", () => {
    expect(renderDslSignature(dslSignatureOf(searchRepositoriesTool))).toBe(
      "github.search_repositories(query: str, limit?: int) -> list<{repo_ref: str}>",
    );
  });

  test("typeStyle=schema 使用 schema 拼写", () => {
    expect(renderDslSignature(dslSignatureOf(getRepositoryTool), { typeStyle: "schema" })).toBe(
      "github.get_repository(full_name: string) -> {full_name: string, forks: integer, stars: integer}",
    );
  });

  test("fieldLabels 渲染 key: type[label]", () => {
    const type: DslType = {
      kind: "object",
      fields: [{ name: "metric_x", type: { kind: "int" }, label: "forks" }],
    };
    expect(renderDslType(type, { fieldLabels: true })).toBe("{metric_x: int[forks]}");
  });

  test("nameTransform 只作用于 id", () => {
    expect(
      renderDslSignature(dslSignatureOf(getRepositoryTool), { nameTransform: (id) => id.replaceAll(".", "_") }),
    ).toBe("github_get_repository(full_name: str) -> {full_name: str, forks: int, stars: int}");
  });

  test("空参数工具渲染为 id()", () => {
    const tool = defineTool({
      id: "demo.ping",
      label: "Ping",
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Boolean(),
    });
    expect(renderDslSignature(dslSignatureOf(tool))).toBe("demo.ping() -> bool");
  });

  test("includeDescription 追加描述注释", () => {
    expect(
      renderDslSignature(dslSignatureOf(getRepositoryTool), { includeDescription: true, description: "获取单个仓库" }),
    ).toBe("github.get_repository(full_name: str) -> {full_name: str, forks: int, stars: int}\n# 获取单个仓库");
  });
});
