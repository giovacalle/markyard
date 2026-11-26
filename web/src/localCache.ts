import type { QueryClient } from "@tanstack/react-query";
import Dexie, { type EntityTable, type Table } from "dexie";
import { isUnauthenticated, type DriveNode, type Session } from "./api";
import { clearCloudStateStamp } from "./cloudStateStamp";
import { clearCachedImages } from "./imageCache";
import { isLocalId, makeOpId } from "./localIds";
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

/** Compiled custom CSS cached across reloads for instant boot without unstyled flash. */
export interface CachedCustomCss {
  key: "customCss";
  css: string;
  notes: string[];
  updatedAt: number;
}

type MetaRow = CachedAccount | CachedChangesState | CachedVaultState | CachedCustomCss;

const ACCOUNT_SCOPED_META_KEYS = ["changes", "vault", "customCss"] as const;

let customCssCacheGeneration = 0;

/** Monotonic generation token bumped on local/vault cache clears and account switches. */
export function customCssCacheToken(): number {
  return customCssCacheGeneration;
}

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

interface PendingOpBase {
  seq?: number; // Dexie ++seq
  opId: string; // stable UUID for UI/retry/discard
  targetId: string; // `local:<uuid>` or real Drive ID
  targetName: string; // display name for SyncInspector (even after local delete)
  createdAt: number;
  updatedAt: number;
}

export interface DeletedSubtreeSnapshot {
  folders: { folderId: string; nodes: DriveNode[] }[];
  files: { fileId: string; text: string; revision: string }[];
}

export type PendingOp =
  | (PendingOpBase & {
      kind: "create_file";
      parentId: string;
      name: string;
      initialContent: string; // fallback; flush reads latest text from db.outbox/db.files
      openExistingOnConflict?: boolean; // daily note / wikilink
      autoSuffixOnConflict?: boolean; // instant Untitled.md
    })
  | (PendingOpBase & {
      kind: "create_folder";
      parentId: string;
      name: string;
      adoptExistingOnConflict?: boolean; // ensureRootSubfolder (Daily)
    })
  | (PendingOpBase & { kind: "rename_file"; name: string; previousName: string })
  | (PendingOpBase & { kind: "rename_folder"; name: string; previousName: string })
  | (PendingOpBase & { kind: "move_file"; parentId: string; previousParentId?: string })
  | (PendingOpBase & { kind: "move_folder"; parentId: string; previousParentId?: string })
  | (PendingOpBase & {
      kind: "delete_file";
      previousParentId?: string;
      previousNode?: DriveNode;
      previousFile?: { text: string; revision: string };
    })
  | (PendingOpBase & {
      kind: "delete_folder";
      previousParentId?: string;
      previousNode?: DriveNode;
      previousSubtree?: DeletedSubtreeSnapshot;
    });

class MarkyardDB extends Dexie {
  meta!: Table<MetaRow, string>;
  folders!: EntityTable<CachedFolder, "folderId">;
  files!: EntityTable<CachedFile, "fileId">;
  outbox!: EntityTable<PendingWrite, "fileId">;
  ops!: Table<PendingOp, number>;

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
    this.version(3).stores({
      meta: "key",
      folders: "folderId",
      files: "fileId",
      outbox: "fileId",
      ops: "++seq, targetId, parentId",
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

export function readCachedCustomCss(): Promise<CachedCustomCss | undefined> {
  return safe(
    async (db) => (await db.meta.get("customCss")) as CachedCustomCss | undefined,
    undefined,
  );
}

export function writeCachedCustomCss(
  row: { css: string; notes: readonly string[]; updatedAt?: number },
  token: number,
): Promise<void> {
  if (token !== customCssCacheGeneration) {
    return Promise.resolve();
  }
  return safe(async (db) => {
    await db.transaction("rw", db.meta, async () => {
      if (token !== customCssCacheGeneration) {
        return;
      }
      await db.meta.put({
        key: "customCss",
        css: row.css,
        notes: [...row.notes],
        updatedAt: row.updatedAt ?? Date.now(),
      });
    });
  }, undefined);
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
): Promise<boolean> {
  const profile = {
    ...(name !== undefined && name.trim().length > 0 ? { name } : {}),
    ...(cloudSync === true ? { cloudSync } : {}),
  };
  return safe(async (db) => {
    return db.transaction("rw", [db.meta, db.folders, db.files, db.outbox, db.ops], async () => {
      const existing = (await db.meta.get("account")) as CachedAccount | undefined;
      if (existing !== undefined && existing.email !== email) {
        customCssCacheGeneration += 1;
        clearCloudStateStamp();
        resetSettings();
        await db.folders.clear();
        await db.files.clear();
        await db.outbox.clear();
        await db.ops.clear();
        await db.meta.bulkDelete([...ACCOUNT_SCOPED_META_KEYS]);
        await db.meta.put({ key: "account", email, ...profile, root: null, updatedAt: Date.now() });
        return true;
      }
      await db.meta.put({
        key: "account",
        email,
        ...profile,
        root: existing?.root ?? null,
        updatedAt: Date.now(),
      });
      return false;
    });
  }, false);
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
 * Updates the stored Drive revision for `fileId` in `files` only when no pending write exists in
 * `outbox`. Returns `true` when the file was clean (no outbox entry), or `false` if an outbox
 * entry prevented updating.
 */
export function updateCachedFileRevision(fileId: string, revision: string): Promise<boolean> {
  return safe(async (db) => {
    return await db.transaction("rw", [db.files, db.outbox], async () => {
      const existingPending = await db.outbox.get(fileId);
      if (existingPending !== undefined) {
        return false;
      }
      const existingFile = await db.files.get(fileId);
      if (existingFile !== undefined) {
        await db.files.put({ ...existingFile, revision, updatedAt: Date.now() });
      }
      return true;
    });
  }, true);
}

/**
 * Rebases both `files` and `outbox` for `fileId` onto `revision` after confirming Drive's current
 * text still matches the queued edit's `baseText` (e.g. a metadata-only tag bump).
 */
export function rebasePendingWrite(fileId: string, revision: string): Promise<void> {
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

/**
 * Removes a cached file from `files` only when no unsynced local write is pending for it.
 * Returns the pending write if one prevented deletion.
 */
export function deleteCachedRemoteFile(fileId: string): Promise<PendingWrite | undefined> {
  return safe(async (db) => {
    return await db.transaction("rw", [db.files, db.outbox], async () => {
      const pending = await db.outbox.get(fileId);
      if (pending !== undefined) {
        return pending;
      }
      await db.files.delete(fileId);
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

/**
 * Walks cached folder listings in IndexedDB starting from `rootFolderId` (and any `knownFolderIds`),
 * deletes the entire subtree's folders, cached files, and pending outbox entries atomically, and
 * returns all deleted folder and file ids.
 */
export function deleteCachedSubtree(
  rootFolderId: string,
  knownFolderIds: readonly string[] = [],
  knownFileIds: readonly string[] = [],
): Promise<{ folderIds: string[]; fileIds: string[] }> {
  const fallback = {
    folderIds: Array.from(new Set([rootFolderId, ...knownFolderIds])),
    fileIds: Array.from(new Set(knownFileIds)),
  };
  return safe(async (db) => {
    return await db.transaction("rw", [db.folders, db.files, db.outbox], async () => {
      const cachedFolders = await db.folders.toArray();
      const byFolder = new Map<string, DriveNode[]>();
      for (const folder of cachedFolders) {
        byFolder.set(folder.folderId, folder.nodes);
      }

      const folderSet = new Set<string>();
      const fileSet = new Set<string>(knownFileIds);

      const walk = (id: string) => {
        if (folderSet.has(id)) {
          return;
        }
        folderSet.add(id);
        const nodes = byFolder.get(id);
        if (nodes === undefined) {
          return;
        }
        for (const child of nodes) {
          if (child.kind === "folder") {
            walk(child.id);
          } else {
            fileSet.add(child.id);
          }
        }
      };

      walk(rootFolderId);
      for (const id of knownFolderIds) {
        walk(id);
      }

      const folderIds = Array.from(folderSet);
      const fileIds = Array.from(fileSet);
      if (folderIds.length > 0) {
        await db.folders.bulkDelete(folderIds);
      }
      if (fileIds.length > 0) {
        await db.files.bulkDelete(fileIds);
        await db.outbox.bulkDelete(fileIds);
      }
      return { folderIds, fileIds };
    });
  }, fallback);
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
 * Deletes a pending write from `outbox` and reverts `files` back to its `baseText`/`baseRevision`
 * (or deletes the cached file row when no `baseText` was recorded).
 */
export function discardPendingWrite(
  fileId: string,
): Promise<{ reverted: { text: string; revision: string } | null; hadPending: boolean }> {
  return safe(
    async (db) => {
      return await db.transaction("rw", [db.files, db.outbox], async () => {
        const pending = await db.outbox.get(fileId);
        if (pending === undefined) {
          return { reverted: null, hadPending: false };
        }
        await db.outbox.delete(fileId);
        if (pending.baseText !== undefined) {
          await db.files.put({
            fileId,
            text: pending.baseText,
            revision: pending.baseRevision,
            updatedAt: Date.now(),
          });
          return {
            reverted: { text: pending.baseText, revision: pending.baseRevision },
            hadPending: true,
          };
        }
        await db.files.delete(fileId);
        return { reverted: null, hadPending: true };
      });
    },
    { reverted: null, hadPending: false },
  );
}

/**
 * Forgets the current vault's cached folders, notes, pending edits and Drive cursors while keeping
 * the signed-in account (vault switch). The cloud state stamp goes too, so the new vault adopts the
 * cloud's state.
 */
export function clearVaultCache(): Promise<void> {
  customCssCacheGeneration += 1;
  clearCloudStateStamp();
  return safe(async (db) => {
    await db.transaction("rw", [db.meta, db.folders, db.files, db.outbox, db.ops], async () => {
      await db.folders.clear();
      await db.files.clear();
      await db.outbox.clear();
      await db.ops.clear();
      await db.meta.bulkDelete([...ACCOUNT_SCOPED_META_KEYS]);
      const existing = (await db.meta.get("account")) as CachedAccount | undefined;
      if (existing !== undefined) {
        await db.meta.put({ ...existing, root: null, updatedAt: Date.now() });
      }
    });
  }, undefined);
}

/** Empties the local note cache, and deletes the attachment images cached on this device. */
export function clearLocalCache(): Promise<void> {
  customCssCacheGeneration += 1;
  clearCloudStateStamp();
  void clearCachedImages();
  return safe(async (db) => {
    await db.transaction("rw", [db.meta, db.folders, db.files, db.outbox, db.ops], async () => {
      await db.meta.clear();
      await db.folders.clear();
      await db.files.clear();
      await db.outbox.clear();
      await db.ops.clear();
    });
  }, undefined);
}

/** Whether IndexedDB currently holds any unsynced edits (`outbox`) or structural operations (`ops`). */
export function hasPersistedPendingWork(): Promise<boolean> {
  return safe(async (db) => (await db.outbox.count()) + (await db.ops.count()) > 0, false);
}

/** Reads every persisted structural operation in strict FIFO `++seq` order. */
export function readAllPendingOps(): Promise<PendingOp[]> {
  return safe((db) => db.ops.orderBy("seq").toArray(), []);
}

/** Deletes a single persisted structural operation by its stable `opId`. */
export function deletePendingOp(opId: string): Promise<PendingOp | undefined> {
  return safe(async (db) => {
    return await db.transaction("rw", db.ops, async () => {
      const all = await db.ops.orderBy("seq").toArray();
      const target = all.find((op) => op.opId === opId);
      if (target?.seq !== undefined) {
        await db.ops.delete(target.seq);
      }
      return target;
    });
  }, undefined);
}

export interface EnqueueOrCoalesceOptions {
  /** Never mutate or fold into the op currently executing over HTTP. */
  inFlightOpId?: string | null;
  /** Additional descendant folder ids known from React Query (for `delete_folder`). */
  knownDescendantFolderIds?: readonly string[];
  /** Additional descendant file ids known from React Query (for `delete_folder`). */
  knownDescendantFileIds?: readonly string[];
}

export interface EnqueueOrCoalesceResult {
  /** All remaining pending ops in strict FIFO `seq` order after the transaction. */
  ops: PendingOp[];
  /** The inserted or updated op, or `null` when coalescing cancelled the op out (0 network calls). */
  activeOp: PendingOp | null;
  /** Op ids that were removed/cancelled during coalescing. */
  cancelledOpIds: string[];
  /** Unsynced `local:` file ids cancelled by a delete. */
  cancelledLocalFileIds: string[];
  /** Unsynced `local:` folder ids cancelled by a delete. */
  cancelledLocalFolderIds: string[];
  /** All file ids deleted from local storage by a `delete_file` / `delete_folder`. */
  deletedFileIds: string[];
  /** All folder ids deleted from local storage by a `delete_folder`. */
  deletedFolderIds: string[];
  /** New `delete_file` / `delete_folder` ops emitted for real items inside a deleted subtree. */
  emittedDeleteOps: PendingOp[];
}

function opHasParentId(
  op: PendingOp,
): op is Extract<
  PendingOp,
  { kind: "create_file" | "create_folder" | "move_file" | "move_folder" }
> {
  return (
    op.kind === "create_file" ||
    op.kind === "create_folder" ||
    op.kind === "move_file" ||
    op.kind === "move_folder"
  );
}

function parentCreatedAfter(all: readonly PendingOp[], parentId: string, seq: number): boolean {
  return all.some(
    (o) => o.kind === "create_folder" && o.targetId === parentId && (o.seq ?? 0) > seq,
  );
}

function hasChildOpsAfter(all: readonly PendingOp[], folderId: string, seq: number): boolean {
  const tracked = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of all) {
      if ((o.seq ?? 0) <= seq) {
        continue;
      }
      if (opHasParentId(o) && tracked.has(o.parentId)) {
        if (o.kind === "create_folder" || o.kind === "move_folder") {
          if (!tracked.has(o.targetId)) {
            tracked.add(o.targetId);
            grew = true;
          }
        }
        return true;
      }
    }
  }
  return false;
}

function hasInterveningNameClash(
  all: readonly PendingOp[],
  afterSeq: number,
  targetParentId: string,
  targetName: string,
  selfTargetId: string,
): boolean {
  const lower = targetName.toLowerCase();
  for (const o of all) {
    if ((o.seq ?? 0) <= afterSeq || o.targetId === selfTargetId) {
      continue;
    }
    if (opHasParentId(o) && o.parentId === targetParentId) {
      const opName = o.kind === "create_file" || o.kind === "create_folder" ? o.name : o.targetName;
      if (opName.toLowerCase() === lower) {
        return true;
      }
    }
    if (
      (o.kind === "rename_file" || o.kind === "rename_folder") &&
      o.name.toLowerCase() === lower
    ) {
      return true;
    }
  }
  return false;
}

async function removeIdsFromDbFolders(
  db: MarkyardDB,
  removeIds: ReadonlySet<string>,
  now: number,
): Promise<void> {
  if (removeIds.size === 0) {
    return;
  }
  const folders = await db.folders.toArray();
  for (const folder of folders) {
    const filtered = folder.nodes.filter((n) => !removeIds.has(n.id));
    if (filtered.length !== folder.nodes.length) {
      await db.folders.put({ folderId: folder.folderId, nodes: filtered, updatedAt: now });
    }
  }
}

async function readFileSnapshotInTx(
  db: MarkyardDB,
  fileId: string,
): Promise<{ text: string; revision: string } | undefined> {
  const outbox = await db.outbox.get(fileId);
  if (outbox !== undefined) {
    return { text: outbox.text, revision: outbox.baseRevision };
  }
  const file = await db.files.get(fileId);
  return file === undefined ? undefined : { text: file.text, revision: file.revision };
}

async function readSubtreeSnapshotInTx(
  db: MarkyardDB,
  folderIds: readonly string[],
  fileIds: readonly string[],
): Promise<DeletedSubtreeSnapshot> {
  const folders: { folderId: string; nodes: DriveNode[] }[] = [];
  for (const fid of folderIds) {
    const row = await db.folders.get(fid);
    if (row !== undefined) {
      folders.push({ folderId: row.folderId, nodes: row.nodes });
    }
  }
  const files: { fileId: string; text: string; revision: string }[] = [];
  for (const fileId of fileIds) {
    const snap = await readFileSnapshotInTx(db, fileId);
    if (snap !== undefined) {
      files.push({ fileId, text: snap.text, revision: snap.revision });
    }
  }
  return { folders, files };
}

/**
 * Enqueues a structural operation into `db.ops`, coalescing or cancelling against existing
 * mutable queued operations inside a single Dexie `rw` transaction.
 */
export function enqueueOrCoalesceOp(
  incoming: PendingOp,
  options?: EnqueueOrCoalesceOptions,
): Promise<EnqueueOrCoalesceResult> {
  const fallback: EnqueueOrCoalesceResult = {
    ops: [incoming],
    activeOp: incoming,
    cancelledOpIds: [],
    cancelledLocalFileIds: [],
    cancelledLocalFolderIds: [],
    deletedFileIds: [],
    deletedFolderIds: [],
    emittedDeleteOps: [],
  };

  return safe(async (db) => {
    return await db.transaction("rw", [db.folders, db.files, db.outbox, db.ops], async () => {
      const inFlightOpId = options?.inFlightOpId ?? null;
      const isMutable = (o: PendingOp) => o.opId !== inFlightOpId;
      const now = incoming.updatedAt;
      const all = await db.ops.orderBy("seq").toArray();

      const cancelledOpIds: string[] = [];
      const cancelledLocalFileIds: string[] = [];
      const cancelledLocalFolderIds: string[] = [];
      const deletedFileIds: string[] = [];
      const deletedFolderIds: string[] = [];
      const emittedDeleteOps: PendingOp[] = [];
      let activeOp: PendingOp | null = null;

      // Index of the last in-flight op for `targetId`, if any; mutable ops before it cannot be folded.
      const lastInFlightSeqFor = (targetId: string): number => {
        if (inFlightOpId === null) {
          return -1;
        }
        const hit = all.find((o) => o.opId === inFlightOpId && o.targetId === targetId);
        return hit?.seq ?? -1;
      };

      const addOp = async (opToAdd: PendingOp): Promise<PendingOp> => {
        const { seq: _ignored, ...withoutSeq } = opToAdd;
        const seq = await db.ops.add(withoutSeq as PendingOp);
        return { ...(withoutSeq as PendingOp), seq };
      };

      if (incoming.kind === "create_file" || incoming.kind === "create_folder") {
        activeOp = await addOp(incoming);
      } else if (incoming.kind === "rename_file" || incoming.kind === "rename_folder") {
        const createKind = incoming.kind === "rename_file" ? "create_file" : "create_folder";
        const barrier = lastInFlightSeqFor(incoming.targetId);
        const mutableCreate = all.find(
          (o): o is Extract<PendingOp, { kind: "create_file" | "create_folder" }> =>
            o.kind === createKind &&
            o.targetId === incoming.targetId &&
            isMutable(o) &&
            (o.seq ?? 0) > barrier,
        );
        if (mutableCreate !== undefined && mutableCreate.seq !== undefined) {
          const updated: PendingOp =
            mutableCreate.kind === "create_file"
              ? {
                  ...mutableCreate,
                  name: incoming.name,
                  targetName: incoming.name,
                  autoSuffixOnConflict: false,
                  updatedAt: now,
                }
              : {
                  ...mutableCreate,
                  name: incoming.name,
                  targetName: incoming.name,
                  updatedAt: now,
                };
          await db.ops.put(updated);
          // Keep `targetName` fresh on any subsequent mutable ops for the same item.
          for (const other of all) {
            if (
              other.seq !== undefined &&
              other.seq > mutableCreate.seq &&
              other.targetId === incoming.targetId &&
              isMutable(other)
            ) {
              await db.ops.put({ ...other, targetName: incoming.name, updatedAt: now });
            }
          }
          activeOp = updated;
        } else {
          const mutableRenames = all.filter(
            (o): o is Extract<PendingOp, { kind: "rename_file" | "rename_folder" }> =>
              o.kind === incoming.kind &&
              o.targetId === incoming.targetId &&
              isMutable(o) &&
              (o.seq ?? 0) > barrier,
          );
          const existing = mutableRenames[mutableRenames.length - 1];
          if (existing !== undefined && existing.seq !== undefined) {
            if (incoming.name === existing.previousName) {
              await db.ops.delete(existing.seq);
              cancelledOpIds.push(existing.opId);
              activeOp = null;
            } else {
              const updated: PendingOp = {
                ...existing,
                name: incoming.name,
                targetName: incoming.name,
                updatedAt: now,
              };
              await db.ops.put(updated);
              activeOp = updated;
            }
          } else {
            activeOp = await addOp(incoming);
          }
          // Keep `targetName` fresh on any subsequent mutable ops (e.g. move) for the same item.
          for (const other of all) {
            if (
              other.seq !== undefined &&
              other.seq > barrier &&
              other.targetId === incoming.targetId &&
              other.kind !== incoming.kind &&
              isMutable(other)
            ) {
              await db.ops.put({ ...other, targetName: incoming.name, updatedAt: now });
            }
          }
        }
      } else if (incoming.kind === "move_file" || incoming.kind === "move_folder") {
        const createKind = incoming.kind === "move_file" ? "create_file" : "create_folder";
        const barrier = lastInFlightSeqFor(incoming.targetId);
        const mutableCreate = all.find(
          (o): o is Extract<PendingOp, { kind: "create_file" | "create_folder" }> =>
            o.kind === createKind &&
            o.targetId === incoming.targetId &&
            isMutable(o) &&
            (o.seq ?? 0) > barrier,
        );
        if (mutableCreate !== undefined && mutableCreate.seq !== undefined) {
          const parentAfter = parentCreatedAfter(all, incoming.parentId, mutableCreate.seq);
          if (!parentAfter) {
            const updated: PendingOp = {
              ...mutableCreate,
              parentId: incoming.parentId,
              updatedAt: now,
            };
            await db.ops.put(updated);
            activeOp = updated;
          } else if (
            mutableCreate.kind === "create_file" ||
            !hasChildOpsAfter(all, mutableCreate.targetId, mutableCreate.seq)
          ) {
            await db.ops.delete(mutableCreate.seq);
            activeOp = await addOp({
              ...mutableCreate,
              parentId: incoming.parentId,
              updatedAt: now,
            });
          } else {
            // `create_folder` already has child ops referencing its id: keep it before children
            // and append a follow-up `move_folder` instead.
            activeOp = await addOp(incoming);
          }
        } else {
          const mutableMoves = all.filter(
            (o): o is Extract<PendingOp, { kind: "move_file" | "move_folder" }> =>
              o.kind === incoming.kind &&
              o.targetId === incoming.targetId &&
              isMutable(o) &&
              (o.seq ?? 0) > barrier,
          );
          const existing = mutableMoves[mutableMoves.length - 1];
          if (existing !== undefined && existing.seq !== undefined) {
            const returnsHome =
              existing.previousParentId !== undefined &&
              incoming.parentId === existing.previousParentId;
            if (
              returnsHome &&
              !hasInterveningNameClash(
                all,
                existing.seq,
                incoming.parentId,
                incoming.targetName,
                incoming.targetId,
              )
            ) {
              await db.ops.delete(existing.seq);
              cancelledOpIds.push(existing.opId);
              activeOp = null;
            } else {
              const parentAfter = parentCreatedAfter(all, incoming.parentId, existing.seq);
              const updated: PendingOp = {
                ...existing,
                parentId: incoming.parentId,
                targetName: incoming.targetName,
                updatedAt: now,
              };
              if (parentAfter) {
                await db.ops.delete(existing.seq);
                activeOp = await addOp(updated);
              } else {
                await db.ops.put(updated);
                activeOp = updated;
              }
            }
          } else {
            activeOp = await addOp(incoming);
          }
        }
      } else if (incoming.kind === "delete_file") {
        const targetId = incoming.targetId;
        const createOp = all.find((o) => o.kind === "create_file" && o.targetId === targetId);
        const snapshotFile = incoming.previousFile ?? (await readFileSnapshotInTx(db, targetId));

        if (createOp !== undefined && isMutable(createOp)) {
          // Rule 3: deleting an un-flushed local file cancels it with 0 network calls.
          for (const o of all) {
            if (o.targetId === targetId && isMutable(o) && o.seq !== undefined) {
              await db.ops.delete(o.seq);
              cancelledOpIds.push(o.opId);
            }
          }
          await db.outbox.delete(targetId);
          await db.files.delete(targetId);
          await removeIdsFromDbFolders(db, new Set([targetId]), now);
          cancelledLocalFileIds.push(targetId);
          deletedFileIds.push(targetId);
          activeOp = null;
        } else {
          // Real file OR create_file is currently in-flight.
          const mutableOps = all.filter((o) => o.targetId === targetId && isMutable(o));
          let previousParentId = incoming.previousParentId;
          let previousNode = incoming.previousNode;
          let alreadyHasDelete = false;
          for (const o of mutableOps) {
            if (o.kind === "rename_file" && previousNode !== undefined) {
              // Earliest rename holds the original Drive name for Discard rollback.
              previousNode = { ...previousNode, name: o.previousName };
              break;
            }
          }
          for (const o of mutableOps) {
            if (o.kind === "move_file" && o.previousParentId !== undefined) {
              previousParentId = o.previousParentId;
              break;
            }
          }
          for (const o of mutableOps) {
            if (o.kind === "delete_file") {
              alreadyHasDelete = true;
              activeOp = o;
              continue;
            }
            if (o.seq !== undefined) {
              await db.ops.delete(o.seq);
              cancelledOpIds.push(o.opId);
            }
          }
          await db.outbox.delete(targetId);
          await db.files.delete(targetId);
          await removeIdsFromDbFolders(db, new Set([targetId]), now);
          deletedFileIds.push(targetId);
          if (!alreadyHasDelete) {
            activeOp = await addOp({
              ...incoming,
              previousParentId,
              previousNode,
              previousFile: snapshotFile,
            });
          }
        }
      } else if (incoming.kind === "delete_folder") {
        const rootFolderId = incoming.targetId;
        const cachedFolders = await db.folders.toArray();
        const childrenByFolder = new Map<string, DriveNode[]>();
        const nodeById = new Map<string, DriveNode>();
        const cachedParentById = new Map<string, string>();
        for (const row of cachedFolders) {
          childrenByFolder.set(row.folderId, row.nodes);
          for (const child of row.nodes) {
            nodeById.set(child.id, child);
            cachedParentById.set(child.id, row.folderId);
          }
        }

        // Track each item's latest effective parent from `db.ops` in FIFO order.
        const latestOpParent = new Map<string, string>();
        const earliestMoveByTarget = new Map<
          string,
          Extract<PendingOp, { kind: "move_file" | "move_folder" }>
        >();
        const earliestRenameByTarget = new Map<
          string,
          Extract<PendingOp, { kind: "rename_file" | "rename_folder" }>
        >();
        for (const o of all) {
          if (opHasParentId(o)) {
            latestOpParent.set(o.targetId, o.parentId);
          } else if (o.kind === "delete_file" || o.kind === "delete_folder") {
            latestOpParent.delete(o.targetId);
          }
          if (
            (o.kind === "move_file" || o.kind === "move_folder") &&
            isMutable(o) &&
            !earliestMoveByTarget.has(o.targetId)
          ) {
            earliestMoveByTarget.set(o.targetId, o);
          }
          if (
            (o.kind === "rename_file" || o.kind === "rename_folder") &&
            isMutable(o) &&
            !earliestRenameByTarget.has(o.targetId)
          ) {
            earliestRenameByTarget.set(o.targetId, o);
          }
        }

        // Compute transitive descendant folders & files currently inside `rootFolderId`.
        const folderSet = new Set<string>([rootFolderId]);
        const fileSet = new Set<string>();
        const walkFolder = (fid: string) => {
          const children = childrenByFolder.get(fid);
          if (children === undefined) {
            return;
          }
          for (const child of children) {
            const effectiveParent = latestOpParent.get(child.id);
            if (
              effectiveParent !== undefined &&
              effectiveParent !== fid &&
              !folderSet.has(effectiveParent)
            ) {
              // Item was moved out of this folder in a queued op.
              continue;
            }
            if (child.kind === "folder") {
              if (!folderSet.has(child.id)) {
                folderSet.add(child.id);
                walkFolder(child.id);
              }
            } else {
              fileSet.add(child.id);
            }
          }
        };

        walkFolder(rootFolderId);
        let grew = true;
        while (grew) {
          grew = false;
          for (const o of all) {
            if (!opHasParentId(o)) {
              continue;
            }
            if (latestOpParent.get(o.targetId) !== o.parentId) {
              continue;
            }
            if (!folderSet.has(o.parentId)) {
              continue;
            }
            if (o.kind === "create_folder" || o.kind === "move_folder") {
              if (!folderSet.has(o.targetId)) {
                folderSet.add(o.targetId);
                walkFolder(o.targetId);
                grew = true;
              }
            } else if (!fileSet.has(o.targetId)) {
              fileSet.add(o.targetId);
              grew = true;
            }
          }
          for (const fid of options?.knownDescendantFolderIds ?? []) {
            const eff = latestOpParent.get(fid);
            if (eff !== undefined && !folderSet.has(eff)) {
              continue;
            }
            if (!folderSet.has(fid)) {
              folderSet.add(fid);
              walkFolder(fid);
              grew = true;
            }
          }
        }
        for (const fileId of options?.knownDescendantFileIds ?? []) {
          const eff = latestOpParent.get(fileId);
          if (eff !== undefined && !folderSet.has(eff)) {
            continue;
          }
          fileSet.add(fileId);
        }

        const createRootOp = all.find(
          (o) => o.kind === "create_folder" && o.targetId === rootFolderId,
        );
        const isUnflushedLocalRoot = createRootOp !== undefined && isMutable(createRootOp);

        const folderIdsArr = Array.from(folderSet);
        const fileIdsArr = Array.from(fileSet);

        // Capture full subtree snapshot before deleting local rows (for Discard rollback on real folders).
        const subtreeSnapshot =
          incoming.previousSubtree ?? (await readSubtreeSnapshotInTx(db, folderIdsArr, fileIdsArr));

        // Identify real items that must receive their own `delete_file` / `delete_folder` op
        // because they live outside any real folder being deleted on Drive (either moved into a
        // deleted `local:` folder, or moved from outside into this folder via a queued `move_*`).
        const realIdsNeedingDelete = new Map<string, "file" | "folder">();
        const isCoveredByParentRealDelete = (itemId: string): boolean => {
          let cur = latestOpParent.get(itemId) ?? cachedParentById.get(itemId);
          const seen = new Set<string>();
          while (cur !== undefined && !seen.has(cur)) {
            seen.add(cur);
            if (realIdsNeedingDelete.has(cur)) {
              return true;
            }
            if (!isUnflushedLocalRoot && cur === rootFolderId) {
              return true;
            }
            if (!folderSet.has(cur)) {
              return false;
            }
            cur = latestOpParent.get(cur) ?? cachedParentById.get(cur);
          }
          return false;
        };

        // First check real folders inside `folderSet` (excluding rootFolderId), then real files.
        for (const fid of folderIdsArr) {
          if (fid === rootFolderId || isLocalId(fid)) {
            continue;
          }
          const earliestMove = earliestMoveByTarget.get(fid);
          const movedFromOutside =
            earliestMove !== undefined &&
            (earliestMove.previousParentId === undefined ||
              !folderSet.has(earliestMove.previousParentId));
          const parentId = latestOpParent.get(fid) ?? cachedParentById.get(fid);
          const insideLocalFolder = parentId !== undefined && isLocalId(parentId);
          if (insideLocalFolder || movedFromOutside) {
            realIdsNeedingDelete.set(fid, "folder");
          }
        }
        for (const fileId of fileIdsArr) {
          if (isLocalId(fileId)) {
            continue;
          }
          const earliestMove = earliestMoveByTarget.get(fileId);
          const movedFromOutside =
            earliestMove !== undefined &&
            (earliestMove.previousParentId === undefined ||
              !folderSet.has(earliestMove.previousParentId));
          const parentId = latestOpParent.get(fileId) ?? cachedParentById.get(fileId);
          const insideLocalFolder = parentId !== undefined && isLocalId(parentId);
          if (insideLocalFolder || movedFromOutside) {
            realIdsNeedingDelete.set(fileId, "file");
          }
        }
        // Drop any item whose ancestor is already in `realIdsNeedingDelete` (Drive deletes recursively).
        for (const itemId of Array.from(realIdsNeedingDelete.keys())) {
          if (isCoveredByParentRealDelete(itemId)) {
            realIdsNeedingDelete.delete(itemId);
          }
        }

        // Also check if any descendant has an in-flight `create_*` op: keep that in-flight op
        // and emit a follow-up `delete_*` for it so Drive trashes it once it remaps.
        for (const o of all) {
          if (
            !isMutable(o) &&
            o.targetId !== rootFolderId &&
            (o.kind === "create_file" || o.kind === "create_folder") &&
            (folderSet.has(o.targetId) || fileSet.has(o.targetId))
          ) {
            realIdsNeedingDelete.set(o.targetId, o.kind === "create_folder" ? "folder" : "file");
          }
        }

        // Build emitted delete ops BEFORE deleting db rows so their rollback snapshots are intact.
        for (const [id, kind] of realIdsNeedingDelete) {
          const earliestMove = earliestMoveByTarget.get(id);
          const earliestRename = earliestRenameByTarget.get(id);
          const existingNode = nodeById.get(id);
          const restoredNode =
            existingNode !== undefined && earliestRename !== undefined
              ? { ...existingNode, name: earliestRename.previousName }
              : existingNode;
          const targetName = existingNode?.name ?? earliestMove?.targetName ?? id;
          const previousParentId = earliestMove?.previousParentId ?? cachedParentById.get(id);
          if (kind === "file") {
            const snapFile = await readFileSnapshotInTx(db, id);
            emittedDeleteOps.push({
              opId: makeOpId(),
              kind: "delete_file",
              targetId: id,
              targetName,
              previousParentId,
              previousNode: restoredNode,
              previousFile: snapFile,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            // Collect sub-subtree for this real folder.
            const subFolders = new Set<string>([id]);
            const subFiles = new Set<string>();
            const walkSub = (sfid: string) => {
              for (const child of childrenByFolder.get(sfid) ?? []) {
                if (child.kind === "folder") {
                  if (!subFolders.has(child.id)) {
                    subFolders.add(child.id);
                    walkSub(child.id);
                  }
                } else {
                  subFiles.add(child.id);
                }
              }
            };
            walkSub(id);
            const subSnap = await readSubtreeSnapshotInTx(
              db,
              Array.from(subFolders),
              Array.from(subFiles),
            );
            emittedDeleteOps.push({
              opId: makeOpId(),
              kind: "delete_folder",
              targetId: id,
              targetName,
              previousParentId,
              previousNode: restoredNode,
              previousSubtree: subSnap,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        // Preserve original pre-rename/move snapshot for `rootFolderId` if deleting a real folder.
        let rootPreviousParentId = incoming.previousParentId;
        let rootPreviousNode = incoming.previousNode;
        const rootEarliestRename = earliestRenameByTarget.get(rootFolderId);
        if (rootEarliestRename !== undefined && rootPreviousNode !== undefined) {
          rootPreviousNode = { ...rootPreviousNode, name: rootEarliestRename.previousName };
        }
        const rootEarliestMove = earliestMoveByTarget.get(rootFolderId);
        if (rootEarliestMove?.previousParentId !== undefined) {
          rootPreviousParentId = rootEarliestMove.previousParentId;
        }

        // Cancel all mutable ops targeting any folder or file inside the deleted subtree.
        let alreadyHasRootDelete = false;
        for (const o of all) {
          if (!isMutable(o) || o.seq === undefined) {
            continue;
          }
          if (o.targetId === rootFolderId && o.kind === "delete_folder" && !isUnflushedLocalRoot) {
            alreadyHasRootDelete = true;
            activeOp = o;
            continue;
          }
          if (folderSet.has(o.targetId) || fileSet.has(o.targetId)) {
            await db.ops.delete(o.seq);
            cancelledOpIds.push(o.opId);
          }
        }

        for (const fid of folderIdsArr) {
          deletedFolderIds.push(fid);
          if (isLocalId(fid)) {
            cancelledLocalFolderIds.push(fid);
          }
        }
        for (const fileId of fileIdsArr) {
          deletedFileIds.push(fileId);
          if (isLocalId(fileId)) {
            cancelledLocalFileIds.push(fileId);
          }
        }

        // Delete cached folders, files, outbox entries, and remove rootFolderId from its parent.
        if (folderIdsArr.length > 0) {
          await db.folders.bulkDelete(folderIdsArr);
        }
        if (fileIdsArr.length > 0) {
          await db.files.bulkDelete(fileIdsArr);
          await db.outbox.bulkDelete(fileIdsArr);
        }
        await removeIdsFromDbFolders(db, new Set([rootFolderId]), now);

        // Insert emitted delete ops for real items moved into the deleted subtree.
        const addedEmitted: PendingOp[] = [];
        for (const emitted of emittedDeleteOps) {
          addedEmitted.push(await addOp(emitted));
        }
        emittedDeleteOps.length = 0;
        emittedDeleteOps.push(...addedEmitted);

        if (!isUnflushedLocalRoot && !alreadyHasRootDelete) {
          activeOp = await addOp({
            ...incoming,
            previousParentId: rootPreviousParentId,
            previousNode: rootPreviousNode,
            previousSubtree: subtreeSnapshot,
          });
        }
      }

      const ops = await db.ops.orderBy("seq").toArray();
      return {
        ops,
        activeOp,
        cancelledOpIds,
        cancelledLocalFileIds,
        cancelledLocalFolderIds,
        deletedFileIds,
        deletedFolderIds,
        emittedDeleteOps,
      };
    });
  }, fallback);
}

export interface RemapLocalIdOptions {
  completedOpId: string;
  localId: string;
  realNode: DriveNode;
  revision?: string;
  sentText?: string;
  sentSeq?: number;
  adoptedExisting?: boolean;
}

export interface RemapLocalIdResult {
  hasChainedOutbox: boolean;
  chainedText?: string;
  hasFollowUpRename: boolean;
  displayNode: DriveNode;
  rewrittenOps: PendingOp[];
}

function rewriteOpIdReferences(op: PendingOp, localId: string, realId: string): PendingOp {
  let changed = false;
  const next: Record<string, unknown> = { ...op };
  if (op.targetId === localId) {
    next.targetId = realId;
    changed = true;
  }
  if ("parentId" in op && op.parentId === localId) {
    next.parentId = realId;
    changed = true;
  }
  if ("previousParentId" in op && op.previousParentId === localId) {
    next.previousParentId = realId;
    changed = true;
  }
  if ("previousNode" in op && op.previousNode?.id === localId) {
    next.previousNode = { ...op.previousNode, id: realId };
    changed = true;
  }
  if ("previousSubtree" in op && op.previousSubtree !== undefined) {
    let subChanged = false;
    const folders = op.previousSubtree.folders.map((f) => {
      const fIdChanged = f.folderId === localId;
      const nodesChanged = f.nodes.some((n) => n.id === localId);
      if (!fIdChanged && !nodesChanged) {
        return f;
      }
      subChanged = true;
      return {
        folderId: fIdChanged ? realId : f.folderId,
        nodes: f.nodes.map((n) => (n.id === localId ? { ...n, id: realId } : n)),
      };
    });
    const files = op.previousSubtree.files.map((f) => {
      if (f.fileId !== localId) {
        return f;
      }
      subChanged = true;
      return { ...f, fileId: realId };
    });
    if (subChanged) {
      next.previousSubtree = { folders, files };
      changed = true;
    }
  }
  return changed ? (next as unknown as PendingOp) : op;
}

/**
 * Atomically remaps a temporary `local:<uuid>` to Drive's real id across `folders`, `files`,
 * `outbox`, and `ops` inside a single Dexie `rw` transaction.
 */
export function remapLocalIdInDb(options: RemapLocalIdOptions): Promise<RemapLocalIdResult> {
  const fallback: RemapLocalIdResult = {
    hasChainedOutbox: false,
    hasFollowUpRename: false,
    displayNode: options.realNode,
    rewrittenOps: [],
  };

  return safe(async (db) => {
    return await db.transaction("rw", [db.folders, db.files, db.outbox, db.ops], async () => {
      const {
        completedOpId,
        localId,
        realNode,
        revision = "",
        sentText = "",
        sentSeq,
        adoptedExisting = false,
      } = options;
      const now = Date.now();

      // 1. Delete completed create_* op and rewrite remaining ops referencing `localId`.
      const allOps = await db.ops.orderBy("seq").toArray();
      let latestFollowUpRename: string | undefined;
      for (const op of allOps) {
        if (op.opId === completedOpId) {
          if (op.seq !== undefined) {
            await db.ops.delete(op.seq);
          }
          continue;
        }
        if (op.targetId === localId && (op.kind === "rename_file" || op.kind === "rename_folder")) {
          latestFollowUpRename = op.name;
        }
        const rewritten = rewriteOpIdReferences(op, localId, realNode.id);
        if (rewritten !== op) {
          await db.ops.put(rewritten);
        }
      }

      const hasFollowUpRename = latestFollowUpRename !== undefined;
      const displayNode: DriveNode = hasFollowUpRename
        ? { ...realNode, name: latestFollowUpRename! }
        : realNode;

      // 2. Update `db.folders` listings and (for folders) move `db.folders[localId]` -> `realNode.id`.
      const cachedFolders = await db.folders.toArray();
      for (const folder of cachedFolders) {
        if (folder.folderId === localId) {
          continue;
        }
        const hasLocal = folder.nodes.some((n) => n.id === localId);
        if (hasLocal) {
          const deduped: DriveNode[] = [];
          let inserted = false;
          for (const n of folder.nodes) {
            if (n.id === localId) {
              if (!inserted) {
                deduped.push(displayNode);
                inserted = true;
              }
            } else if (n.id === realNode.id) {
              if (!inserted) {
                deduped.push(displayNode);
                inserted = true;
              }
            } else {
              deduped.push(n);
            }
          }
          await db.folders.put({ folderId: folder.folderId, nodes: deduped, updatedAt: now });
        }
      }
      if (realNode.kind === "folder") {
        const localFolder = await db.folders.get(localId);
        if (localFolder !== undefined) {
          await db.folders.delete(localId);
          const existingReal = await db.folders.get(realNode.id);
          if (existingReal !== undefined) {
            const byId = new Map<string, DriveNode>();
            for (const n of existingReal.nodes) {
              byId.set(n.id, n);
            }
            for (const n of localFolder.nodes) {
              if (!byId.has(n.id)) {
                byId.set(n.id, n);
              }
            }
            await db.folders.put({
              folderId: realNode.id,
              nodes: Array.from(byId.values()),
              updatedAt: now,
            });
          } else {
            await db.folders.put({
              folderId: realNode.id,
              nodes: localFolder.nodes,
              updatedAt: now,
            });
          }
        }
      }

      // 3. Update `db.files` and `db.outbox` (for files).
      let hasChainedOutbox = false;
      let chainedText: string | undefined;
      if (realNode.kind !== "folder") {
        await db.files.delete(localId);
        const outbox = await db.outbox.get(localId);
        if (adoptedExisting) {
          if (outbox !== undefined) {
            await db.outbox.delete(localId);
          }
        } else if (outbox === undefined || (sentSeq !== undefined && outbox.seq === sentSeq)) {
          if (outbox !== undefined) {
            await db.outbox.delete(localId);
          }
          await db.files.put({
            fileId: realNode.id,
            text: sentText,
            revision,
            updatedAt: now,
          });
        } else {
          // Newer local edit arrived mid-POST: move outbox onto `realNode.id` with fresh base ETag.
          await db.outbox.delete(localId);
          await db.outbox.put({
            ...outbox,
            fileId: realNode.id,
            baseRevision: revision,
            baseText: sentText,
            updatedAt: now,
          });
          await db.files.put({
            fileId: realNode.id,
            text: outbox.text,
            revision,
            updatedAt: now,
          });
          hasChainedOutbox = true;
          chainedText = outbox.text;
        }
      }

      const rewrittenOps = await db.ops.orderBy("seq").toArray();
      return {
        hasChainedOutbox,
        chainedText,
        hasFollowUpRename,
        displayNode,
        rewrittenOps,
      };
    });
  }, fallback);
}

/** Restores a locally deleted file back into IndexedDB (`folders` and `files`) on Discard. */
export function restoreDeletedFileInDb(
  op: Extract<PendingOp, { kind: "delete_file" }>,
): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", [db.folders, db.files], async () => {
      const now = Date.now();
      if (op.previousParentId !== undefined && op.previousNode !== undefined) {
        const parent = await db.folders.get(op.previousParentId);
        if (parent !== undefined) {
          const next = [
            ...parent.nodes.filter((n) => n.id !== op.previousNode!.id),
            op.previousNode,
          ];
          await db.folders.put({ folderId: op.previousParentId, nodes: next, updatedAt: now });
        }
      }
      if (op.previousFile !== undefined) {
        await db.files.put({
          fileId: op.targetId,
          text: op.previousFile.text,
          revision: op.previousFile.revision,
          updatedAt: now,
        });
      }
    });
  }, undefined);
}

/** Restores a locally deleted folder subtree back into IndexedDB (`folders` and `files`) on Discard. */
export function restoreDeletedSubtreeInDb(
  op: Extract<PendingOp, { kind: "delete_folder" }>,
): Promise<void> {
  return safe(async (db) => {
    await db.transaction("rw", [db.folders, db.files], async () => {
      const now = Date.now();
      if (op.previousParentId !== undefined && op.previousNode !== undefined) {
        const parent = await db.folders.get(op.previousParentId);
        if (parent !== undefined) {
          const next = [
            ...parent.nodes.filter((n) => n.id !== op.previousNode!.id),
            op.previousNode,
          ];
          await db.folders.put({ folderId: op.previousParentId, nodes: next, updatedAt: now });
        }
      }
      if (op.previousSubtree !== undefined) {
        for (const folder of op.previousSubtree.folders) {
          await db.folders.put({
            folderId: folder.folderId,
            nodes: folder.nodes,
            updatedAt: now,
          });
        }
        for (const file of op.previousSubtree.files) {
          await db.files.put({
            fileId: file.fileId,
            text: file.text,
            revision: file.revision,
            updatedAt: now,
          });
        }
      }
    });
  }, undefined);
}

/**
 * Discards a pending op from `db.ops` and returns the removed op along with any dependent
 * cancelled ops (e.g. discarding a `create_file` or `create_folder` also drops its children's ops).
 */
export function discardPendingOpInDb(opId: string): Promise<{
  discarded: PendingOp | null;
  cancelledOpIds: string[];
  removedLocalFileIds: string[];
  removedLocalFolderIds: string[];
  restoredMoves: { id: string; kind: "file" | "folder"; toParentId: string; node?: DriveNode }[];
  remainingOps: PendingOp[];
}> {
  const fallback = {
    discarded: null,
    cancelledOpIds: [],
    removedLocalFileIds: [],
    removedLocalFolderIds: [],
    restoredMoves: [],
    remainingOps: [],
  };

  return safe(async (db) => {
    return await db.transaction("rw", [db.folders, db.files, db.outbox, db.ops], async () => {
      const all = await db.ops.orderBy("seq").toArray();
      const target = all.find((o) => o.opId === opId);
      if (target === undefined || target.seq === undefined) {
        return { ...fallback, remainingOps: all };
      }

      const now = Date.now();
      const cancelledOpIds: string[] = [target.opId];
      const removedLocalFileIds: string[] = [];
      const removedLocalFolderIds: string[] = [];
      const restoredMoves: {
        id: string;
        kind: "file" | "folder";
        toParentId: string;
        node?: DriveNode;
      }[] = [];

      if (target.kind === "create_file") {
        for (const o of all) {
          if (o.targetId === target.targetId && o.seq !== undefined) {
            await db.ops.delete(o.seq);
            if (o.opId !== target.opId) {
              cancelledOpIds.push(o.opId);
            }
          }
        }
        await db.files.delete(target.targetId);
        await db.outbox.delete(target.targetId);
        await removeIdsFromDbFolders(db, new Set([target.targetId]), now);
        removedLocalFileIds.push(target.targetId);
      } else if (target.kind === "create_folder") {
        const cachedFolders = await db.folders.toArray();
        const childrenByFolder = new Map<string, DriveNode[]>();
        const nodeById = new Map<string, DriveNode>();
        for (const row of cachedFolders) {
          childrenByFolder.set(row.folderId, row.nodes);
          for (const child of row.nodes) {
            nodeById.set(child.id, child);
          }
        }
        const folderSet = new Set<string>([target.targetId]);
        const fileSet = new Set<string>();
        const walk = (fid: string) => {
          for (const child of childrenByFolder.get(fid) ?? []) {
            if (child.kind === "folder") {
              if (!folderSet.has(child.id)) {
                folderSet.add(child.id);
                walk(child.id);
              }
            } else {
              fileSet.add(child.id);
            }
          }
        };
        walk(target.targetId);
        let grew = true;
        while (grew) {
          grew = false;
          for (const o of all) {
            if (opHasParentId(o) && folderSet.has(o.parentId)) {
              if (o.kind === "create_folder" || o.kind === "move_folder") {
                if (!folderSet.has(o.targetId)) {
                  folderSet.add(o.targetId);
                  walk(o.targetId);
                  grew = true;
                }
              } else if (!fileSet.has(o.targetId)) {
                fileSet.add(o.targetId);
                grew = true;
              }
            }
          }
        }

        // Cancel ops for local descendants; roll back moves of real items back to previousParentId.
        for (const o of all) {
          if (o.seq === undefined) {
            continue;
          }
          if (
            (o.kind === "move_file" || o.kind === "move_folder") &&
            !isLocalId(o.targetId) &&
            folderSet.has(o.parentId)
          ) {
            await db.ops.delete(o.seq);
            cancelledOpIds.push(o.opId);
            if (o.previousParentId !== undefined) {
              const node = nodeById.get(o.targetId);
              restoredMoves.push({
                id: o.targetId,
                kind: o.kind === "move_folder" ? "folder" : "file",
                toParentId: o.previousParentId,
                node,
              });
              if (node !== undefined) {
                const dest = await db.folders.get(o.previousParentId);
                if (dest !== undefined) {
                  await db.folders.put({
                    folderId: o.previousParentId,
                    nodes: [...dest.nodes.filter((n) => n.id !== node.id), node],
                    updatedAt: now,
                  });
                }
              }
            }
            continue;
          }
          if (
            (folderSet.has(o.targetId) && isLocalId(o.targetId)) ||
            (fileSet.has(o.targetId) && isLocalId(o.targetId)) ||
            o.opId === target.opId
          ) {
            await db.ops.delete(o.seq);
            if (o.opId !== target.opId) {
              cancelledOpIds.push(o.opId);
            }
          }
        }

        const localFolders = Array.from(folderSet).filter(
          (id) => isLocalId(id) || id === target.targetId,
        );
        const localFiles = Array.from(fileSet).filter((id) => isLocalId(id));
        if (localFolders.length > 0) {
          await db.folders.bulkDelete(localFolders);
          removedLocalFolderIds.push(...localFolders);
        }
        if (localFiles.length > 0) {
          await db.files.bulkDelete(localFiles);
          await db.outbox.bulkDelete(localFiles);
          removedLocalFileIds.push(...localFiles);
        }
        await removeIdsFromDbFolders(db, new Set([target.targetId]), now);
      } else {
        await db.ops.delete(target.seq);
        if (target.kind === "rename_file" || target.kind === "rename_folder") {
          const laterRename = all.find(
            (o) =>
              o.seq !== undefined &&
              o.seq > target.seq! &&
              o.targetId === target.targetId &&
              o.kind === target.kind,
          );
          if (laterRename !== undefined) {
            await db.ops.put({ ...laterRename, previousName: target.previousName } as PendingOp);
          }
        }
      }

      const remainingOps = await db.ops.orderBy("seq").toArray();
      return {
        discarded: target,
        cancelledOpIds,
        removedLocalFileIds,
        removedLocalFolderIds,
        restoredMoves,
        remainingOps,
      };
    });
  }, fallback);
}

/**
 * Seeds React Query with locally cached data (marked stale via `CACHE_STALE_TIMESTAMP`) without
 * overwriting any data that has already arrived from the network, so the UI opens immediately
 * from IndexedDB while still revalidating against Drive in the background.
 * Returns the cached `Session` when one exists, or `null` otherwise.
 */
export async function hydrateQueryClient(
  queryClient: QueryClient,
  openFileId: string | null,
  options?: {
    preserveOnUnauthenticated?: boolean;
    isStale?: () => boolean;
    expectedEmail?: () => string | null;
  },
): Promise<Session | null> {
  const account = await readCachedAccount();
  const isMismatched = (email: string) => {
    const expected = options?.expectedEmail?.() ?? null;
    return expected !== null && expected !== email;
  };
  if (account === undefined || options?.isStale?.() === true || isMismatched(account.email)) {
    return null;
  }

  const preserveOnUnauthenticated = options?.preserveOnUnauthenticated === true;

  const seedIfEmpty = <T>(
    key: readonly unknown[],
    value: T,
    allowWhenUnauthenticated = preserveOnUnauthenticated,
  ) => {
    const state = queryClient.getQueryState(key);
    if (
      state?.data !== undefined ||
      (!allowWhenUnauthenticated && isUnauthenticated(state?.error))
    ) {
      return;
    }
    queryClient.setQueryData(key, value, { updatedAt: CACHE_STALE_TIMESTAMP });
  };

  const session: Session = {
    email: account.email,
    ...(account.name !== undefined ? { name: account.name } : {}),
    ...(account.cloudSync === true ? { cloudSync: true } : {}),
  };
  // Never clear an already-recorded 401 error on `["session"]`: the caller receives `session`
  // directly so it can keep unsynced work visible while still showing the session-ended banner.
  seedIfEmpty(["session"], session, false);
  if (account.root !== null) {
    seedIfEmpty(["root"], account.root);
  }

  const [folders, file] = await Promise.all([
    readAllCachedFolders(),
    openFileId !== null ? readCachedFile(openFileId) : Promise.resolve(undefined),
  ]);

  if (options?.isStale?.() === true || isMismatched(account.email)) {
    return null;
  }

  for (const folder of folders) {
    seedIfEmpty(childrenKey(folder.folderId), folder.nodes);
  }
  if (openFileId !== null && file !== undefined) {
    seedIfEmpty(["files", openFileId, "content"], file);
  }

  return session;
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
