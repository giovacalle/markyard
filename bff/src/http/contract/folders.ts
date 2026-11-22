// Folder routes. Owned by the folders/create phase-2 work; bodies are decoded by hand in the
// handlers (`handleRaw`) to keep the Rust status and body of a bad request.

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { DriveErrors, DriveWriteErrors, VaultErrors } from "../errors.ts";
import { IdParams, NodeSchema, Nodes } from "./node.ts";

export class FoldersGroup extends HttpApiGroup.make("folders")
  .add(HttpApiEndpoint.get("root", "/api/root", { success: NodeSchema, error: VaultErrors }))
  .add(
    HttpApiEndpoint.get("children", "/api/folders/:id/children", {
      params: IdParams,
      success: Nodes,
      error: DriveErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createFolder", "/api/folders/:id/folders", {
      params: IdParams,
      success: NodeSchema.pipe(HttpApiSchema.status(201)),
      error: DriveWriteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateFolder", "/api/folders/:id", {
      params: IdParams,
      success: NodeSchema,
      error: DriveWriteErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteFolder", "/api/folders/:id", {
      params: IdParams,
      // The root folder cannot be deleted (or none is set): 400.
      error: VaultErrors,
    }),
  ) {}
