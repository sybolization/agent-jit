import { type Static, Type } from "typebox";

export const SemanticCanvasIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\s]+$",
});

// These names belong to the React Flow/ComfyUI compatibility layer. They are
// deliberately unavailable as semantic field names, including in nested JSON
// values, so a raw canvas payload cannot smuggle implementation details into
// the Agent protocol.
const SemanticFieldPattern =
  "^(?!.*(?:^|[_-])(?:position|Position|viewport|Viewport|edge|Edge|edges|Edges|handle|Handle|handles|Handles|sourceHandle|SourceHandle|source[_-]handle|Source[_-]handle|targetHandle|TargetHandle|target[_-]handle|Target[_-]handle|link|Link|links|Links|comfy[_-]?ui|Comfy[_-]?UI|class[_-]?type|Class[_-]?Type|widgets?[_-]?values|Widgets?[_-]?Values|workflow[_-]?json|Workflow[_-]?Json)(?:$|[_-])).+$";

export const SemanticCanvasFieldKeySchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: SemanticFieldPattern,
});

// Cyclic keeps arbitrary JSON values typed and checked without using Unknown.
// The closed record also applies SemanticFieldKeySchema recursively.
export const SemanticCanvasJsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue"), { maxItems: 1_000 }),
      Type.Record(SemanticCanvasFieldKeySchema, Type.Ref("JsonValue"), {
        additionalProperties: false,
        maxProperties: 1_000,
      }),
    ]),
  },
  "JsonValue",
);

export const SemanticCanvasNodeKindSchema = Type.String({ minLength: 1, maxLength: 100, pattern: "^[^\\s]+$" });

export const LiteralInputBindingSchema = Type.Object(
  { kind: Type.Literal("literal"), value: SemanticCanvasJsonValueSchema },
  { additionalProperties: false },
);

export const NodeOutputInputBindingSchema = Type.Object(
  {
    kind: Type.Literal("node_output"),
    node_id: SemanticCanvasIdentifierSchema,
    output: SemanticCanvasIdentifierSchema,
  },
  { additionalProperties: false },
);

export const InputBindingSchema = Type.Union([LiteralInputBindingSchema, NodeOutputInputBindingSchema]);

/** A single binding, or an ordered array for a multi-value input. */
export const SemanticCanvasInputSchema = Type.Union([
  InputBindingSchema,
  Type.Array(InputBindingSchema, { minItems: 1, maxItems: 100 }),
]);

export const SemanticCanvasInputPortSchema = Type.Object(
  {
    name: SemanticCanvasIdentifierSchema,
    type: SemanticCanvasIdentifierSchema,
    cardinality: Type.Union([Type.Literal("single"), Type.Literal("multi")]),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SemanticCanvasOutputSchema = Type.Object(
  { name: SemanticCanvasIdentifierSchema, type: SemanticCanvasIdentifierSchema },
  { additionalProperties: false },
);

export const SemanticCanvasReadinessSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
    missing_inputs: Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 500 }),
    invalid_inputs: Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);

export const SemanticCanvasNodeV1Schema = Type.Object(
  {
    id: SemanticCanvasIdentifierSchema,
    kind: SemanticCanvasNodeKindSchema,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    inputs: Type.Record(SemanticCanvasFieldKeySchema, SemanticCanvasInputSchema, {
      additionalProperties: false,
      maxProperties: 500,
    }),
    input_ports: Type.Array(SemanticCanvasInputPortSchema, { maxItems: 500 }),
    config: Type.Record(SemanticCanvasFieldKeySchema, SemanticCanvasJsonValueSchema, {
      additionalProperties: false,
      maxProperties: 500,
    }),
    workflow_id: Type.Optional(SemanticCanvasIdentifierSchema),
    outputs: Type.Array(SemanticCanvasOutputSchema, { maxItems: 100 }),
    readiness: SemanticCanvasReadinessSchema,
  },
  { additionalProperties: false },
);

export const SemanticCanvasGraphV1Schema = Type.Object(
  {
    schema_version: Type.Literal("1"),
    canvas_version: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    nodes: Type.Array(SemanticCanvasNodeV1Schema, { maxItems: 5_000 }),
  },
  { additionalProperties: false },
);

export type SemanticCanvasJsonValue =
  | null
  | boolean
  | number
  | string
  | SemanticCanvasJsonValue[]
  | { [key: string]: SemanticCanvasJsonValue };
export type SemanticCanvasNodeKind = Static<typeof SemanticCanvasNodeKindSchema>;
export type LiteralInputBinding = Static<typeof LiteralInputBindingSchema>;
export type NodeOutputInputBinding = Static<typeof NodeOutputInputBindingSchema>;
export type SemanticCanvasBinding = Static<typeof InputBindingSchema>;
export type SemanticCanvasInput = Static<typeof SemanticCanvasInputSchema>;
export type SemanticCanvasInputPort = Static<typeof SemanticCanvasInputPortSchema>;
export type SemanticCanvasOutput = Static<typeof SemanticCanvasOutputSchema>;
export type SemanticCanvasReadiness = Static<typeof SemanticCanvasReadinessSchema>;
export type SemanticCanvasNodeV1 = Static<typeof SemanticCanvasNodeV1Schema>;
export type SemanticCanvasGraphV1 = Static<typeof SemanticCanvasGraphV1Schema>;

// Stable descriptive aliases for callers that prefer the long names.
export type SemanticCanvasLiteralBinding = LiteralInputBinding;
export type SemanticCanvasNodeOutputBinding = NodeOutputInputBinding;
export type SemanticCanvasNode = SemanticCanvasNodeV1;
export const SemanticCanvasLiteralBindingSchema = LiteralInputBindingSchema;
export const SemanticCanvasNodeOutputBindingSchema = NodeOutputInputBindingSchema;
export const SemanticCanvasInputBindingSchema = InputBindingSchema;
export const SemanticCanvasBindingSchema = InputBindingSchema;
export const SemanticCanvasNodeSchema = SemanticCanvasNodeV1Schema;
