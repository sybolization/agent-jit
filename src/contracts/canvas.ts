import { type Static, Type } from "typebox";

const SHORT_TEXT_MAX_LENGTH = 500;

export const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "[^\\s]",
});

export const CanvasMentionSchema = Type.Object({
  type: Type.Union([Type.Literal("asset"), Type.Literal("node")]),
  id: IdentifierSchema,
  kind: Type.Optional(Type.String({ maxLength: 100 })),
  label: Type.Optional(Type.String({ maxLength: SHORT_TEXT_MAX_LENGTH })),
});

export const CanvasPositionSchema = Type.Object({
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
});

export const CanvasNodeSchema = Type.Object({
  id: IdentifierSchema,
  type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  position: Type.Optional(CanvasPositionSchema),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 1_000 })),
});

export const CanvasEdgeSchema = Type.Object({
  id: IdentifierSchema,
  source: IdentifierSchema,
  target: IdentifierSchema,
  sourceHandle: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  targetHandle: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 200 })),
});

export const CanvasGraphSchema = Type.Object({
  nodes: Type.Optional(Type.Array(CanvasNodeSchema, { maxItems: 5_000 })),
  edges: Type.Optional(Type.Array(CanvasEdgeSchema, { maxItems: 10_000 })),
});

export const WorkflowReferenceSchema = Type.Object({
  parameterKey: Type.Optional(IdentifierSchema),
  kind: Type.Optional(Type.String({ maxLength: 100 })),
  required: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String({ maxLength: SHORT_TEXT_MAX_LENGTH })),
  help: Type.Optional(Type.String({ maxLength: 4_000 })),
});

export const WorkflowParameterSchema = Type.Object({
  key: IdentifierSchema,
  label: Type.Optional(Type.String({ maxLength: SHORT_TEXT_MAX_LENGTH })),
  kind: Type.Optional(Type.String({ maxLength: 100 })),
  ui: Type.Optional(Type.String({ maxLength: 100 })),
  required: Type.Optional(Type.Boolean()),
  default: Type.Optional(Type.Unknown()),
  help: Type.Optional(Type.String({ maxLength: 4_000 })),
  options: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 200 })),
});

export const CanvasWorkflowToolSchema = Type.Object({
  id: IdentifierSchema,
  label: Type.Optional(Type.String({ maxLength: SHORT_TEXT_MAX_LENGTH })),
  description: Type.Optional(Type.String({ maxLength: 8_000 })),
  outputKind: Type.Optional(Type.String({ maxLength: 100 })),
  output_kind: Type.Optional(Type.String({ maxLength: 100 })),
  references: Type.Optional(Type.Array(WorkflowReferenceSchema, { maxItems: 100 })),
  parameters: Type.Optional(Type.Array(WorkflowParameterSchema, { maxItems: 500 })),
  defaults: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 500 })),
});

export type CanvasMention = Static<typeof CanvasMentionSchema>;
export type CanvasNode = Static<typeof CanvasNodeSchema>;
export type CanvasEdge = Static<typeof CanvasEdgeSchema>;
export type CanvasGraph = Static<typeof CanvasGraphSchema>;
export type WorkflowReference = Static<typeof WorkflowReferenceSchema>;
export type WorkflowParameter = Static<typeof WorkflowParameterSchema>;
export type CanvasWorkflowTool = Static<typeof CanvasWorkflowToolSchema>;
