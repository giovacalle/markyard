// `GET /api/files/{id}/revisions`: a file's Drive version history, newest first. The bytes of
// one revision stream through the plain router (`routes/revision-content.ts`).

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { DriveErrors } from "../errors.ts";
import { IdParams } from "./node.ts";

/** `domain/revisions.ts` `Revision`, in wire key order; `size` and `author` may be absent. */
export const RevisionSchema = Schema.Struct({
  id: Schema.String,
  modifiedTime: Schema.String,
  size: Schema.optionalKey(Schema.Number),
  author: Schema.optionalKey(Schema.String),
  keepForever: Schema.Boolean,
});

export class RevisionsGroup extends HttpApiGroup.make("revisions").add(
  HttpApiEndpoint.get("listRevisions", "/api/files/:id/revisions", {
    params: IdParams,
    success: Schema.Struct({ revisions: Schema.Array(RevisionSchema) }),
    error: DriveErrors,
  }),
) {}
