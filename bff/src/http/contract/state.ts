// `GET`/`PUT /api/state`: the synced UI state. The `PUT` body is decoded by hand (`handleRaw`)
// so every bad body, including an oversized one, is the same 400 `invalid_request`.

import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

import { InvalidRequest400, Unauthenticated401, UpstreamError502 } from "../errors.ts";

/** `domain/state.ts` `UserState`. */
export const UserStateSchema = Schema.Struct({
  theme: Schema.optionalKey(Schema.Literals(["light", "dark", "system"])),
  lastOpenFileId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expandedFolders: Schema.optionalKey(Schema.Array(Schema.String)),
  readOnly: Schema.optionalKey(Schema.Boolean),
  focusMode: Schema.optionalKey(Schema.Boolean),
  typewriterMode: Schema.optionalKey(Schema.Boolean),
  infoDrawerOpen: Schema.optionalKey(Schema.Boolean),
  rootFolderId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  attachmentsFolder: Schema.optionalKey(Schema.String),
  showAttachmentsFolder: Schema.optionalKey(Schema.Boolean),
  dailyNotesFolder: Schema.optionalKey(Schema.String),
  templatesFolder: Schema.optionalKey(Schema.String),
  stylesFolder: Schema.optionalKey(Schema.String),
  customCss: Schema.optionalKey(Schema.Boolean),
  defaultMode: Schema.optionalKey(Schema.Literals(["preview", "edit"])),
  linkPreviewsEnabled: Schema.optionalKey(Schema.Boolean),
});

export const StateAnswerSchema = Schema.Struct({
  enabled: Schema.Boolean,
  state: Schema.NullOr(UserStateSchema),
  updatedAt: Schema.NullOr(Schema.Number),
});

export class StateGroup extends HttpApiGroup.make("state")
  .add(
    HttpApiEndpoint.get("read", "/api/state", {
      success: StateAnswerSchema,
      error: [Unauthenticated401, UpstreamError502],
    }),
  )
  .add(
    HttpApiEndpoint.put("write", "/api/state", {
      success: StateAnswerSchema,
      error: [Unauthenticated401, UpstreamError502, InvalidRequest400],
    }),
  ) {}
