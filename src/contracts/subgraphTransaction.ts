import { type Static, Type } from "typebox";
import {
  SemanticCanvasFieldKeySchema,
  SemanticCanvasGraphV1Schema,
  SemanticCanvasIdentifierSchema,
  SemanticCanvasInputSchema,
  SemanticCanvasJsonValueSchema,
  SemanticCanvasNodeKindSchema,
  SemanticCanvasNodeV1Schema,
  SemanticCanvasReadinessSchema,
} from "./semanticCanvas.js";

export const SemanticCanvasNodeDraftSchema = Type.Object(
  {
    id: SemanticCanvasIdentifierSchema,
    kind: SemanticCanvasNodeKindSchema,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    inputs: Type.Record(SemanticCanvasFieldKeySchema, SemanticCanvasInputSchema, {
      additionalProperties: false,
      maxProperties: 500,
    }),
    config: Type.Record(SemanticCanvasFieldKeySchema, SemanticCanvasJsonValueSchema, {
      additionalProperties: false,
      maxProperties: 500,
    }),
    workflow_id: Type.Optional(SemanticCanvasIdentifierSchema),
  },
  { additionalProperties: false },
);

export const SemanticConfigFieldPatchSchema = Type.Object(
  {
    set: Type.Optional(
      Type.Record(SemanticCanvasFieldKeySchema, SemanticCanvasJsonValueSchema, {
        additionalProperties: false,
        maxProperties: 500,
      }),
    ),
    remove: Type.Optional(Type.Array(SemanticCanvasFieldKeySchema, { maxItems: 500, uniqueItems: true })),
  },
  { additionalProperties: false },
);

export const SemanticInputFieldPatchSchema = Type.Object(
  {
    set: Type.Optional(
      Type.Record(SemanticCanvasFieldKeySchema, SemanticCanvasInputSchema, {
        additionalProperties: false,
        maxProperties: 500,
      }),
    ),
    remove: Type.Optional(Type.Array(SemanticCanvasFieldKeySchema, { maxItems: 500, uniqueItems: true })),
  },
  { additionalProperties: false },
);

export const AddSemanticNodeOperationSchema = Type.Object(
  { op: Type.Literal("add"), node: SemanticCanvasNodeDraftSchema },
  { additionalProperties: false },
);

export const ReplaceSemanticNodeOperationSchema = Type.Object(
  {
    op: Type.Literal("replace"),
    node_id: SemanticCanvasIdentifierSchema,
    node: SemanticCanvasNodeDraftSchema,
  },
  { additionalProperties: false },
);

export const UpdateSemanticNodeOperationSchema = Type.Object(
  {
    op: Type.Literal("update"),
    node_id: SemanticCanvasIdentifierSchema,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    config_patch: Type.Optional(SemanticConfigFieldPatchSchema),
    inputs_patch: Type.Optional(SemanticInputFieldPatchSchema),
  },
  { additionalProperties: false },
);

export const DeleteSemanticNodeOperationSchema = Type.Object(
  { op: Type.Literal("delete"), node_id: SemanticCanvasIdentifierSchema },
  { additionalProperties: false },
);

export const SubgraphNodeOperationSchema = Type.Union([
  AddSemanticNodeOperationSchema,
  ReplaceSemanticNodeOperationSchema,
  UpdateSemanticNodeOperationSchema,
  DeleteSemanticNodeOperationSchema,
]);

/** A semantic dependency crossing the declared subgraph boundary. */
export const SubgraphBoundaryBindingSchema = Type.Object(
  {
    consumer_node_id: SemanticCanvasIdentifierSchema,
    input: SemanticCanvasFieldKeySchema,
    source_node_id: SemanticCanvasIdentifierSchema,
    output: SemanticCanvasIdentifierSchema,
  },
  { additionalProperties: false },
);

export const SubgraphTransactionScopeSchema = Type.Object(
  {
    read_nodes: Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 5_000, uniqueItems: true }),
    write_nodes: Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 5_000, uniqueItems: true }),
    external_inputs: Type.Array(SubgraphBoundaryBindingSchema, { maxItems: 10_000 }),
    downstream_consumers: Type.Array(SubgraphBoundaryBindingSchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
);

export const SubgraphTransactionV1Schema = Type.Object(
  {
    schema_version: Type.Literal("1"),
    request_key: SemanticCanvasIdentifierSchema,
    base_canvas_version: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    scope: SubgraphTransactionScopeSchema,
    operations: Type.Array(SubgraphNodeOperationSchema, { minItems: 1, maxItems: 5_000 }),
  },
  { additionalProperties: false },
);

export const SubgraphUpdatedNodeDiffSchema = Type.Object(
  {
    node_id: SemanticCanvasIdentifierSchema,
    changed_fields: Type.Array(SemanticCanvasFieldKeySchema, { maxItems: 20, uniqueItems: true }),
    node: SemanticCanvasNodeV1Schema,
  },
  { additionalProperties: false },
);

export const SubgraphNormalizedDiffSchema = Type.Object(
  {
    added_nodes: Type.Array(SemanticCanvasNodeV1Schema, { maxItems: 5_000 }),
    updated_nodes: Type.Array(SubgraphUpdatedNodeDiffSchema, { maxItems: 5_000 }),
    removed_node_ids: Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 5_000 }),
  },
  { additionalProperties: false },
);

export const SubgraphNodeReadinessResultSchema = Type.Object(
  {
    node_id: SemanticCanvasIdentifierSchema,
    readiness: SemanticCanvasReadinessSchema,
  },
  { additionalProperties: false },
);

export const SubgraphTransactionSuccessSchema = Type.Object(
  {
    ok: Type.Literal(true),
    schema_version: Type.Literal("1"),
    request_key: SemanticCanvasIdentifierSchema,
    request_hash: Type.String({ minLength: 64, maxLength: 64 }),
    new_canvas_version: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    graph: SemanticCanvasGraphV1Schema,
    diff: SubgraphNormalizedDiffSchema,
    affected_nodes: Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 5_000, uniqueItems: true }),
    node_readiness: Type.Array(SubgraphNodeReadinessResultSchema, { maxItems: 5_000 }),
  },
  { additionalProperties: false },
);

export const SubgraphTransactionErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 100 }),
    message: Type.String({ minLength: 1, maxLength: 4_000 }),
    path: Type.Optional(Type.String({ maxLength: 1_000 })),
    node_id: Type.Optional(SemanticCanvasIdentifierSchema),
    input: Type.Optional(SemanticCanvasFieldKeySchema),
    field: Type.Optional(SemanticCanvasFieldKeySchema),
    expected_type: Type.Optional(Type.String({ maxLength: 200 })),
    actual_type: Type.Optional(Type.String({ maxLength: 200 })),
    conflict_version: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
    consumer_node_ids: Type.Optional(
      Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 5_000, uniqueItems: true }),
    ),
    cycle: Type.Optional(Type.Array(SemanticCanvasIdentifierSchema, { maxItems: 5_000 })),
  },
  { additionalProperties: false },
);

export const SubgraphTransactionFailureSchema = Type.Object(
  {
    ok: Type.Literal(false),
    schema_version: Type.Literal("1"),
    request_key: Type.Union([SemanticCanvasIdentifierSchema, Type.Null()]),
    request_hash: Type.Union([Type.String({ minLength: 64, maxLength: 64 }), Type.Null()]),
    error: SubgraphTransactionErrorSchema,
  },
  { additionalProperties: false },
);

export const SubgraphTransactionResultSchema = Type.Union([
  SubgraphTransactionSuccessSchema,
  SubgraphTransactionFailureSchema,
]);

export type SemanticCanvasNodeDraft = Static<typeof SemanticCanvasNodeDraftSchema>;
export type SemanticConfigFieldPatch = Static<typeof SemanticConfigFieldPatchSchema>;
export type SemanticInputFieldPatch = Static<typeof SemanticInputFieldPatchSchema>;
export type SubgraphNodeOperation = Static<typeof SubgraphNodeOperationSchema>;
export type SubgraphBoundaryBinding = Static<typeof SubgraphBoundaryBindingSchema>;
export type SubgraphTransactionScope = Static<typeof SubgraphTransactionScopeSchema>;
export type SubgraphTransactionV1 = Static<typeof SubgraphTransactionV1Schema>;
export type SubgraphNormalizedDiff = Static<typeof SubgraphNormalizedDiffSchema>;
export type SubgraphTransactionSuccess = Static<typeof SubgraphTransactionSuccessSchema>;
export type SubgraphTransactionError = Static<typeof SubgraphTransactionErrorSchema>;
export type SubgraphTransactionFailure = Static<typeof SubgraphTransactionFailureSchema>;
export type SubgraphTransactionResult = Static<typeof SubgraphTransactionResultSchema>;
