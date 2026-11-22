// `GET /api/link-preview?url=`. The session is resolved first; `url` is then read from the raw
// URL (first `url` wins), and `Cache-Control` goes through `ResponseSink`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { linkPreview } from "../../application/linkPreview.ts";
import { Api } from "../api.ts";
import { accessToken, webRequest } from "../request.ts";

export const LinkPreviewLive = HttpApiBuilder.group(Api, "linkPreview", (handlers) =>
  handlers.handle("linkPreview", () =>
    Effect.gen(function* () {
      yield* accessToken;
      const request = yield* webRequest;
      return yield* linkPreview(new URL(request.url).searchParams.get("url"));
    }),
  ),
);
