// The Drive folder picker: `GET /api/drive/folders?parentId=` lists the subfolders of any folder
// of the account's Drive (My Drive by default) and `POST /api/drive/folders` creates one (body
// decoded by hand, so a bad body is 400 `invalid_request`).

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";

import { DriveErrors, DriveWriteErrors } from "../errors.ts";
import { NodeSchema } from "./node.ts";

export const FolderListingSchema = Schema.Struct({
  parent: Schema.Struct({ id: Schema.String, name: Schema.String }),
  folders: Schema.Array(NodeSchema),
});

export class DriveGroup extends HttpApiGroup.make("drive")
  .add(
    HttpApiEndpoint.get("listFolders", "/api/drive/folders", {
      success: FolderListingSchema,
      error: DriveErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createFolder", "/api/drive/folders", {
      success: NodeSchema.pipe(HttpApiSchema.status(201)),
      error: DriveWriteErrors,
    }),
  ) {}
