// The HttpApi contract of every JSON route. Each group lives in its own `contract/<group>.ts`.

import * as HttpApi from "effect/http-api/HttpApi";

import { AttachmentsGroup } from "./contract/attachments.ts";
import { ChangesGroup } from "./contract/changes.ts";
import { CreateGroup } from "./contract/create.ts";
import { DriveGroup } from "./contract/drive.ts";
import { FilesGroup } from "./contract/files.ts";
import { LinkPreviewGroup } from "./contract/link-preview.ts";
import { RevisionsGroup } from "./contract/revisions.ts";
import { FoldersGroup } from "./contract/folders.ts";
import { SearchGroup } from "./contract/search.ts";
import { SessionGroup } from "./contract/session.ts";
import { StateGroup } from "./contract/state.ts";
import { SystemGroup } from "./contract/system.ts";
import { VaultGroup } from "./contract/vault.ts";

export class Api extends HttpApi.make("markyard")
  .add(SystemGroup)
  .add(SessionGroup)
  .add(FoldersGroup)
  .add(CreateGroup)
  .add(FilesGroup)
  .add(SearchGroup)
  .add(ChangesGroup)
  .add(VaultGroup)
  .add(RevisionsGroup)
  .add(AttachmentsGroup)
  .add(LinkPreviewGroup)
  .add(StateGroup)
  .add(DriveGroup) {}
