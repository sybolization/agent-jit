import { describe, expect, test } from "vitest";

import { compileExecutionDslLegacy } from "../src/experiments/languageVariants/legacyCompile.js";
import { ExecutionDslCompileError } from "../src/compiler/compile.js";
import type { ExecutionNode } from "../src/compiler/ir.js";
import { githubTools } from "../src/compiler/registry.js";
import { mockDomainToolSpecs } from "../src/runtime/mockTools.js";
import { tokenize } from "../src/language/tokenizer.js";
import { Parser } from "../src/language/parser.js";

const REPOS = 'repos = github.search_repositories(query="x", limit=10)';

function collectCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExecutionDslCompileError) return error.diagnostics.map((item) => item.code);
  }
  throw new Error("expected ExecutionDslCompileError");
}

const byId = (nodes: ExecutionNode[]): Map<string, ExecutionNode> => new Map(nodes.map((node) => [node.id, node]));

describe("R3 parser — call / lambda 表达式", () => {
  test("嵌套调用表达式解析（B 臂）", () => {
    const { tokens } = tokenize('details = map(repos, github.get_repository(full_name=_.full_name))');
    const result = new Parser(tokens).parse();
    expect(result.diagnostics).toEqual([]);
    const arg = result.statements[0]?.args[1]?.value;
    expect(arg?.kind).toBe("call");
    expect(arg?.callee).toBe("github.get_repository");
    expect(arg?.args?.[0]).toMatchObject({ key: "full_name" });
    expect(arg?.args?.[0]?.value).toMatchObject({ kind: "ref", name: "_.full_name" });
  });

  test("lambda 表达式解析（C 臂）", () => {
    const { tokens } = tokenize('details = map(repos, lambda repo: github.get_repository(full_name=repo.full_name))');
    const result = new Parser(tokens).parse();
    expect(result.diagnostics).toEqual([]);
    const arg = result.statements[0]?.args[1]?.value;
    expect(arg?.kind).toBe("lambda");
    expect(arg?.param).toBe("repo");
    expect(arg?.body?.kind).toBe("call");
    expect(arg?.body?.callee).toBe("github.get_repository");
    expect(arg?.body?.args?.[0]?.value).toMatchObject({ kind: "ref", name: "repo.full_name" });
  });

  test("多字段绑定解析", () => {
    const { tokens } = tokenize('m = map(users, email.prepare(to=_.email, name=_.name))');
    const result = new Parser(tokens).parse();
    expect(result.diagnostics).toEqual([]);
    const args = result.statements[0]?.args[1]?.value;
    expect(args?.kind).toBe("call");
    expect(args?.args?.length).toBe(2);
  });
});

describe("R3 compiler — 三臂同一语义产出相同 IR", () => {
  const DSL_A = [REPOS, 'details = map(repos, "github.get_repository", key="full_name")', "return details"].join("\n");
  const DSL_B = [REPOS, "details = map(repos, github.get_repository(full_name=_.full_name))", "return details"].join("\n");
  const DSL_C = [
    REPOS,
    "details = map(repos, lambda repo: github.get_repository(full_name=repo.full_name))",
    "return details",
  ].join("\n");

  const expectedMap = {
    id: "details",
    kind: "map",
    source: "repos",
    tool: "github.get_repository",
    bindings: { full_name: "full_name" },
    concurrency: 5,
  };

  test("A 臂 key= 编译成 bindings IR", () => {
    const { graph, diagnostics } = compileExecutionDslLegacy(DSL_A, { tools: githubTools});
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("details")).toEqual(expectedMap);
  });

  test("B 臂 call 表达式编译成相同 bindings IR", () => {
    const { graph, diagnostics } = compileExecutionDslLegacy(DSL_B, { tools: githubTools, allowMapBinding: "call" });
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("details")).toEqual(expectedMap);
  });

  test("C 臂 lambda 编译成相同 bindings IR", () => {
    const { graph, diagnostics } = compileExecutionDslLegacy(DSL_C, { tools: githubTools, allowMapBinding: "lambda" });
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("details")).toEqual(expectedMap);
  });
});

describe("R3 compiler — 形态探针与诊断码", () => {
  test("默认（key 臂）写 call 表达式 → MAP_BINDING_CALL_NOT_ALLOWED", () => {
    const dsl = [REPOS, "details = map(repos, github.get_repository(full_name=_.full_name))", "return details"].join("\n");
    const codes = collectCodes(() => compileExecutionDslLegacy(dsl, { tools: githubTools}));
    expect(codes).toContain("MAP_BINDING_CALL_NOT_ALLOWED");
  });

  test("key 臂写 lambda → MAP_BINDING_LAMBDA_NOT_ALLOWED", () => {
    const dsl = [REPOS, "details = map(repos, lambda repo: github.get_repository(full_name=repo.full_name))", "return details"].join("\n");
    const codes = collectCodes(() => compileExecutionDslLegacy(dsl, { tools: githubTools}));
    expect(codes).toContain("MAP_BINDING_LAMBDA_NOT_ALLOWED");
  });

  test("call 臂写 key= 元数据 → MAP_BINDING_EXPECTED_CALL", () => {
    const dsl = [REPOS, 'details = map(repos, "github.get_repository", key="full_name")', "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "call" }),
    );
    expect(codes).toContain("MAP_BINDING_EXPECTED_CALL");
  });

  test("call 臂写 lambda → MAP_BINDING_LAMBDA_NOT_ALLOWED", () => {
    const dsl = [REPOS, "details = map(repos, lambda repo: github.get_repository(full_name=repo.full_name))", "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "call" }),
    );
    expect(codes).toContain("MAP_BINDING_LAMBDA_NOT_ALLOWED");
  });

  test("call 臂混用 key= 命名参数 → MAP_BINDING_KEY_NOT_ALLOWED", () => {
    const dsl = [REPOS, 'details = map(repos, github.get_repository(full_name=_.full_name), key="full_name")', "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "call" }),
    );
    expect(codes).toContain("MAP_BINDING_KEY_NOT_ALLOWED");
  });
});

describe("R3 compiler — 多字段 / 异名绑定", () => {
  test("call 臂多字段绑定（to/name）", () => {
    const dsl = [
      "users = users.list_users()",
      "m = map(users, email.prepare(to=_.email, name=_.name))",
      "return m",
    ].join("\n");
    const { graph, diagnostics } = compileExecutionDslLegacy(dsl, { tools: mockDomainToolSpecs, allowMapBinding: "call" });
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("m")).toMatchObject({
      kind: "map",
      tool: "email.prepare",
      bindings: { to: "email", name: "name" },
    });
  });

  test("call 臂异名绑定（id → customer_id）", () => {
    const dsl = ["cs = crm.search_customers(limit=10)", "m = map(cs, crm.get_customer(customer_id=_.id))", "return m"].join("\n");
    const { graph, diagnostics } = compileExecutionDslLegacy(dsl, { tools: mockDomainToolSpecs, allowMapBinding: "call" });
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("m")).toMatchObject({
      kind: "map",
      tool: "crm.get_customer",
      bindings: { customer_id: "id" },
    });
  });

  test("lambda 臂多字段绑定", () => {
    const dsl = ["users = users.list_users()", "m = map(users, lambda u: email.prepare(to=u.email, name=u.name))", "return m"].join("\n");
    const { graph, diagnostics } = compileExecutionDslLegacy(dsl, { tools: mockDomainToolSpecs, allowMapBinding: "lambda" });
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("m")).toMatchObject({ bindings: { to: "email", name: "name" } });
  });
});

describe("R3 compiler — binding 内部校验", () => {
  test("call 内引用未注册工具 → unknown_tool", () => {
    const dsl = [REPOS, "details = map(repos, github.nope(full_name=_.full_name))", "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "call" }),
    );
    expect(codes).toContain("unknown_tool");
  });

  test("call 内参数幻觉 → unknown_parameter", () => {
    const dsl = [REPOS, "details = map(repos, github.get_repository(bogus=_.full_name))", "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "call" }),
    );
    expect(codes).toContain("unknown_parameter");
  });

  test("call 内绑定引用不是 _. 前缀 → MAP_BINDING_REF_INVALID", () => {
    const dsl = [REPOS, "details = map(repos, github.get_repository(full_name=repo))", "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "call" }),
    );
    expect(codes).toContain("MAP_BINDING_REF_INVALID");
  });

  test("lambda 体不是调用 → syntax", () => {
    const dsl = [REPOS, "details = map(repos, lambda repo: 42)", "return details"].join("\n");
    const codes = collectCodes(() =>
      compileExecutionDslLegacy(dsl, { tools: githubTools, allowMapBinding: "lambda" }),
    );
    expect(codes).toContain("syntax");
  });
});
