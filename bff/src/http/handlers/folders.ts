// Folder routes (port of Rust `core/src/folders.rs`). Each handler checks the session first, as
// Rust does, then hands the raw (still percent-encoded) path id to the use case. Body routes use
// `handleRaw` and decode the body by hand so a bad body keeps Rust's 400 `invalid_request`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Folders from "../../application/folders.ts";
import { Api } from "../api.ts";
import { accessToken, bodyBytes, pathId, vaultAccess } from "../request.ts";

const PREFIX = "/api/folders/";

export const FoldersLive = HttpApiBuilder.group(Api, "folders", (handlers) =>
  handlers
    .handle("root", () =>
      Effect.flatMap(vaultAccess, ({ token, rootFolderId }) => Folders.root(token, rootFolderId)),
    )
    .handle("children", () =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        return yield* Folders.children(token, yield* pathId(PREFIX, "/children"));
      }),
    )
    .handleRaw("createFolder", () =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        const id = yield* pathId(PREFIX, "/folders");
        return yield* Folders.create(token, id, yield* bodyBytes);
      }),
    )
    .handleRaw("updateFolder", () =>
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        const id = yield* pathId(PREFIX);
        return yield* Folders.update(token, rootFolderId, id, yield* bodyBytes);
      }),
    )
    .handle("deleteFolder", () =>
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        return yield* Folders.remove(token, rootFolderId, yield* pathId(PREFIX));
      }),
    ),
);
