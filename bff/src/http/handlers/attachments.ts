// `GET /api/attachments?folder=&uploadedFrom=&uploadedBefore=`,
// `GET /api/attachments/{id}` and `PATCH /api/attachments/{id}/tags`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  attachmentsFolderName,
  getAttachment,
  listAttachments,
  updateAttachmentTags,
  uploadedRange,
} from "../../application/attachments.ts";
import { Api } from "../api.ts";
import { bodyBytes, pathId, queryParam, vaultAccess } from "../request.ts";

const PREFIX = "/api/attachments/";

export const AttachmentsListLive = HttpApiBuilder.group(Api, "attachments", (handlers) =>
  handlers
    .handle("listAttachments", () =>
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        const folderName = yield* attachmentsFolderName(yield* queryParam("folder"));
        const range = yield* uploadedRange(
          yield* queryParam("uploadedFrom"),
          yield* queryParam("uploadedBefore"),
        );
        return yield* listAttachments(token, { rootFolderId, folderName }, range);
      }),
    )
    .handle("getAttachment", () =>
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        return yield* getAttachment(token, rootFolderId, yield* pathId(PREFIX));
      }),
    )
    .handleRaw("updateAttachmentTags", () =>
      Effect.gen(function* () {
        const { token, rootFolderId } = yield* vaultAccess;
        return yield* updateAttachmentTags(
          token,
          rootFolderId,
          yield* pathId(PREFIX, "/tags"),
          yield* bodyBytes,
        );
      }),
    ),
);
