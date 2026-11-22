// `GET` and `PUT /api/files/{id}/content` (port of Rust `files::content` / `files::save`).
// File bytes stay raw Web streams (ADR 0003 constraint 1): the download answers with Drive's
// unread body stream, and the upload passes the request's body stream (with its
// `Content-Length`) to `drive-client.upload`, which pipes it through a `FixedLengthStream`.
// A refreshed cookie and `Retry-After` go through `ResponseSink`; failures through `handleErrors`.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";

import { readContent, saveContent } from "../../application/files.ts";
import { parseContentLength } from "../../domain/files.ts";
import { accessToken, pathId, webRequest } from "../request.ts";
import { handleErrors } from "./respond.ts";

const PREFIX = "/api/files/";
const SUFFIX = "/content";

export const FileContentLive = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/files/:id/content",
    handleErrors(
      Effect.gen(function* () {
        const token = yield* accessToken;
        const content = yield* readContent(token, yield* pathId(PREFIX, SUFFIX));
        return new Response(content.body, {
          status: 200,
          headers: { etag: content.etag, "content-type": "application/octet-stream" },
        });
      }),
    ),
  ),
  HttpRouter.route(
    "PUT",
    "/api/files/:id/content",
    handleErrors(
      Effect.gen(function* () {
        const token = yield* accessToken;
        const request = yield* webRequest;
        const etag = yield* saveContent(
          token,
          yield* pathId(PREFIX, SUFFIX),
          request.headers.get("if-match"),
          {
            stream: request.body,
            contentLength: parseContentLength(request.headers.get("content-length")),
          },
        );
        return new Response(null, { status: 204, headers: { etag } });
      }),
    ),
  ),
]);
