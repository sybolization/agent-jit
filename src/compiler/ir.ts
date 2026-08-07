import { type Static, Type } from "typebox";

/**
 * 通用 ExecutionIR：DSL 编译目标（运行时调度图）。
 *
 * 与画布语义图的区别：这是"LLM 不该直接书写、但必须确定性产出"的
 * 执行物——`tool`（外部 API）、`map`（动态展开）、`compute`（确定性
 * 程序）、`return`（出口）。变量引用定义数据流边。
 *
 * 第一版只覆盖四行示例所需的节点类型；`compute.op` 预留
 * take/filter/sort，但编译器当前只接 take。
 */

export const ExecutionLiteralSchema = Type.Cyclic(
  {
    ExecutionLiteral: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("ExecutionLiteral")),
    ]),
  },
  "ExecutionLiteral",
);

export const ValueExprSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("literal"), value: ExecutionLiteralSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("ref"), name: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  ),
]);

export const ToolNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("tool"),
    tool: Type.String({ minLength: 1, maxLength: 200 }),
    args: Type.Record(Type.String(), ValueExprSchema, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const MapNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("map"),
    source: Type.String({ minLength: 1, maxLength: 200 }),
    tool: Type.String({ minLength: 1, maxLength: 200 }),
    /** element→argument 绑定：工具参数名 → 元素字段路径（如 { full_name: "full_name" }） */
    bindings: Type.Record(Type.String(), Type.String(), { additionalProperties: false }),
    concurrency: Type.Number(),
  },
  { additionalProperties: false },
);

export const ComputeNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("compute"),
    op: Type.Union([
      Type.Literal("take"),
      Type.Literal("filter"),
      Type.Literal("sort"),
      Type.Literal("compute"),
      Type.Literal("select"),
    ]),
    source: Type.String({ minLength: 1, maxLength: 200 }),
    args: Type.Record(Type.String(), ExecutionLiteralSchema, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

/** R4e join：多输入按 key 合并字段。sources[0] 为基准，其余按 key 匹配后附加字段（基准已有字段不覆盖）。 */
export const JoinNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("join"),
    sources: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 20 }),
    key: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const ReturnNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("return"),
    value: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const ExecutionNodeSchema = Type.Union([
  ToolNodeSchema,
  MapNodeSchema,
  ComputeNodeSchema,
  JoinNodeSchema,
  ReturnNodeSchema,
]);

export const ExecutionGraphSchema = Type.Object(
  {
    schema_version: Type.Literal("1"),
    nodes: Type.Array(ExecutionNodeSchema, { maxItems: 5_000 }),
  },
  { additionalProperties: false },
);

export type ExecutionLiteral = Static<typeof ExecutionLiteralSchema>;
export type ValueExpr = Static<typeof ValueExprSchema>;
export type ToolNode = Static<typeof ToolNodeSchema>;
export type MapNode = Static<typeof MapNodeSchema>;
export type ComputeNode = Static<typeof ComputeNodeSchema>;
export type JoinNode = Static<typeof JoinNodeSchema>;
export type ReturnNode = Static<typeof ReturnNodeSchema>;
export type ExecutionNode = Static<typeof ExecutionNodeSchema>;
export type ExecutionGraph = Static<typeof ExecutionGraphSchema>;
