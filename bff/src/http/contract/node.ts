import * as Schema from "effect/Schema";

/** What the web app sees of a Drive file or folder (`domain/drive.ts` `Node`), in wire key order. */
export const NodeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["folder", "markdown", "other"]),
  modifiedTime: Schema.String,
});

export const Nodes = Schema.Struct({ nodes: Schema.Array(NodeSchema) });

/** The `{id}` path parameter. Handlers validate the raw (still percent-encoded) id, see `rawPathId`. */
export const IdParams = { id: Schema.String };
