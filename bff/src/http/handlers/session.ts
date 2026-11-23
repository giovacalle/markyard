import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { authorized } from "../../application/auth.ts";
import { CLEAR_SESSION_COOKIE } from "../../application/failures.ts";
import { adoptStoredRoot, effectiveRootFolderId } from "../../application/vaultRoot.ts";
import { ResponseSink, StateStore } from "../../application/ports.ts";
import { Api } from "../api.ts";
import { cookieHeader } from "../request.ts";

export const SessionLive = HttpApiBuilder.group(Api, "session", (handlers) =>
  handlers
    // `GET /api/session`: the signed-in account, or why there is none. No Drive call when the
    // cookie is fresh: the display name comes from the cookie. A vault root synced from another
    // device is adopted into this device's cookie here.
    .handle("status", () =>
      Effect.gen(function* () {
        const session = yield* adoptStoredRoot(yield* Effect.flatMap(cookieHeader, authorized));
        const store = yield* StateStore;
        const root = effectiveRootFolderId(session);
        return {
          email: session.email,
          ...(session.name !== undefined ? { name: session.name } : {}),
          ...(store.enabled ? { cloudSync: true } : {}),
          ...(root === undefined ? { needsVaultSetup: true } : {}),
        };
      }),
    )
    // `POST /api/auth/logout`: clear the cookie and browser HTTP cache on this device. The Google grant is left alone.
    .handle("logout", () =>
      Effect.gen(function* () {
        const sink = yield* ResponseSink;
        sink.setCookie(CLEAR_SESSION_COOKIE);
        sink.setHeader("clear-site-data", '"cache"');
      }),
    ),
);
