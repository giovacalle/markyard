// `GET /api/vault/index`: every live folder and Markdown file under the root folder in one call,
// so the web app can sync the whole vault offline and resolve any item's folder path locally.
// Folders are listed level by level with bounded concurrency; a visited set makes a Drive folder
// cycle harmless, and caps keep one request bounded (the answer then says `truncated`).

import * as Effect from "effect/Effect";

import { kindOf } from "../domain/drive.ts";
import { listChildren, type DriveFailure, type DriveR } from "../infrastructure/drive-client.ts";

/** How many folders are listed at once. */
export const INDEX_CONCURRENCY = 4;
export const MAX_INDEX_FOLDERS = 500;
export const MAX_INDEX_FILES = 5000;

export interface IndexEntry {
  readonly id: string;
  readonly name: string;
  readonly parentId: string;
  readonly modifiedTime: string;
}

export interface VaultIndex {
  readonly rootId: string;
  readonly folders: ReadonlyArray<IndexEntry>;
  readonly files: ReadonlyArray<IndexEntry>;
  readonly truncated: boolean;
}

export const vaultIndex = (
  token: string,
  rootFolderId: string,
): Effect.Effect<VaultIndex, DriveFailure, DriveR> =>
  Effect.gen(function* () {
    const seen = new Set([rootFolderId]);
    const folders: Array<IndexEntry> = [];
    const files: Array<IndexEntry> = [];
    let truncated = false;
    let level = [rootFolderId];
    while (level.length > 0) {
      const listings = yield* Effect.forEach(level, (id) => listChildren(token, id), {
        concurrency: INDEX_CONCURRENCY,
      });
      const next: Array<string> = [];
      for (const [i, children] of listings.entries()) {
        const parentId = level[i]!;
        for (const { id, name, mimeType, modifiedTime } of children) {
          const kind = kindOf({ name, mimeType });
          if (kind === "other" || seen.has(id)) continue;
          const into = kind === "folder" ? folders : files;
          if (into.length >= (kind === "folder" ? MAX_INDEX_FOLDERS : MAX_INDEX_FILES)) {
            truncated = true;
            continue;
          }
          seen.add(id);
          into.push({ id, name, parentId, modifiedTime });
          if (kind === "folder") next.push(id);
        }
      }
      level = next;
    }
    return { rootId: rootFolderId, folders, files, truncated };
  });
