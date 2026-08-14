import { type Static, Type } from "typebox";

/**
 * 通用 ExecutionIR：DSL 编译目标（运行时调度图）。
 *
 * 与画布语义图的区别：这是"LLM 不该直接书写、但必须确定性产出"的
 * 执行物——`tool`（外部 API）、`map`（动态展开）、`compute`（确定性
 * 程序）、`return`（出口）。变量引用定义数据流边。
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
    /** R4e：编译期解析好的表达式 AST（op==="compute" 时是 输出字段→AST；op==="select" 时是 { pred: AST }）；args 中保留源码字符串供诊断/图语义检查 */
    expr: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

/**
 * 按 key 合并字段（canonical 关键字 merge_by_key；join 为遗留别名，编译产物同一节点）。
 * sources[0] 为基准，其余按 key 匹配后附加字段（基准已有字段不覆盖）——语义是
 * "给每条基准记录附加另一批数据的字段"，不是对称合并。
 */
export const JoinNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("join"),
    sources: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 20 }),
    key: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

/** concat：真正的列表拼接——按顺序把多个数组拼成一个大数组，元素原样保留，不做任何字段合并。 */
export const ConcatNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("concat"),
    sources: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 20 }),
  },
  { additionalProperties: false },
);

/**
 * project（字段投影）：从对象型变量取一个字段（`变量.字段` 引用，
 * 多级 `a.b.c` 由编译器链式物化）。编译期对已知对象输出做静态字段校验，
 * 运行时兜底（非对象 / 字段缺失 → 整体失败）。
 */
export const ProjectNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("project"),
    source: Type.String({ minLength: 1, maxLength: 200 }),
    field: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

/**
 * collect：把任意值（对象 / 数组 / 标量）按顺序包成一个新数组——
 * 与 concat 的分工：concat 拼数组，collect 把非数组值包成数组。
 */
export const CollectNodeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Literal("collect"),
    sources: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20 }),
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
  ConcatNodeSchema,
  ProjectNodeSchema,
  CollectNodeSchema,
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
export type ConcatNode = Static<typeof ConcatNodeSchema>;
export type ProjectNode = Static<typeof ProjectNodeSchema>;
export type CollectNode = Static<typeof CollectNodeSchema>;
export type ReturnNode = Static<typeof ReturnNodeSchema>;
export type ExecutionNode = Static<typeof ExecutionNodeSchema>;
export type ExecutionGraph = Static<typeof ExecutionGraphSchema>;
