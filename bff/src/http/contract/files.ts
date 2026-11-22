// `PATCH` and `DELETE /api/files/{id}`. Owned by the files phase-2 work. The two content routes
// stream raw bytes and live in `routes/file-content.ts`.

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import { DriveErrors, DriveWriteErrors } from "../errors.ts";
import { IdParams, NodeSchema } from "./node.ts";

export class FilesGroup extends HttpApiGroup.make("files")
  .add(
    HttpApiEndpoint.patch("updateFile", "/api/files/:id", {
      params: IdParams,
      success: NodeSchema,
      error: DriveWriteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteFile", "/api/files/:id", {
      params: IdParams,
      error: DriveErrors,
    }),
  ) {}
