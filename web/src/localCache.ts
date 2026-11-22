import type { QueryClient } from "@tanstack/react-query";
import Dexie, { type EntityTable, type Table } from "dexie";
import { isUnauthenticated, type DriveNode, type Session } from "./api";
import { clearCloudStateStamp } from "./cloudStateStamp";
import { resetSettings } from "./settings";
import { childrenKey } from "./treeCache";

/**
 * Timestamp in the past used when seeding React Query from IndexedDB so cached data renders
 * immediately while still triggering a background revalidation against Drive.
 */
export const CACHE_STALE_TIMESTAMP = 1;

export interface CachedAccount {
  key: "account";
  email: string;
  name?: string;
  /** Last seen `session.cloudSync`, so an offline start still tracks preference changes. */
  cloudSync?: boolean;
  root: DriveNode | null;
  updatedAt: number;
}

/** A note Drive reported as changed by someone else, for "Recently updated on Drive". */
export interface RecentDriveChange {
  id: string;
  name: string;
  parentId?: string;
  time: string;
}

/** The changes feed's place and what it last reported; scoped to the signed-in account. */
export interface CachedChangesState {
  key: "changes";
  startPageToken: string | null;
  recent: RecentDriveChange[];
  selfWrites: [string, number][];
  updatedAt: number;
}

/** Outcome of the last full-vault offline sync. */
export interface CachedVaultState {
  key: "vault";
  lastSyncedAt: number | null;
  total: number;
  cached: number;
  updatedAt: number;
}

type MetaRow = CachedAccount | CachedChangesState | CachedVaultState;

const ACCOUNT_SCOPED_META_KEYS = ["changes", "vault"] as const;

export interface CachedFolder {
  folderId: string;
  nodes: DriveNode[];
  updatedAt: number;
}

export interface CachedFile {
  fileId: string;
  text: string;
  revision: string;
  updatedAt: number;
}

export interface PendingWrite {
  fileId: string;
  text: string;
  baseRevision: string;
  /**
   * The Drive text that `baseRevision` names, when known. Lets the sync queue tell a false
   * conflict (Drive's tag moved but its text did not, e.g. a metadata-only change) from a real one.
   */
  baseText?: string;
  seq: number;
  updatedAt: number;
}

class MarkyardDB extends Dexie {
  meta!: Table<MetaRow, string>;
  folders!: EntityTable<CachedFolder, "folderId">;
  files!: EntityTable<CachedFile, "fileId">;
  outbox!: EntityTable<PendingWrite, "fileId">;

  constructor() {
    super("markyard");
    this.version(1).stores({
      meta: "key",
      folders: "folderId",
      files: "fileId",
    });
    this.version(2).stores({
      meta: "key",
      folders: "folderId",
      files: "fileId",
      outbox: "fileId",
    });
  }
}

let dbInstance: MarkyardDB | null = null;

function getDb(): MarkyardDB | null {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  if (dbInstance === null) {
    dbInstance = new MarkyardDB();
  }
  return dbInstance;
}

/**
 * Swallows IndexedDB errors (for example private browsing quotas or blocked storage):
 * the local cache degrades gracefully without breaking online editing.
 */
async function safe<T>(fn: (db: MarkyardDB) => Promise<T>, fallback: T): Promise<T> {
  const db = getDb();
  if (db === null) {
    return fallback;
  }
  try {
    return await fn(db);
  } catch {
    return fallback;
  }
}

export function readCachedAccount(): Promise<CachedAccount | undefined> {
  return safe(async (db) => (await db.meta.get("account")) as CachedAccount | undefined, undefined);
}

export function readChangesState(): Promise<CachedChangesState | undefined> {
  return safe(
    async (db) => (await db.meta.get("changes")) as CachedChangesState | undefined,
    undefined,
  );
}

/** Merges `patch` into the stored changes state; a no-op once the account row is gone. */
export function updateChangesState(
  patch: Partial<Omit<CachedChangesState, "key" | "updatedAt">>,
): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.meta, async () => {
      if ((await db.meta.get("account")) === undefined) {
        return;
      }
      const existing = (await db.meta.get("changes")) as CachedChangesState | undefined;
      await db.meta.put({
        key: "changes",
        startPageToken: existing?.startPageToken ?? null,
        recent: existing?.recent ?? [],
        selfWrites: existing?.selfWrites ?? [],
        ...patch,
        updatedAt: Date.now(),
      });
    });
  }, undefined);
}

export function readVaultState(): Promise<CachedVaultState | undefined> {
  return safe(
    async (db) => (await db.meta.get("vault")) as CachedVaultState | undefined,
    undefined,
  );
}

export function writeVaultState(state: Omit<CachedVaultState, "key" | "updatedAt">): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.meta, async () => {
      if ((await db.meta.get("account")) === undefined) {
        return;
      }
      await db.meta.put({ key: "vault", ...state, updatedAt: Date.now() });
    });
  }, undefined);
}

/** When each cached note was stored locally, by file id (no note text is loaded). */
export function readCachedFileStamps(): Promise<Map<string, number>> {
  return safe(async (db) => {
    const stamps = new Map<string, number>();
    await db.files.each((row) => {
      stamps.set(row.fileId, row.updatedAt);
    });
    return stamps;
  }, new Map());
}

export function writeCachedFolders(entries: { folderId: string; nodes: DriveNode[] }[]) {
  return safe(async (db) => {
    const now = Date.now();
    await db.folders.bulkPut(entries.map((entry) => ({ ...entry, updatedAt: now })));
  }, undefined);
}

/** Takes `node` out of every cached listing and puts it into `toFolderId`'s, when cached. */
export function moveCachedChild(node: DriveNode, toFolderId: string): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.folders, async () => {
      const folders = await db.folders.toArray();
      const now = Date.now();
      for (const folder of folders) {
        const without = folder.nodes.filter((n) => n.id !== node.id);
        if (folder.folderId === toFolderId) {
          await db.folders.put({ folderId: toFolderId, nodes: [...without, node], updatedAt: now });
        } else if (without.length !== folder.nodes.length) {
          await db.folders.put({ folderId: folder.folderId, nodes: without, updatedAt: now });
        }
      }
    });
  }, undefined);
}

export function writeCachedSession(
  email: string,
  name?: string,
  cloudSync?: boolean,
): Promise<void> {
  const profile = {
    ...(name !== undefined && name.trim().length > 0 ? { name } : {}),
    ...(cloudSync === true ? { cloudSync } : {}),
  };
  return safe(async (db) => {
    await db.transaction("rw", [db.meta, db.folders, db.files, db.outbox], async () => {
      const existing = (await db.meta.get("account")) as CachedAccount | undefined;
      if (existing !== undefined && existing.email !== email) {
        clearCloudStateStamp();
        resetSettings();
        await db.folders.clear();
        await db.files.clear();
        await db.outbox.clear();
        await db.meta.bulkDelete([...ACCOUNT_SCOPED_META_KEYS]);
        await db.meta.put({ key: "account", email, ...profile, root: null, updatedAt: Date.now() });
        return;
      }
      await db.meta.put({
        key: "account",
        email,
        ...profile,
        root: existing?.root ?? null,
        updatedAt: Date.now(),
      });
    });
  }, undefined);
}

export function writeCachedRoot(root: DriveNode): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.meta, async () => {
      const existing = (await db.meta.get("account")) as CachedAccount | undefined;
      if (existing === undefined) {
        return;
      }
      await db.meta.put({ ...existing, root, updatedAt: Date.now() });
    });
  }, undefined);
}

export function readAllCachedFolders(): Promise<CachedFolder[]> {
  return safe((db) => db.folders.toArray(), []);
}

export function readAllCachedFiles(): Promise<CachedFile[]> {
  return safe((db) => db.files.toArray(), []);
}

export function writeCachedFolder(folderId: string, nodes: DriveNode[]): Promise<void> {
  return safe(async (db) => {
    await db.folders.put({ folderId, nodes, updatedAt: Date.now() });
  }, undefined);
}

export function addCachedChild(folderId: string, node: DriveNode): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.folders, async () => {
      const existing = await db.folders.get(folderId);
      if (existing === undefined) {
        return;
      }
      const next = [...existing.nodes.filter((n) => n.id !== node.id), node];
      await db.folders.put({ folderId, nodes: next, updatedAt: Date.now() });
    });
  }, undefined);
}

export function renameCachedChild(fileId: string, updated: DriveNode): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.folders, async () => {
      const folders = await db.folders.toArray();
      const now = Date.now();
      for (const folder of folders) {
        if (folder.nodes.some((n) => n.id === fileId)) {
          await db.folders.put({
            folderId: folder.folderId,
            nodes: folder.nodes.map((n) => (n.id === fileId ? updated : n)),
            updatedAt: now,
          });
        }
      }
    });
  }, undefined);
}

export function removeCachedChild(fileId: string): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", db.folders, async () => {
      const folders = await db.folders.toArray();
      const now = Date.now();
      for (const folder of folders) {
        if (folder.nodes.some((n) => n.id === fileId)) {
          await db.folders.put({
            folderId: folder.folderId,
            nodes: folder.nodes.filter((n) => n.id !== fileId),
            updatedAt: now,
          });
        }
      }
    });
  }, undefined);
}

export function readCachedFile(
  fileId: string,
): Promise<{ text: string; revision: string } | undefined> {
  return safe(async (db) => {
    const pending = await db.outbox.get(fileId);
    if (pending !== undefined) {
      return { text: pending.text, revision: pending.baseRevision };
    }
    const row = await db.files.get(fileId);
    return row === undefined ? undefined : { text: row.text, revision: row.revision };
  }, undefined);
}

export function writeCachedFile(fileId: string, text: string, revision: string): Promise<void> {
  return safe(async (db) => {
    await db.files.put({ fileId, text, revision, updatedAt: Date.now() });
  }, undefined);
}

/**
 * Updates the stored Drive revision for `fileId` across both `files` and `outbox` (e.g. after a
 * metadata-only rename bumps Drive's v2 ETag without changing the file's text).
 */
export function updateCachedFileRevision(fileId: string, revision: string): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", [db.files, db.outbox], async () => {
      const now = Date.now();
      const existingFile = await db.files.get(fileId);
      if (existingFile !== undefined) {
        await db.files.put({ ...existingFile, revision, updatedAt: now });
      }
      const existingPending = await db.outbox.get(fileId);
      if (existingPending !== undefined) {
        await db.outbox.put({ ...existingPending, baseRevision: revision, updatedAt: now });
      }
    });
  }, undefined);
}

/**
 * Persists freshly fetched Drive content only when no unsynced local write is pending for the file.
 * Returns the pending write if one prevented overwriting the local copy.
 */
export function writeCachedRemoteFile(
  fileId: string,
  text: string,
  revision: string,
): Promise<PendingWrite | undefined> {
  return safe(async (db) => {
    return await db.transaction("rw", [db.files, db.outbox], async () => {
      const pending = await db.outbox.get(fileId);
      if (pending !== undefined) {
        // Drive's tag moved while its text still equals our base (a metadata-only change):
        // rebase the queued edit so its upload does not hit a false 412.
        if (
          revision.length > 0 &&
          pending.baseRevision !== revision &&
          pending.baseText !== undefined &&
          pending.baseText === text
        ) {
          const rebased: PendingWrite = { ...pending, baseRevision: revision };
          await db.outbox.put(rebased);
          return rebased;
        }
        return pending;
      }
      await db.files.put({ fileId, text, revision, updatedAt: Date.now() });
      return undefined;
    });
  }, undefined);
}

export function deleteCachedFile(fileId: string): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", [db.files, db.outbox], async () => {
      await db.files.delete(fileId);
      await db.outbox.delete(fileId);
    });
  }, undefined);
}

export function deleteCachedFolderTree(folderIds: string[], fileIds: string[]): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", [db.folders, db.files, db.outbox], async () => {
      if (folderIds.length > 0) {
        await db.folders.bulkDelete(folderIds);
      }
      if (fileIds.length > 0) {
        await db.files.bulkDelete(fileIds);
        await db.outbox.bulkDelete(fileIds);
      }
    });
  }, undefined);
}

export function readPendingWrite(fileId: string): Promise<PendingWrite | undefined> {
  return safe((db) => db.outbox.get(fileId), undefined);
}

export function readAllPendingWrites(): Promise<PendingWrite[]> {
  return safe((db) => db.outbox.toArray(), []);
}

/**
 * Persists a local edit immediately into both `files` and `outbox`, coalescing repeated writes
 * to the same file while keeping its original Drive `baseRevision` until Drive acknowledges a sync.
 */
export function upsertPendingWrite(
  fileId: string,
  text: string,
  baseRevision: string,
  baseText?: string,
): Promise<PendingWrite> {
  const fallback: PendingWrite = {
    fileId,
    text,
    baseRevision,
    baseText,
    seq: Date.now(),
    updatedAt: Date.now(),
  };
  return safe(async (db) => {
    return await db.transaction("rw", [db.files, db.outbox], async () => {
      const existing = await db.outbox.get(fileId);
      const entry: PendingWrite = {
        fileId,
        text,
        baseRevision: existing?.baseRevision ?? baseRevision,
        baseText: existing !== undefined ? existing.baseText : baseText,
        seq: (existing?.seq ?? 0) + 1,
        updatedAt: Date.now(),
      };
      await db.outbox.put(entry);
      await db.files.put({
        fileId,
        text: entry.text,
        revision: entry.baseRevision,
        updatedAt: entry.updatedAt,
      });
      return entry;
    });
  }, fallback);
}

/**
 * Marks a Drive sync as complete for `syncedSeq`. If a newer edit arrived while the PUT was in
 * flight, chains `newRevision` onto that newer outbox entry and returns it for immediate follow-up.
 */
export function completePendingWrite(
  fileId: string,
  syncedSeq: number,
  syncedText: string,
  newRevision: string,
): Promise<PendingWrite | null> {
  return safe(async (db) => {
    return await db.transaction("rw", [db.files, db.outbox], async () => {
      const current = await db.outbox.get(fileId);
      const now = Date.now();
      if (current === undefined || current.seq === syncedSeq) {
        await db.outbox.delete(fileId);
        await db.files.put({ fileId, text: syncedText, revision: newRevision, updatedAt: now });
        return null;
      }
      const next: PendingWrite = { ...current, baseRevision: newRevision, baseText: syncedText };
      await db.outbox.put(next);
      await db.files.put({ fileId, text: current.text, revision: newRevision, updatedAt: now });
      return next;
    });
  }, null);
}

export function deletePendingWrite(fileId: string): Promise<void> {
  return safe(async (db) => {
    await db.outbox.delete(fileId);
  }, undefined);
}

/**
 * Forgets the current vault's cached folders, notes, pending edits and Drive cursors while keeping
 * the signed-in account (vault switch). The cloud state stamp goes too, so the new vault adopts the
 * cloud's state.
 */
export function clearVaultCache(): Promise<void> {
  clearCloudStateStamp();
  return safe(async (db) => {
    await db.transaction("rw", [db.meta, db.folders, db.files, db.outbox], async () => {
      await db.folders.clear();
      await db.files.clear();
      await db.outbox.clear();
      await db.meta.bulkDelete([...ACCOUNT_SCOPED_META_KEYS]);
      const existing = (await db.meta.get("account")) as CachedAccount | undefined;
      if (existing !== undefined) {
        await db.meta.put({ ...existing, root: null, updatedAt: Date.now() });
      }
    });
  }, undefined);
}

export function clearLocalCache(): Promise<void> {
  clearCloudStateStamp();
  return safe(async (db) => {
    await db.transaction("rw", [db.meta, db.folders, db.files, db.outbox], async () => {
      await db.meta.clear();
      await db.folders.clear();
      await db.files.clear();
      await db.outbox.clear();
    });
  }, undefined);
}

/**
 * Seeds React Query with locally cached data (marked stale via `CACHE_STALE_TIMESTAMP`) without
 * overwriting any data that has already arrived from the network, so the UI opens immediately
 * from IndexedDB while still revalidating against Drive in the background.
 */
export async function hydrateQueryClient(
  queryClient: QueryClient,
  openFileId: string | null,
): Promise<boolean> {
  const account = await readCachedAccount();
  if (account === undefined) {
    return false;
  }

  const seedIfEmpty = <T>(key: readonly unknown[], value: T) => {
    const state = queryClient.getQueryState(key);
    if (state?.data !== undefined || isUnauthenticated(state?.error)) {
      return;
    }
    queryClient.setQueryData(key, value, { updatedAt: CACHE_STALE_TIMESTAMP });
  };

  const session: Session = {
    email: account.email,
    ...(account.name !== undefined ? { name: account.name } : {}),
    ...(account.cloudSync === true ? { cloudSync: true } : {}),
  };
  seedIfEmpty(["session"], session);
  if (account.root !== null) {
    seedIfEmpty(["root"], account.root);
  }

  const [folders, file] = await Promise.all([
    readAllCachedFolders(),
    openFileId !== null ? readCachedFile(openFileId) : Promise.resolve(undefined),
  ]);

  for (const folder of folders) {
    seedIfEmpty(childrenKey(folder.folderId), folder.nodes);
  }
  if (openFileId !== null && file !== undefined) {
    seedIfEmpty(["files", openFileId, "content"], file);
  }

  return true;
}

/**
 * Requests persistent browser storage (important for installed iOS PWAs, where Safari may evict
 * IndexedDB after ~7 days of inactivity without persistent storage).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.persist !== "function") {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
