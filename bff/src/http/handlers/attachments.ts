// `GET /api/attachments?folder=`.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { attachmentsFolderName, listAttachments } from "../../application/attachments.ts";
import { Api } from "../api.ts";
import { queryParam, vaultAccess } from "../request.ts";

export const AttachmentsListLive = HttpApiBuilder.group(Api, "attachments", (handlers) =>
  handlers.handle("listAttachments", () =>
    Effect.gen(function* () {
      const { token, rootFolderId } = yield* vaultAccess;
      const folderName = yield* attachmentsFolderName(yield* queryParam("folder"));
      return yield* listAttachments(token, { rootFolderId, folderName });
    }),
  ),
);
