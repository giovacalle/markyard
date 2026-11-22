// `POST /api/folders/{id}/files`. Owned by the folders/create phase-2 work.

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { DriveWriteErrors, TooLarge413 } from "../errors.ts";
import { IdParams, NodeSchema } from "./node.ts";

export class CreateGroup extends HttpApiGroup.make("create").add(
  HttpApiEndpoint.post("createFile", "/api/folders/:id/files", {
    params: IdParams,
    success: NodeSchema.pipe(HttpApiSchema.status(201)),
    error: [...DriveWriteErrors, TooLarge413],
  }),
) {}
