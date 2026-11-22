// `POST /api/folders/{id}/files` (port of Rust `core/src/create.rs`). The body is decoded by hand
// (`handleRaw`) so a bad body keeps Rust's 400 `invalid_request`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { createFile } from "../../application/create.ts";
import { Api } from "../api.ts";
import { accessToken, pathId, webRequest } from "../request.ts";

/** The whole request body; an unreadable one is treated as empty, which fails JSON decoding. */
const requestBody = Effect.flatMap(webRequest, (request) =>
  Effect.tryPromise(() => request.arrayBuffer()).pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.orElseSucceed(() => new Uint8Array()),
  ),
);

export const CreateLive = HttpApiBuilder.group(Api, "create", (handlers) =>
  handlers.handleRaw("createFile", () =>
    Effect.gen(function* () {
      const token = yield* accessToken;
      const folderId = yield* pathId("/api/folders/", "/files");
      return yield* createFile(token, folderId, yield* requestBody);
    }),
  ),
);
