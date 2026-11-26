import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type DriveNode, fetchChildren, fetchContent } from "./api";
import {
  readAllCachedFiles,
  readAllPendingWrites,
  writeCachedFolder,
  writeCachedRemoteFile,
} from "./localCache";
import { isLocalId } from "./localIds";
import type { SyncQueue } from "./syncQueue";
import { isTemplatesFolder, type TemplateNote } from "./templates";
import { childrenKey, collectIndexedTree } from "./treeCache";
import type { VaultNote } from "./wikilinks";

/** A note known from the tree cache, with the folder that lists it. */
export interface VaultNoteRef extends VaultNote {
  folderId: string;
}

/** A note whose text is available locally (memory or IndexedDB). */
export interface VaultDocument extends VaultNoteRef {
  text: string;
  /** Drive revision the local text is based on. */
  revision: string;
  /** Drive text `revision` names, when known. */
  baseText?: string;
}

/** Every Markdown note listed in the cached tree, with its folder path. */
export function vaultNotes(queryClient: QueryClient): VaultNoteRef[] {
  return collectIndexedTree(queryClient).notes.map((note) => ({
    id: note.node.id,
    name: note.node.name,
    path: note.path,
    folderId: note.folderId,
  }));
}

/** Reactive `vaultNotes`, recomputed whenever a cached folder listing changes. */
export function useVaultNotes(): VaultNoteRef[] {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState(() => vaultNotes(queryClient));
  useEffect(() => {
    setNotes(vaultNotes(queryClient));
    let scheduled = false;
    return queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      const isListing = key[0] === "root" || (key[0] === "folders" && key[2] === "children");
      if (!isListing || event.type !== "updated" || scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        setNotes(vaultNotes(queryClient));
      });
    });
  }, [queryClient]);
  return notes;
}

interface ContentData {
  text: string;
  revision: string;
}

/**
 * Every listed note with a local copy, freshest text first: the in-memory query, then an edit
 * waiting to sync, then the IndexedDB cache.
 */
export async function readVaultDocuments(queryClient: QueryClient): Promise<VaultDocument[]> {
  const [files, pending] = await Promise.all([readAllCachedFiles(), readAllPendingWrites()]);
  const cachedById = new Map(files.map((file) => [file.fileId, file]));
  const pendingById = new Map(pending.map((write) => [write.fileId, write]));
  const out: VaultDocument[] = [];
  for (const note of vaultNotes(queryClient)) {
    const live = queryClient.getQueryData<ContentData>(["files", note.id, "content"]);
    const write = pendingById.get(note.id);
    const cached = cachedById.get(note.id);
    const text = live?.text ?? write?.text ?? cached?.text;
    if (text === undefined) {
      continue;
    }
    if (write !== undefined) {
      out.push({ ...note, text, revision: write.baseRevision, baseText: write.baseText });
    } else if (live !== undefined) {
      out.push({ ...note, text, revision: live.revision, baseText: cached?.text });
    } else if (cached !== undefined) {
      out.push({ ...note, text, revision: cached.revision, baseText: cached.text });
    }
  }
  return out;
}

/** Saves a changed note locally right away and syncs it to Drive through the queue. */
export function saveVaultDocument(syncQueue: SyncQueue, doc: VaultDocument, text: string): void {
  syncQueue.enqueueSave(doc.id, text, doc.revision, doc.baseText);
}

export interface RootFolderNotesResult {
  state: "known" | "unknown";
  notes: TemplateNote[];
}

export interface ReadRootFolderNotesOptions {
  signal?: AbortSignal;
  /** File ids to fetch fresh from Drive even when a local copy exists (unless a write is pending). */
  forceIds?: ReadonlySet<string>;
}

/**
 * Reads every `.md` note in the root subfolder `folderName` (case-insensitive).
 *
 * `state` is `"known"` only when either (a) the root listing is loaded and the folder does not
 * exist, or (b) the folder is listed and every `.md` note's text was obtained. Any unlisted root
 * or folder, offline uncached note, or failed content fetch answers `"unknown"` so callers like
 * custom CSS keep their cached output instead of wiping it.
 */
export async function readRootFolderNotes(
  queryClient: QueryClient,
  folderName: string,
  options?: ReadRootFolderNotesOptions,
): Promise<RootFolderNotesResult> {
  const signal = options?.signal;
  const forceIds = options?.forceIds;
  const root = queryClient.getQueryData<DriveNode>(["root"]);
  if (root === undefined) {
    return { state: "unknown", notes: [] };
  }
  const rootList = queryClient.getQueryData<DriveNode[]>(childrenKey(root.id));
  if (rootList === undefined) {
    return { state: "unknown", notes: [] };
  }
  const folder = rootList.find(
    (node) => node.kind === "folder" && isTemplatesFolder([node.name], folderName),
  );
  if (folder === undefined) {
    return { state: "known", notes: [] };
  }

  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  let folderChildren = queryClient.getQueryData<DriveNode[]>(childrenKey(folder.id));
  const needsForceListing =
    forceIds !== undefined &&
    forceIds.size > 0 &&
    folderChildren !== undefined &&
    Array.from(forceIds).some((id) => !folderChildren!.some((child) => child.id === id));

  if ((folderChildren === undefined || needsForceListing) && !isLocalId(folder.id) && online) {
    try {
      const children = await fetchChildren(folder.id, signal);
      queryClient.setQueryData(childrenKey(folder.id), children);
      void writeCachedFolder(folder.id, children);
      folderChildren = children;
    } catch {
      if (folderChildren === undefined) {
        return { state: "unknown", notes: [] };
      }
    }
  }

  if (folderChildren === undefined) {
    return { state: "unknown", notes: [] };
  }

  const notes = folderChildren.filter((node) => node.kind === "markdown");
  if (notes.length === 0) {
    return { state: "known", notes: [] };
  }

  const [files, pending] = await Promise.all([readAllCachedFiles(), readAllPendingWrites()]);
  const cachedById = new Map(files.map((file) => [file.fileId, file]));
  const pendingById = new Map(pending.map((write) => [write.fileId, write]));

  const results = await Promise.all(
    notes.map(async (note): Promise<TemplateNote | null> => {
      const live = queryClient.getQueryData<ContentData>(["files", note.id, "content"]);
      const write = pendingById.get(note.id);
      const cached = cachedById.get(note.id);
      const localText = live?.text ?? write?.text ?? cached?.text;
      const shouldForce =
        forceIds?.has(note.id) === true && write === undefined && !isLocalId(note.id);

      if (shouldForce) {
        if (!online) {
          return localText !== undefined ? { id: note.id, name: note.name, text: localText } : null;
        }
        try {
          const remote = await fetchContent(note.id, signal);
          if (live !== undefined) {
            queryClient.setQueryData(["files", note.id, "content"], {
              text: remote.text,
              revision: remote.revision,
            });
          }
          void writeCachedRemoteFile(note.id, remote.text, remote.revision);
          return { id: note.id, name: note.name, text: remote.text };
        } catch {
          return localText !== undefined ? { id: note.id, name: note.name, text: localText } : null;
        }
      }

      if (localText !== undefined) {
        return { id: note.id, name: note.name, text: localText };
      }
      if (isLocalId(note.id) || !online) {
        return null;
      }
      try {
        const remote = await fetchContent(note.id, signal);
        void writeCachedRemoteFile(note.id, remote.text, remote.revision);
        return { id: note.id, name: note.name, text: remote.text };
      } catch {
        return null;
      }
    }),
  );

  const missing = results.some((entry) => entry === null);
  const resolved = results
    .filter((entry): entry is TemplateNote => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { state: missing ? "unknown" : "known", notes: resolved };
}

/**
 * The `.md` notes in the root templates folder (`folderName`, `Templates` by default), with their
 * text: the local copy when there is one, otherwise read from Drive (skipped offline or on failure).
 */
export async function readTemplates(
  queryClient: QueryClient,
  signal?: AbortSignal,
  folderName = "Templates",
): Promise<TemplateNote[]> {
  const result = await readRootFolderNotes(queryClient, folderName, { signal });
  return result.notes;
}
