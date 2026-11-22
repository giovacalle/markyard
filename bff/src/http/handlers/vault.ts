// `GET /api/vault/index` and `PUT /api/vault/root`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { vaultIndex } from "../../application/vault.ts";
import { selectVaultRoot } from "../../application/vaultRoot.ts";
import { Api } from "../api.ts";
import { bodyBytes, signedInSession, vaultAccess } from "../request.ts";

export const VaultLive = HttpApiBuilder.group(Api, "vault", (handlers) =>
  handlers
    .handle("index", () =>
      Effect.flatMap(vaultAccess, ({ token, rootFolderId }) => vaultIndex(token, rootFolderId)),
    )
    .handleRaw("selectRoot", () =>
      Effect.gen(function* () {
        const session = yield* signedInSession;
        return yield* selectVaultRoot(session, yield* bodyBytes);
      }),
    ),
);
