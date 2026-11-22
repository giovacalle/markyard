// `PATCH` and `DELETE /api/files/{id}` (port of Rust `files::rename` / `files::delete`, plus
// moves). The body is decoded by hand (`handleRaw`) so a bad body keeps Rust's 400
// `invalid_request`; the renamed or moved note's `ETag` goes out through `ResponseSink`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { trashFile, updateFile } from "../../application/files.ts";
import { Api } from "../api.ts";
import { accessToken, pathId, vaultAccess, webRequest } from "../request.ts";

const PREFIX = "/api/files/";

export const FilesLive = HttpApiBuilder.group(Api, "files", (handlers) =>
  handlers
    .handleRaw("updateFile", () =>
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        const request = yield* webRequest;
        const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()));
        return yield* updateFile(token, rootFolderId, yield* pathId(PREFIX), body);
      }),
    )
    .handle("deleteFile", () =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        yield* trashFile(token, yield* pathId(PREFIX));
      }),
    ),
);
