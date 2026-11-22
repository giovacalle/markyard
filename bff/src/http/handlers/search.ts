// `GET /api/search?q=` (port of Rust `core/src/search.rs`). The session is resolved first; `q` is
// then read from the raw URL the way Rust's `form_urlencoded::parse` saw it (first `q` wins).

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { search } from "../../application/search.ts";
import { Api } from "../api.ts";
import { queryParam, vaultAccess } from "../request.ts";

export const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", () =>
    Effect.gen(function* () {
      const { token, rootFolderId } = yield* vaultAccess;
      const rawQ = (yield* queryParam("q")) ?? "";
      return yield* search(token, rootFolderId, rawQ);
    }),
  ),
);
