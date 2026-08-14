import { describe, expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { compileExecutionDsl, ExecutionDslCompileError } from "../src/compiler/compile.js";
import {
  ExecutionGraphSchema,
  type ExecutionNode,
  type ProjectNode,
} from "../src/compiler/ir.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool, type RegisteredTool, type ToolContract } from "../src/tools/definition.js";
import { execute } from "../src/runtime/runtime.js";

/**
 * 字段投影（变量.字段）与 collect（值包装成数组）测试。
 *
 * 背景：宿主工具（glob / web_search / bash）多返回包装对象，DSL 数据流
 * 操作只消费数组——字段投影解包出数组字段，collect 把多个对象结果包成
 * 数组，二者补齐"宿主工具 → 数据流"的最后一块。
 */

/** 编译期契约 → 可注册工具（execute 桩；运行时测试另行绑定真实实现）。 */
function asRegistered(tool: ToolContract): RegisteredTool {
  return { ...tool, execute: async () => undefined };
}

/** 模拟宿主工具的包装对象输出：{root: string, paths: list<string>}。 */
const WRAPPER_TOOL = asRegistered(
  defineTool({
    id: "host.wrapper",
    label: "Wrapper Host Tool",
    description: "返回包装对象（模拟 glob）",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({
      root: Type.String(),
      paths: Type.Array(Type.String()),
    }),
  }),
);

/** 返回嵌套对象的工具（多级投影用）：{meta: {owner: string, count: int}}。 */
const NESTED_TOOL = asRegistered(
  defineTool({
    id: "host.nested",
    label: "Nested Tool",
    description: "返回嵌套对象（模拟多级投影）",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({
      meta: Type.Object({ owner: Type.String(), count: Type.Integer() }),
    }),
  }),
);

/** 返回数组的工具（与 github_* 同形）：list<{name: string}>。 */
const LIST_TOOL = asRegistered(
  defineTool({
    id: "host.list",
    label: "List Tool",
    description: "返回数组",
    inputSchema: Type.Object({}),
    outputSchema: Type.Array(Type.Object({ name: Type.String() })),
  }),
);

/** 返回标量字段的工具（投影出标量直接 return）。 */
const SCALAR_TOOL = asRegistered(
  defineTool({
    id: "host.scalar",
    label: "Scalar Tool",
    description: "返回含标量字段的对象",
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({ value: Type.Integer() }),
  }),
);

function registryWith(tools: readonly RegisteredTool[] = []): ToolRegistry<RegisteredTool> {
  return new ToolRegistry<RegisteredTool>([WRAPPER_TOOL, ...tools]);
}

function compileOk(source: string, tools: readonly RegisteredTool[] = []) {
  const { graph, diagnostics } = compileExecutionDsl(source, { tools: registryWith(tools) });
  expect(diagnostics).toEqual([]);
  expect(Value.Check(ExecutionGraphSchema, graph)).toBe(true);
  return graph;
}

function collectCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExecutionDslCompileError) return error.diagnostics.map((item) => item.code);
  }
  throw new Error("expected ExecutionDslCompileError");
}

const byId = (nodes: ExecutionNode[]): Map<string, ExecutionNode> => new Map(nodes.map((node) => [node.id, node]));

describe("字段投影（变量.字段）——编译", () => {
  test("files.paths 物化为隐式 ProjectNode（id=$project.files.paths），IR 通过 schema 校验", () => {
    const source = [
      "files = host.wrapper()",
      "top = take(files.paths, 3)",
      "return top",
    ].join("\n");
    const graph = compileOk(source);
    const nodes = byId(graph.nodes);
    expect(nodes.get("$project.files.paths")).toEqual({
      id: "$project.files.paths",
      kind: "project",
      source: "files",
      field: "paths",
    });
    const top = nodes.get("top") as { kind: string; source: string };
    expect(top.kind).toBe("compute");
    expect(top.source).toBe("$project.files.paths");
  });

  test("确定性：同源码两次编译产出相同图（含隐式节点）", () => {
    const source = [
      "files = host.wrapper()",
      "top = take(files.paths, 3)",
      "return top",
    ].join("\n");
    const first = compileOk(source);
    const second = compileOk(source);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("多级 a.b.c 链式物化两个 ProjectNode", () => {
    const source = [
      "x = host.nested()",
      "return x.meta.count",
    ].join("\n");
    const graph = compileOk(source, [NESTED_TOOL]);
    const nodes = byId(graph.nodes);
    expect(nodes.get("$project.x.meta")).toMatchObject({
      kind: "project",
      source: "x",
      field: "meta",
    });
    expect(nodes.get("$project.$project.x.meta.count")).toMatchObject({
      kind: "project",
      source: "$project.x.meta",
      field: "count",
    });
  });

  test("同一路径多处引用只物化一个 ProjectNode（去重）", () => {
    const source = [
      "files = host.wrapper()",
      "a = take(files.paths, 1)",
      "b = take(files.paths, 2)",
      "return a",
    ].join("\n");
    const graph = compileOk(source);
    const projects = graph.nodes.filter((node): node is ProjectNode => node.kind === "project");
    expect(projects).toHaveLength(1);
    const a = byId(graph.nodes).get("a") as { source: string };
    const b = byId(graph.nodes).get("b") as { source: string };
    expect(a.source).toBe("$project.files.paths");
    expect(b.source).toBe("$project.files.paths");
  });

  test("精确变量名优先：含点号的已定义变量名不被拆成投影", () => {
    const source = [
      "files.paths = host.list()",
      "top = take(files.paths, 1)",
      "return top",
    ].join("\n");
    const graph = compileOk(source, [LIST_TOOL]);
    expect(graph.nodes.some((node) => node.kind === "project")).toBe(false);
    const top = byId(graph.nodes).get("top") as { source: string };
    expect(top.source).toBe("files.paths");
  });

  test("投影可用在 return 位置", () => {
    const source = [
      "files = host.wrapper()",
      "return files.paths",
    ].join("\n");
    const graph = compileOk(source);
    const ret = byId(graph.nodes).get("return") as { value: string };
    expect(ret.value).toBe("$project.files.paths");
  });

  test("collect 内也可用投影", () => {
    const source = [
      "files = host.wrapper()",
      "both = collect(files.root, files.paths)",
      "return both",
    ].join("\n");
    const graph = compileOk(source);
    const both = byId(graph.nodes).get("both") as { kind: string; sources: string[] };
    expect(both.kind).toBe("collect");
    expect(both.sources).toEqual(["$project.files.root", "$project.files.paths"]);
  });

  test("基名未定义 → undefined_reference", () => {
    const source = [
      "top = take(nope.paths, 1)",
      "return top",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("undefined_reference");
  });

  test("对象输出缺字段 → UNKNOWN_FIELD（suggestion 列出可用字段）", () => {
    const source = [
      "files = host.wrapper()",
      "top = take(files.nope, 1)",
      "return top",
    ].join("\n");
    try {
      compileOk(source);
      throw new Error("expected ExecutionDslCompileError");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionDslCompileError);
      const { diagnostics } = error as ExecutionDslCompileError;
      expect(diagnostics.map((item) => item.code)).toContain("UNKNOWN_FIELD");
      const suggestion = diagnostics.map((item) => item.suggestion ?? "").join("\n");
      expect(suggestion).toContain("root");
      expect(suggestion).toContain("paths");
    }
  });

  test("数组输出取字段 → invalid_projection（静态诊断）", () => {
    const source = [
      "items = host.list()",
      "top = take(items.name, 1)",
      "return top",
    ].join("\n");
    expect(collectCodes(() => compileOk(source, [LIST_TOOL]))).toContain("invalid_projection");
  });

  test("unknown 输出（工具 schema 未知）不误报，正常编译", () => {
    const untyped = asRegistered({
      id: "host.untyped",
      label: "Untyped",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
    });
    const source = [
      "files = host.untyped()",
      "top = take(files.paths, 3)",
      "return top",
    ].join("\n");
    const { graph, diagnostics } = compileExecutionDsl(source, { tools: new ToolRegistry([untyped]) });
    expect(diagnostics).toEqual([]);
    expect(byId(graph.nodes).get("$project.files.paths")).toBeDefined();
  });

  test("投影字段结果作为 map source：元素 schema 由字段视图推导", () => {
    const objectItems = asRegistered(
      defineTool({
        id: "host.wrapper_obj",
        label: "Wrapper Obj Items",
        inputSchema: Type.Object({}),
        outputSchema: Type.Object({
          items: Type.Array(Type.Object({ name: Type.String() })),
        }),
      }),
    );
    const upper = asRegistered(
      defineTool({
        id: "host.upper",
        label: "Upper Tool",
        inputSchema: Type.Object({ text: Type.String() }),
        outputSchema: Type.Object({ text: Type.String() }),
      }),
    );
    // 正确绑定：_.name 存在于投影结果的元素 schema → 编译通过
    const good = [
      "files = host.wrapper_obj()",
      "upper = map(files.items, host.upper(text=_.name))",
      "return upper",
    ].join("\n");
    expect(compileOk(good, [objectItems, upper]).nodes.length).toBeGreaterThan(0);
    // 错误绑定：_.missing 不在元素 schema → UNKNOWN_FIELD（投影链保持类型信息）
    const bad = [
      "files = host.wrapper_obj()",
      "upper = map(files.items, host.upper(text=_.missing))",
      "return upper",
    ].join("\n");
    expect(collectCodes(() => compileOk(bad, [objectItems, upper]))).toContain("UNKNOWN_FIELD");
  });
});

describe("collect（值包装成数组）——编译", () => {
  test("collect(a, b) 编译为 collect 节点，IR 通过 schema 校验", () => {
    const source = [
      "a = host.wrapper()",
      "b = host.scalar()",
      "both = collect(a, b)",
      "return both",
    ].join("\n");
    const graph = compileOk(source, [SCALAR_TOOL]);
    expect(byId(graph.nodes).get("both")).toEqual({
      id: "both",
      kind: "collect",
      sources: ["a", "b"],
    });
  });

  test("单值包装合法（collect(x) → [x]）", () => {
    const source = [
      "a = host.wrapper()",
      "one = collect(a)",
      "return one",
    ].join("\n");
    const graph = compileOk(source);
    expect(byId(graph.nodes).get("one")).toMatchObject({ kind: "collect", sources: ["a"] });
  });

  test("字面量参数 → invalid_reference", () => {
    const source = [
      "a = host.wrapper()",
      'both = collect(a, "literal")',
      "return both",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("invalid_reference");
  });

  test("命名参数 → unknown_parameter", () => {
    const source = [
      "a = host.wrapper()",
      "both = collect(x=a)",
      "return both",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("unknown_parameter");
  });

  test("未定义引用 → undefined_reference", () => {
    const source = [
      "a = host.wrapper()",
      "both = collect(a, missing)",
      "return both",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("undefined_reference");
  });

  test("collect 结果可接 take（对象数组直接进数据流）", () => {
    const source = [
      "a = host.wrapper()",
      "b = host.scalar()",
      "both = collect(a, b)",
      "top = take(both, 1)",
      "return top",
    ].join("\n");
    const graph = compileOk(source, [SCALAR_TOOL]);
    const top = byId(graph.nodes).get("top") as { source: string };
    expect(top.source).toBe("both");
  });
});

describe("字段投影与 collect——运行时", () => {
  const runtimeTools: readonly RegisteredTool[] = [
    {
      ...WRAPPER_TOOL,
      execute: async () => ({ root: ".", paths: ["a.ts", "b.ts", "c.ts"] }),
    },
    {
      ...NESTED_TOOL,
      execute: async () => ({ meta: { owner: "sybolization", count: 7 } }),
    },
    {
      ...SCALAR_TOOL,
      execute: async () => ({ value: 42 }),
    },
  ];

  async function run(source: string): Promise<unknown> {
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry(runtimeTools) });
    const result = await execute(graph, new ToolRegistry(runtimeTools));
    if (result.status !== "success") throw new Error(`执行失败：${result.error}`);
    return result.result;
  }

  test("project 取数组字段 → take 端到端", async () => {
    const source = [
      "files = host.wrapper()",
      "top = take(files.paths, 2)",
      "return top",
    ].join("\n");
    expect(await run(source)).toEqual(["a.ts", "b.ts"]);
  });

  test("多级投影取标量", async () => {
    const source = [
      "x = host.nested()",
      "return x.meta.count",
    ].join("\n");
    expect(await run(source)).toBe(7);
  });

  test("project source 非对象 → 整体失败（严格语义，schema 未知时运行时兜底）", async () => {
    const untypedArray: RegisteredTool = {
      id: "host.untyped_array",
      label: "Untyped Array",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      execute: async () => [{ name: "x" }],
    };
    const source = [
      "items = host.untyped_array()",
      "return items.name",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry([untypedArray]) });
    const result = await execute(graph, new ToolRegistry([untypedArray]));
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error).toContain("不是对象");
  });

  test("project 字段缺失 → 整体失败并列出可用字段（schema 未知时运行时兜底）", async () => {
    const untyped: RegisteredTool = {
      id: "host.untyped",
      label: "Untyped",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      execute: async () => ({ real_key: 1 }),
    };
    const source = [
      "files = host.untyped()",
      "return files.nope",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry([untyped]) });
    const result = await execute(graph, new ToolRegistry([untyped]));
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error).toContain("缺少字段");
    expect(result.error).toContain("real_key");
  });

  test("collect 顺序保真，对象结果包成数组", async () => {
    const source = [
      "a = host.wrapper()",
      "b = host.scalar()",
      "both = collect(a, b)",
      "return both",
    ].join("\n");
    expect(await run(source)).toEqual([
      { root: ".", paths: ["a.ts", "b.ts", "c.ts"] },
      { value: 42 },
    ]);
  });

  test("trace 记录 collect 节点", async () => {
    const source = [
      "a = host.wrapper()",
      "b = host.scalar()",
      "both = collect(a, b)",
      "return both",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry(runtimeTools) });
    const result = await execute(graph, new ToolRegistry(runtimeTools));
    if (result.status !== "success") throw new Error("expected success");
    expect(result.trace.map((entry) => entry.kind)).toContain("collect");
  });

  test("collect 包装数组保持嵌套（不与 concat 混同）", async () => {
    const listTool: RegisteredTool = {
      ...LIST_TOOL,
      execute: async () => [{ name: "x" }, { name: "y" }],
    };
    const source = [
      "a = host.list()",
      "both = collect(a, a)",
      "return both",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry([listTool]) });
    const result = await execute(graph, new ToolRegistry([listTool]));
    if (result.status !== "success") throw new Error("expected success");
    // 两个数组元素各是一个数组（包装，不是拼接）
    expect(result.result).toEqual([
      [{ name: "x" }, { name: "y" }],
      [{ name: "x" }, { name: "y" }],
    ]);
  });

  test("project 原型链字段不误判：constructor 报缺少字段（hasOwn 语义）", async () => {
    const untyped: RegisteredTool = {
      id: "host.untyped",
      label: "Untyped",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      execute: async () => ({ real_key: 1 }),
    };
    const source = [
      "files = host.untyped()",
      "return files.constructor",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry([untyped]) });
    const result = await execute(graph, new ToolRegistry([untyped]));
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error).toContain("缺少字段");
  });

  test("project source 为 null → 报 null（非 object）", async () => {
    const nullTool: RegisteredTool = {
      id: "host.null",
      label: "Null Tool",
      inputSchema: Type.Object({}),
      outputSchema: Type.Unknown(),
      execute: async () => null,
    };
    const source = [
      "x = host.null()",
      "return x.anything",
    ].join("\n");
    const { graph } = compileExecutionDsl(source, { tools: new ToolRegistry([nullTool]) });
    const result = await execute(graph, new ToolRegistry([nullTool]));
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error).toContain("null");
  });
});

describe("review 补充用例（边界与诊断）", () => {
  test("collect 超过 20 个值 → TOO_MANY_POSITIONAL_ARGS（非 schema_invalid）", () => {
    const many = Array.from({ length: 21 }, (_, i) => `a${i} = host.wrapper()`);
    const source = [
      ...many,
      `both = collect(${Array.from({ length: 21 }, (_, i) => `a${i}`).join(", ")})`,
      "return both",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("TOO_MANY_POSITIONAL_ARGS");
  });

  test("collect() 零参数 → syntax 诊断", () => {
    const source = [
      "both = collect()",
      "return both",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("syntax");
  });

  test("链延续复用中间投影节点（x=a.b 后 y=a.b.c 复用 $project.a.b）", () => {
    const source = [
      "a = host.nested()",
      "x = take(a.meta.count, 1)",
      "y = take(a.meta.owner, 1)",
      "return x",
    ].join("\n");
    const graph = compileOk(source, [NESTED_TOOL]);
    const projects = graph.nodes.filter((node): node is ProjectNode => node.kind === "project");
    // $project.a.meta 只物化一次；两个更深投影复用它
    expect(projects).toHaveLength(3);
    expect(graph.nodes.some((node) => node.id === "$project.a.meta")).toBe(true);
    const owner = byId(graph.nodes).get("$project.$project.a.meta.owner");
    expect(owner).toMatchObject({ source: "$project.a.meta", field: "owner" });
  });

  test("深层投影超过 id 上限 → invalid_projection（带行号，非 schema_invalid）", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `f${i}`).join(".");
    const source = [
      "a = host.nested()",
      `deep = take(a.meta.${deep}, 1)`,
      "return deep",
    ].join("\n");
    expect(collectCodes(() => compileOk(source, [NESTED_TOOL]))).toContain("invalid_projection");
  });

  test("空字段段（a.）→ invalid_projection", () => {
    const source = [
      "files = host.wrapper()",
      "top = take(files., 1)",
      "return top",
    ].join("\n");
    expect(collectCodes(() => compileOk(source))).toContain("invalid_projection");
  });

  test("标量输出取字段 → invalid_projection（静态诊断，不再静默）", () => {
    const scalarOut = asRegistered(
      defineTool({
        id: "host.plain_string",
        label: "Plain String",
        inputSchema: Type.Object({}),
        outputSchema: Type.String(),
      }),
    );
    const source = [
      "x = host.plain_string()",
      "return x.length",
    ].join("\n");
    expect(collectCodes(() => compileOk(source, [scalarOut]))).toContain("invalid_projection");
  });

  test("map 绑定字段含点号 → MAP_BINDING_REF_INVALID（多级绑定显式拒绝）", () => {
    const upper = asRegistered(
      defineTool({
        id: "host.upper",
        label: "Upper Tool",
        inputSchema: Type.Object({ text: Type.String() }),
        outputSchema: Type.Object({ text: Type.String() }),
      }),
    );
    const source = [
      "items = host.list()",
      "x = map(items, host.upper(text=_.name.x))",
      "return x",
    ].join("\n");
    expect(collectCodes(() => compileOk(source, [LIST_TOOL, upper]))).toContain("MAP_BINDING_REF_INVALID");
  });

  test("投影后点号变量名重定义：精确名优先，同文本两种含义共存（行为 pin）", () => {
    const source = [
      "a = host.wrapper()",
      "x = take(a.paths, 1)",
      "a.paths = host.list()",
      "y = take(a.paths, 1)",
      "return y",
    ].join("\n");
    const graph = compileOk(source, [LIST_TOOL]);
    // x 引用投影节点；y 引用点号变量本身（精确名优先）
    const x = byId(graph.nodes).get("x") as { source: string };
    const y = byId(graph.nodes).get("y") as { source: string };
    expect(x.source).toBe("$project.a.paths");
    expect(y.source).toBe("a.paths");
  });
});
