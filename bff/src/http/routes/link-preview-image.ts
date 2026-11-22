// `GET /api/link-preview/image?url=`: the same-origin proxy of a previewed page's image or icon.
// A plain-router route so the image stays a raw Web stream (ADR 0003 constraint 1): the
// upstream body is passed through a byte counter, never collected.

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";

import { PREVIEW_IMAGE_CACHE_CONTROL, previewImage } from "../../application/linkPreview.ts";
import { accessToken, webRequest } from "../request.ts";
import { handleErrors } from "./respond.ts";

export const LinkPreviewImageLive = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/link-preview/image",
    handleErrors(
      Effect.gen(function* () {
        yield* accessToken;
        const request = yield* webRequest;
        const image = yield* previewImage(new URL(request.url).searchParams.get("url"));
        return new Response(image.body, {
          status: 200,
          headers: {
            "content-type": image.mimeType,
            "content-disposition": "inline",
            "cache-control": PREVIEW_IMAGE_CACHE_CONTROL,
          },
        });
      }),
    ),
  ),
]);
