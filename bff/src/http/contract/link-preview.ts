// `GET /api/link-preview?url=`: a public page's preview metadata. `url` is read from the raw URL
// by the handler, so a missing one is the use case's own 400. The image proxy is a plain-router
// route (`routes/link-preview-image.ts`).

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { DriveErrors, InvalidRequest400 } from "../errors.ts";

/** `application/linkPreview.ts` `LinkPreview`, in wire key order. */
export const LinkPreviewSchema = Schema.Struct({
  url: Schema.String,
  finalUrl: Schema.String,
  hostname: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  siteName: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
  favicon: Schema.optionalKey(Schema.String),
});

export class LinkPreviewGroup extends HttpApiGroup.make("linkPreview").add(
  HttpApiEndpoint.get("linkPreview", "/api/link-preview", {
    success: LinkPreviewSchema,
    error: [...DriveErrors, InvalidRequest400],
  }),
) {}
