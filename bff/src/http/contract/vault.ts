// `GET /api/vault/index`: the folder tree and Markdown files under the vault root folder.
// `PUT /api/vault/root`: pick the account's vault root folder (body decoded by hand).

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { DriveWriteErrors, VaultErrors } from "../errors.ts";
import { NodeSchema } from "./node.ts";

const IndexEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentId: Schema.String,
  modifiedTime: Schema.String,
});

export class VaultGroup extends HttpApiGroup.make("vault")
  .add(
    HttpApiEndpoint.get("index", "/api/vault/index", {
      success: Schema.Struct({
        rootId: Schema.String,
        folders: Schema.Array(IndexEntry),
        files: Schema.Array(IndexEntry),
        truncated: Schema.Boolean,
      }),
      error: VaultErrors,
    }),
  )
  .add(
    HttpApiEndpoint.put("selectRoot", "/api/vault/root", {
      success: Schema.Struct({ root: NodeSchema }),
      error: DriveWriteErrors,
    }),
  ) {}
