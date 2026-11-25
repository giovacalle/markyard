// `POST /api/attachments`, `GET /api/files/{id}/blob` and `GET /api/files/{id}/thumb`: image
// attachments. Both are plain
// router routes so the image bytes stay raw Web streams (ADR 0003 constraint 1): the upload
// passes the request's body stream (with its `Content-Length`) to the Drive multipart upload,
// and the download answers with Drive's unread media body. The same-origin guard of `app.ts`
// covers the `POST`.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";

import {
  attachmentsFolderName,
  readBlob,
  readThumb,
  uploadAttachment,
} from "../../application/attachments.ts";
import { thumbSizeOf } from "../../domain/attachments.ts";
import { invalidRequest } from "../../domain/errors.ts";
import { parseContentLength } from "../../domain/files.ts";
import { pathId, vaultAccess, webRequest } from "../request.ts";
import { handleErrors } from "./respond.ts";

/** Private (per-user) caching for an hour; `no-transform` keeps proxies from recompressing. */
export const BLOB_CACHE_CONTROL = "private, max-age=3600, no-transform";

const decodeHeaderFolder = (raw: string | null): string | null => {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const BAD_THUMB_SIZE = "size must be a whole number of pixels.";

export const AttachmentsLive = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/api/attachments",
    handleErrors(
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        const request = yield* webRequest;
        const folderName = yield* attachmentsFolderName(
          decodeHeaderFolder(request.headers.get("x-attachments-folder")) ??
            new URL(request.url).searchParams.get("folder"),
        );
        const attachment = yield* uploadAttachment(
          token,
          { rootFolderId, folderName },
          request.headers.get("content-type"),
          request.headers.get("x-filename"),
          {
            stream: request.body,
            contentLength: parseContentLength(request.headers.get("content-length")),
          },
        );
        return new Response(JSON.stringify(attachment), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/files/:id/blob",
    handleErrors(
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        const blob = yield* readBlob(token, rootFolderId, yield* pathId("/api/files/", "/blob"));
        return new Response(blob.body, {
          status: 200,
          headers: {
            "content-type": blob.mimeType,
            "content-disposition": "inline",
            "cache-control": BLOB_CACHE_CONTROL,
          },
        });
      }),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/files/:id/thumb",
    handleErrors(
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        const request = yield* webRequest;
        const size = thumbSizeOf(new URL(request.url).searchParams.get("size"));
        if (size === undefined) return yield* Effect.fail(invalidRequest(BAD_THUMB_SIZE));
        const thumb = yield* readThumb(
          token,
          rootFolderId,
          yield* pathId("/api/files/", "/thumb"),
          size,
        );
        return new Response(thumb.body, {
          status: 200,
          headers: {
            "content-type": thumb.mimeType,
            "content-disposition": "inline",
            "cache-control": BLOB_CACHE_CONTROL,
            "x-thumbnail-source": thumb.source,
          },
        });
      }),
    ),
  ),
]);
