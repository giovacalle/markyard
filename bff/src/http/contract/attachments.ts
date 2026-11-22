// `GET /api/attachments?folder=`: the images stored in the attachments folder (`_attachments`
// unless `folder` names another), newest first. Uploading and
// serving the bytes stay plain-router routes (`routes/attachments.ts`).

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { VaultErrors } from "../errors.ts";

/** `domain/attachments.ts` `AttachmentItem`, in wire key order; `size` may be absent. */
export const AttachmentItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.optionalKey(Schema.Number),
  modifiedTime: Schema.String,
  url: Schema.String,
});

export class AttachmentsGroup extends HttpApiGroup.make("attachments").add(
  HttpApiEndpoint.get("listAttachments", "/api/attachments", {
    success: Schema.Struct({
      folderId: Schema.NullOr(Schema.String),
      attachments: Schema.Array(AttachmentItemSchema),
    }),
    error: VaultErrors,
  }),
) {}
