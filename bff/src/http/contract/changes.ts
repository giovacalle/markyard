// `GET /api/changes/start-token` and `GET /api/changes?pageToken=`. `pageToken` is read from the
// raw URL by the handler, so a missing or odd token earns the BFF's own 400 `invalid_request`.

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { DriveErrors, InvalidRequest400, TokenExpired410 } from "../errors.ts";
import { NodeSchema } from "./node.ts";

export const ChangeSchema = Schema.Struct({
  fileId: Schema.String,
  removed: Schema.Boolean,
  time: Schema.String,
  /** Omitted for a removed or trashed item. */
  node: Schema.optionalKey(NodeSchema),
  parentIds: Schema.Array(Schema.String),
});

export class ChangesGroup extends HttpApiGroup.make("changes")
  .add(
    HttpApiEndpoint.get("startToken", "/api/changes/start-token", {
      success: Schema.Struct({ startPageToken: Schema.String }),
      error: DriveErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("changes", "/api/changes", {
      success: Schema.Struct({
        nextPageToken: Schema.String,
        hasMore: Schema.Boolean,
        changes: Schema.Array(ChangeSchema),
      }),
      error: [...DriveErrors, InvalidRequest400, TokenExpired410],
    }),
  ) {}
