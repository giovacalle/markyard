// `POST /api/folders/{id}/files` (port of Rust `core/src/create.rs`). The body is decoded by hand
// (`handleRaw`) so a bad body keeps Rust's 400 `invalid_request`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { createFile } from "../../application/create.ts";
import { tooLarge } from "../../domain/errors.ts";
import { Api } from "../api.ts";
import { accessToken, MAX_CREATE_BODY_BYTES, pathId, readBodyBytes } from "../request.ts";

export const CreateLive = HttpApiBuilder.group(Api, "create", (handlers) =>
  handlers.handleRaw("createFile", () =>
    Effect.gen(function* () {
      const token = yield* accessToken;
      const folderId = yield* pathId("/api/folders/", "/files");
      const body = yield* readBodyBytes(MAX_CREATE_BODY_BYTES);
      if (body === undefined) return yield* Effect.fail(tooLarge());
      return yield* createFile(token, folderId, body);
    }),
  ),
);
