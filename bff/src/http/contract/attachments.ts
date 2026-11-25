// `GET /api/attachments?folder=&uploadedFrom=&uploadedBefore=`: the images stored in the
// attachments folder (`_attachments` unless `folder` names another), newest first, optionally only
// those uploaded in `[uploadedFrom, uploadedBefore)` (UTC RFC 3339 instants). Uploading and
// serving the bytes stay plain-router routes (`routes/attachments.ts`).

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { Forbidden403, VaultErrors } from "../errors.ts";
import { IdParams } from "./node.ts";

/** `domain/attachments.ts` `AttachmentItem`, in wire key order; `size`, `createdTime`, `tags` may be absent. */
export const AttachmentItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.optionalKey(Schema.Number),
  modifiedTime: Schema.String,
  createdTime: Schema.optionalKey(Schema.String),
  url: Schema.String,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

export class AttachmentsGroup extends HttpApiGroup.make("attachments")
  .add(
    HttpApiEndpoint.get("listAttachments", "/api/attachments", {
      success: Schema.Struct({
        folderId: Schema.NullOr(Schema.String),
        attachments: Schema.Array(AttachmentItemSchema),
      }),
      error: VaultErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAttachment", "/api/attachments/:id", {
      params: IdParams,
      success: AttachmentItemSchema,
      error: VaultErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateAttachmentTags", "/api/attachments/:id/tags", {
      params: IdParams,
      success: AttachmentItemSchema,
      error: [...VaultErrors, Forbidden403],
    }),
  ) {}
