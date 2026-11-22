// `GET /api/files/{id}/revisions/{revisionId}`: the bytes of one Drive revision, answered with
// Drive's unread media body (ADR 0003 constraint 1). The list of revisions is JSON and lives in
// the HttpApi contract (`contract/revisions.ts`).

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";

import { readRevision } from "../../application/revisions.ts";
import { rawPathId } from "../../domain/drive.ts";
import { accessToken, webRequest } from "../request.ts";
import { handleErrors } from "./respond.ts";

/** The raw (still percent-encoded) `{id}` and `{revisionId}` of the current path. */
const revisionPath = Effect.map(webRequest, (request) => {
  const parts = (rawPathId(request.url, "/api/files/") ?? "").split("/");
  return parts.length === 3 && parts[1] === "revisions"
    ? { id: parts[0] ?? "", revisionId: parts[2] ?? "" }
    : { id: "", revisionId: "" };
});

export const RevisionContentLive = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/files/:id/revisions/:revisionId",
    handleErrors(
      Effect.gen(function* () {
        const token = yield* accessToken;
        const { id, revisionId } = yield* revisionPath;
        const body = yield* readRevision(token, id, revisionId);
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }),
    ),
  ),
]);
