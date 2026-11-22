// `GET /api/changes/start-token` and `GET /api/changes?pageToken=`. The session is resolved first;
// `pageToken` is then read from the raw URL (first one wins).

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { changesSince, startToken } from "../../application/changes.ts";
import { Api } from "../api.ts";
import { accessToken, webRequest } from "../request.ts";

export const ChangesLive = HttpApiBuilder.group(Api, "changes", (handlers) =>
  handlers
    .handle("startToken", () => Effect.flatMap(accessToken, startToken))
    .handle("changes", () =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        const request = yield* webRequest;
        return yield* changesSince(token, new URL(request.url).searchParams.get("pageToken"));
      }),
    ),
);
