// `GET /api/files/{id}/revisions`. The raw path id is validated, as on every file route.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { listFileRevisions } from "../../application/revisions.ts";
import { Api } from "../api.ts";
import { accessToken, pathId } from "../request.ts";

export const RevisionsLive = HttpApiBuilder.group(Api, "revisions", (handlers) =>
  handlers.handle("listRevisions", () =>
    Effect.gen(function* () {
      const token = yield* accessToken;
      return yield* listFileRevisions(token, yield* pathId("/api/files/", "/revisions"));
    }),
  ),
);
