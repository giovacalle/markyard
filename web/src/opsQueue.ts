import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  createFile as apiCreateFile,
  createFolder as apiCreateFolder,
  deleteFile as apiDeleteFile,
  deleteFolder as apiDeleteFolder,
  fetchChildren,
  isNameExists,
  isNotFound,
  isTransientError,
  isUnauthenticated,
  moveFolder as apiMoveFolder,
  renameFolder as apiRenameFolder,
  type DriveNode,
  type VaultIndex,
} from "./api";
import { removeRecentFile, remapRecentFile } from "./commandSearch";
import { pickUntitledName } from "./fileName";
import {
  CACHE_STALE_TIMESTAMP,
  addCachedChild,
  deleteCachedFile,
  deleteCachedSubtree,
  deletePendingOp,
  discardPendingOpInDb,
  enqueueOrCoalesceOp,
  moveCachedChild,
  readAllPendingOps,
  readCachedFile,
  readPendingWrite,
  remapLocalIdInDb,
  removeCachedChild,
  renameCachedChild,
  restoreDeletedFileInDb,
  restoreDeletedSubtreeInDb,
  writeCachedFile,
  writeCachedFolder,
  type PendingOp,
} from "./localCache";
import { isLocalId, makeLocalId, makeOpId } from "./localIds";
import { remapOpenFileId } from "./openDocument";
import {
  MAX_AUTO_RETRIES,
  retryDelayMs,
  useSyncStates,
  type FileSyncState,
  type SyncQueue,
} from "./syncQueue";
import {
  addChild,
  childrenKey,
  collectDescendantIds,
  findNode,
  getFolderChildNames,
  knownParentId,
  moveChild,
  moveInVaultIndex,
  remapNodeId,
  removeChild,
  removeFromVaultIndex,
  renameChild,
  renameInVaultIndex,
  upsertVaultIndexNode,
} from "./treeCache";
import { remapExpandedFolder } from "./treeExpanded";

export type OpRuntimeStatus =
  | { status: "pending" }
  | { status: "syncing" }
  | {
      status: "error";
      error: unknown;
      /** Set while an automatic retry is scheduled: which attempt comes next, and when. */
      retry?: { attempt: number; maxAttempts: number; at: number };
    };

export interface PendingOpView {
  op: PendingOp;
  state: OpRuntimeStatus;
}

export interface OpsSnapshot {
  ops: readonly PendingOpView[];
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
}

export interface IdRemapEvent {
  localId: string;
  realId: string;
  node: DriveNode;
  kind: "file" | "folder";
}

export interface CreateFileOptions {
  parentId: string;
  /** When omitted, picks `Untitled.md`, `Untitled 2.md`, … and auto-suffixes on 409. */
  name?: string;
  initialContent?: string;
  openExistingOnConflict?: boolean;
  autoSuffixOnConflict?: boolean;
}

export interface CreateFileResult {
  status: "synced" | "queued";
  node: DriveNode;
  revision: string;
  content: string;
  /** `false` when `openExistingOnConflict` adopted an existing remote note instead of creating. */
  created: boolean;
  opId?: string;
}

export interface CreateFolderOptions {
  parentId: string;
  name: string;
  adoptExistingOnConflict?: boolean;
}

export interface CreateFolderResult {
  status: "synced" | "queued";
  node: DriveNode;
  /** `false` when `adoptExistingOnConflict` adopted an existing remote folder. */
  created: boolean;
  opId?: string;
}

export interface RenameResult {
  status: "synced" | "queued";
  node: DriveNode;
  revision?: string;
  opId?: string;
}

export interface MoveNodeInput {
  id: string;
  kind: DriveNode["kind"];
  name?: string;
  fromParentId?: string;
  toParentId: string;
  node?: DriveNode;
}

export interface MoveResult {
  status: "synced" | "queued";
  node: DriveNode;
  revision?: string;
  opId?: string;
}

export interface DeleteResult {
  status: "synced" | "queued" | "cancelled";
  opId?: string;
}

export interface OpsQueueCallbacks {
  onNetworkError?: () => void;
  onNetworkSuccess?: () => void;
  onIdRemapped?: (event: IdRemapEvent) => void;
  onOpDiscarded?: (op: PendingOp) => void;
}

const PENDING_STATUS: OpRuntimeStatus = { status: "pending" };

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function isPermanentOpError(error: unknown): boolean {
  return !isTransientError(error);
}

/** Human-readable label for a queued structural op (used in SyncInspector). */
export function formatPendingOpLabel(op: PendingOp): string {
  switch (op.kind) {
    case "create_file":
      return `Create ${op.name}`;
    case "create_folder":
      return `Create folder ${op.name}`;
    case "rename_file":
    case "rename_folder":
      return `Rename to ${op.name}`;
    case "move_file":
    case "move_folder":
      return `Move ${op.targetName}`;
    case "delete_file":
      return `Delete ${op.targetName}`;
    case "delete_folder":
      return `Delete folder ${op.targetName}`;
  }
}

/**
 * Counts total pending work across structural ops and per-file content edits without
 * double-counting a `local:` note that appears in both `db.ops` (`create_file`) and `db.outbox`.
 */
export function countTotalPendingSync(
  ops: readonly PendingOpView[],
  syncStates: ReadonlyMap<string, FileSyncState>,
): number {
  const pendingCreateFileIds = new Set<string>();
  for (const item of ops) {
    if (item.op.kind === "create_file") {
      pendingCreateFileIds.add(item.op.targetId);
    }
  }
  let extraFileCount = 0;
  for (const [fileId, state] of syncStates) {
    if (
      (state.status === "pending" || state.status === "syncing" || state.status === "error") &&
      !pendingCreateFileIds.has(fileId)
    ) {
      extraFileCount += 1;
    }
  }
  return ops.length + extraFileCount;
}

function nowIso(ts = Date.now()): string {
  return new Date(ts).toISOString();
}

function opTouchesAnyId(op: PendingOp, ids: ReadonlySet<string>): boolean {
  if (ids.has(op.targetId)) {
    return true;
  }
  if ("parentId" in op && ids.has(op.parentId)) {
    return true;
  }
  return false;
}

/**
 * Local-first structural mutation engine backed by Dexie `db.ops`.
 *
 * Implements the Hybrid Eager-Online / Immediate-Local Execution Model:
 * - Offline, or touching a `local:` id, or when queued ops already touch the item/parent:
 *   persists to `db.ops` (with coalescing), applies optimistic local state immediately, and
 *   triggers a background flush when online.
 * - Online with no blocking queued ops: attempts Drive eagerly so permanent validation errors
 *   (`400`, `409`, `404`, `401`) reject inline in open dialogs, while transient failures
 *   (`TypeError`, `408`, `429`, `5xx`) degrade cleanly into a queued op with auto-retry.
 */
export class OpsQueue {
  private readonly queryClient: QueryClient;
  private readonly syncQueue: SyncQueue;
  private readonly onNetworkError?: () => void;
  private readonly onNetworkSuccess?: () => void;
  private readonly onOpDiscarded?: (op: PendingOp) => void;
  private readonly remapListeners = new Set<(event: IdRemapEvent) => void>();
  private readonly listeners = new Set<() => void>();

  private ops: PendingOp[] = [];
  private readonly states = new Map<string, OpRuntimeStatus>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly discardedOpIds = new Set<string>();
  private opChain: Promise<unknown> = Promise.resolve();
  private inFlightOpId: string | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private hydrated = false;
  private globalEpoch = 0;
  private disposed = false;

  private snapshot: OpsSnapshot = {
    ops: [],
    pendingCount: 0,
    failedCount: 0,
    syncing: false,
  };

  constructor(queryClient: QueryClient, syncQueue: SyncQueue, callbacks?: OpsQueueCallbacks) {
    this.queryClient = queryClient;
    this.syncQueue = syncQueue;
    this.onNetworkError = callbacks?.onNetworkError;
    this.onNetworkSuccess = callbacks?.onNetworkSuccess;
    this.onOpDiscarded = callbacks?.onOpDiscarded;
    if (callbacks?.onIdRemapped !== undefined) {
      this.remapListeners.add(callbacks.onIdRemapped);
    }
  }

  /** Subscribes to `localId -> realId` remap events (e.g. for `App.tsx` / `DocumentView` continuity). */
  onIdRemapped(listener: (event: IdRemapEvent) => void): () => void {
    this.remapListeners.add(listener);
    return () => {
      this.remapListeners.delete(listener);
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OpsSnapshot => this.snapshot;

  private emit(): void {
    if (this.disposed) {
      return;
    }
    const views: PendingOpView[] = this.ops.map((op) => ({
      op,
      state: this.states.get(op.opId) ?? PENDING_STATUS,
    }));
    let failedCount = 0;
    let syncing = false;
    for (const view of views) {
      if (view.state.status === "error") {
        failedCount += 1;
      } else if (view.state.status === "syncing") {
        syncing = true;
      }
    }
    this.snapshot = {
      ops: views,
      pendingCount: views.length,
      failedCount,
      syncing,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private emitIdRemapped(event: IdRemapEvent): void {
    for (const listener of this.remapListeners) {
      listener(event);
    }
  }

  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.opChain.catch(() => undefined).then(task);
    this.opChain = next;
    return next;
  }

  private isEpochCurrent(epoch: number): boolean {
    return !this.disposed && this.globalEpoch === epoch;
  }

  private cancelRetry(opId: string): void {
    const timer = this.retryTimers.get(opId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(opId);
    }
  }

  private cancelAllRetries(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  private setOpState(opId: string, state: OpRuntimeStatus): void {
    if (this.disposed) {
      return;
    }
    this.states.set(opId, state);
    this.emit();
  }

  private recordFailure(opId: string, error: unknown): void {
    this.cancelRetry(opId);
    if (isUnauthenticated(error)) {
      this.retryAttempts.delete(opId);
      this.setOpState(opId, { status: "error", error });
      void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      return;
    }
    if (!isOnline() && error instanceof TypeError) {
      this.retryAttempts.delete(opId);
      this.setOpState(opId, PENDING_STATUS);
      return;
    }
    const attempt = (this.retryAttempts.get(opId) ?? 0) + 1;
    if (!isTransientError(error) || attempt > MAX_AUTO_RETRIES) {
      this.retryAttempts.delete(opId);
      this.setOpState(opId, { status: "error", error });
      return;
    }
    this.retryAttempts.set(opId, attempt);
    const delay = retryDelayMs(attempt, error);
    const epoch = this.globalEpoch;
    this.setOpState(opId, {
      status: "error",
      error,
      retry: { attempt, maxAttempts: MAX_AUTO_RETRIES, at: Date.now() + delay },
    });
    this.retryTimers.set(
      opId,
      setTimeout(() => {
        this.retryTimers.delete(opId);
        if (this.isEpochCurrent(epoch) && this.ops.some((o) => o.opId === opId)) {
          void this.flushAll({ automatic: true });
        }
      }, delay),
    );
  }

  private syncOpsFromDb(ops: PendingOp[]): void {
    this.ops = ops;
    const activeIds = new Set(ops.map((o) => o.opId));
    for (const id of Array.from(this.states.keys())) {
      if (!activeIds.has(id)) {
        this.states.delete(id);
        this.cancelRetry(id);
        this.retryAttempts.delete(id);
      }
    }
    for (const op of ops) {
      if (!this.states.has(op.opId)) {
        this.states.set(op.opId, PENDING_STATUS);
      }
    }
  }

  private async ensureHydrated(epoch: number): Promise<void> {
    if (this.hydrated) {
      return;
    }
    const persisted = await readAllPendingOps();
    if (!this.isEpochCurrent(epoch)) {
      return;
    }
    this.hydrated = true;
    this.syncOpsFromDb(persisted);
    if (persisted.length > 0) {
      this.emit();
    }
  }

  /**
   * Loads persisted structural operations from Dexie `db.ops` (rehydrating statuses as `"pending"`)
   * and triggers a background flush when `autoFlush` is true and online.
   */
  async hydrate(autoFlush = false): Promise<void> {
    const epoch = this.globalEpoch;
    await this.runSerialized(async () => {
      const persisted = await readAllPendingOps();
      if (!this.isEpochCurrent(epoch)) {
        return;
      }
      this.hydrated = true;
      this.syncOpsFromDb(persisted);
      this.emit();
    });
    if (autoFlush && this.isEpochCurrent(epoch) && isOnline() && this.ops.length > 0) {
      void this.flushAll();
    }
  }

  private shouldQueueImmediately(ids: readonly (string | undefined)[]): boolean {
    if (!isOnline()) {
      return true;
    }
    const idSet = new Set<string>();
    for (const id of ids) {
      if (id === undefined) {
        continue;
      }
      if (isLocalId(id)) {
        return true;
      }
      idSet.add(id);
    }
    return this.ops.some((op) => opTouchesAnyId(op, idSet));
  }

  /**
   * Creates a Markdown note. Runs eagerly online when no blocking queued ops exist;
   * queues locally when offline, under a `local:` parent, or on transient network/5xx errors.
   */
  async createFile(options: CreateFileOptions): Promise<CreateFileResult> {
    const {
      parentId,
      name,
      initialContent = "",
      openExistingOnConflict = false,
      autoSuffixOnConflict = name === undefined,
    } = options;
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);

    const queueLocally = async (
      candidateName: string,
      transientError?: unknown,
    ): Promise<CreateFileResult> => {
      const now = Date.now();
      const localId = makeLocalId();
      const node: DriveNode = {
        id: localId,
        name: candidateName,
        kind: "markdown",
        modifiedTime: nowIso(now),
      };
      const op: PendingOp = {
        opId: makeOpId(),
        kind: "create_file",
        targetId: localId,
        targetName: candidateName,
        parentId,
        name: candidateName,
        initialContent,
        ...(openExistingOnConflict ? { openExistingOnConflict: true } : {}),
        ...(autoSuffixOnConflict ? { autoSuffixOnConflict: true } : {}),
        createdAt: now,
        updatedAt: now,
      };

      const result = await this.runSerialized(async () => {
        const res = await enqueueOrCoalesceOp(op, { inFlightOpId: this.inFlightOpId });
        await addCachedChild(parentId, node);
        await writeCachedFile(localId, initialContent, "");
        return res;
      });
      if (!this.isEpochCurrent(epoch)) {
        return {
          status: "queued",
          node,
          revision: "",
          content: initialContent,
          created: true,
          opId: op.opId,
        };
      }

      this.addChildOrSeed(parentId, node);
      upsertVaultIndexNode(this.queryClient, parentId, node);
      this.queryClient.setQueryData(["files", localId, "content"], {
        text: initialContent,
        revision: "",
      });

      this.syncOpsFromDb(result.ops);
      if (transientError !== undefined && result.activeOp !== null) {
        this.recordFailure(result.activeOp.opId, transientError);
      } else {
        this.emit();
        if (isOnline()) {
          void this.flushAll();
        }
      }

      return {
        status: "queued",
        node,
        revision: "",
        content: initialContent,
        created: true,
        opId: result.activeOp?.opId ?? op.opId,
      };
    };

    const pickLocalCandidate = (): string => {
      if (name !== undefined) {
        return name;
      }
      return pickUntitledName(getFolderChildNames(this.queryClient, parentId), 1);
    };

    if (this.shouldQueueImmediately([parentId])) {
      return queueLocally(pickLocalCandidate());
    }

    // Case 2: Eager online execution.
    if (name !== undefined && !autoSuffixOnConflict) {
      try {
        const created = await apiCreateFile(parentId, name, initialContent);
        this.onNetworkSuccess?.();
        if (this.isEpochCurrent(epoch)) {
          addChild(this.queryClient, parentId, created.node);
          upsertVaultIndexNode(this.queryClient, parentId, created.node);
          void addCachedChild(parentId, created.node);
          void writeCachedFile(created.node.id, initialContent, created.revision);
          this.syncQueue.observeRemoteRevision(created.node.id, created.revision, initialContent);
          this.queryClient.setQueryData(["files", created.node.id, "content"], {
            text: initialContent,
            revision: created.revision,
          });
        }
        return {
          status: "synced",
          node: created.node,
          revision: created.revision,
          content: initialContent,
          created: true,
        };
      } catch (err) {
        if (openExistingOnConflict && isNameExists(err)) {
          try {
            const rawChildren = await fetchChildren(parentId);
            const children = this.overlayListing(parentId, rawChildren);
            this.queryClient.setQueryData(childrenKey(parentId), children);
            void writeCachedFolder(parentId, children);
            const existing = children.find(
              (n) => n.kind === "markdown" && n.name.toLowerCase() === name.toLowerCase(),
            );
            if (existing !== undefined) {
              return {
                status: "synced",
                node: existing,
                revision: "",
                content: "",
                created: false,
              };
            }
          } catch (lookupErr) {
            if (isTransientError(lookupErr)) {
              if (lookupErr instanceof TypeError) {
                this.onNetworkError?.();
              }
              return queueLocally(name, lookupErr);
            }
            throw lookupErr;
          }
        }
        if (isTransientError(err)) {
          if (err instanceof TypeError) {
            this.onNetworkError?.();
          }
          return queueLocally(name, err);
        }
        if (isUnauthenticated(err)) {
          void this.queryClient.invalidateQueries({ queryKey: ["session"] });
        }
        throw err;
      }
    }

    // Eager online creation with `autoSuffixOnConflict` (Untitled.md, Untitled 2.md, …).
    const taken = new Set(getFolderChildNames(this.queryClient, parentId));
    let nextIndex = 1;
    let lastCandidate = name ?? pickUntitledName(taken, nextIndex);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate =
        attempt === 0 && name !== undefined ? name : pickUntitledName(taken, nextIndex);
      lastCandidate = candidate;
      try {
        const created = await apiCreateFile(parentId, candidate, initialContent);
        this.onNetworkSuccess?.();
        if (this.isEpochCurrent(epoch)) {
          addChild(this.queryClient, parentId, created.node);
          upsertVaultIndexNode(this.queryClient, parentId, created.node);
          void addCachedChild(parentId, created.node);
          void writeCachedFile(created.node.id, initialContent, created.revision);
          this.syncQueue.observeRemoteRevision(created.node.id, created.revision, initialContent);
          this.queryClient.setQueryData(["files", created.node.id, "content"], {
            text: initialContent,
            revision: created.revision,
          });
        }
        return {
          status: "synced",
          node: created.node,
          revision: created.revision,
          content: initialContent,
          created: true,
        };
      } catch (err) {
        if (isNameExists(err)) {
          taken.add(candidate);
          nextIndex += 1;
          continue;
        }
        if (isTransientError(err)) {
          if (err instanceof TypeError) {
            this.onNetworkError?.();
          }
          return queueLocally(lastCandidate, err);
        }
        if (isUnauthenticated(err)) {
          void this.queryClient.invalidateQueries({ queryKey: ["session"] });
        }
        throw err;
      }
    }

    const fallback = `Untitled ${Date.now()}.md`;
    try {
      const created = await apiCreateFile(parentId, fallback, initialContent);
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        addChild(this.queryClient, parentId, created.node);
        upsertVaultIndexNode(this.queryClient, parentId, created.node);
        void addCachedChild(parentId, created.node);
        void writeCachedFile(created.node.id, initialContent, created.revision);
        this.syncQueue.observeRemoteRevision(created.node.id, created.revision, initialContent);
        this.queryClient.setQueryData(["files", created.node.id, "content"], {
          text: initialContent,
          revision: created.revision,
        });
      }
      return {
        status: "synced",
        node: created.node,
        revision: created.revision,
        content: initialContent,
        created: true,
      };
    } catch (err) {
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(fallback, err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  /** Creates a subfolder eagerly online or queued locally when offline/blocked/transiently failing. */
  async createFolder(options: CreateFolderOptions): Promise<CreateFolderResult> {
    const { parentId, name, adoptExistingOnConflict = false } = options;
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);

    const queueLocally = async (transientError?: unknown): Promise<CreateFolderResult> => {
      const now = Date.now();
      const localId = makeLocalId();
      const node: DriveNode = {
        id: localId,
        name,
        kind: "folder",
        modifiedTime: nowIso(now),
      };
      const op: PendingOp = {
        opId: makeOpId(),
        kind: "create_folder",
        targetId: localId,
        targetName: name,
        parentId,
        name,
        ...(adoptExistingOnConflict ? { adoptExistingOnConflict: true } : {}),
        createdAt: now,
        updatedAt: now,
      };

      const result = await this.runSerialized(async () => {
        const res = await enqueueOrCoalesceOp(op, { inFlightOpId: this.inFlightOpId });
        await addCachedChild(parentId, node);
        await writeCachedFolder(localId, []);
        return res;
      });
      if (!this.isEpochCurrent(epoch)) {
        return { status: "queued", node, created: true, opId: op.opId };
      }

      this.addChildOrSeed(parentId, node);
      upsertVaultIndexNode(this.queryClient, parentId, node);
      this.queryClient.setQueryData<DriveNode[]>(childrenKey(localId), []);

      this.syncOpsFromDb(result.ops);
      if (transientError !== undefined && result.activeOp !== null) {
        this.recordFailure(result.activeOp.opId, transientError);
      } else {
        this.emit();
        if (isOnline()) {
          void this.flushAll();
        }
      }
      return {
        status: "queued",
        node,
        created: true,
        opId: result.activeOp?.opId ?? op.opId,
      };
    };

    if (this.shouldQueueImmediately([parentId])) {
      return queueLocally();
    }

    try {
      const folder = await apiCreateFolder(parentId, name);
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        addChild(this.queryClient, parentId, folder);
        upsertVaultIndexNode(this.queryClient, parentId, folder);
        void addCachedChild(parentId, folder);
        if (this.queryClient.getQueryData(childrenKey(folder.id)) === undefined) {
          this.queryClient.setQueryData<DriveNode[]>(childrenKey(folder.id), []);
        }
        void writeCachedFolder(folder.id, []);
      }
      return { status: "synced", node: folder, created: true };
    } catch (err) {
      if (adoptExistingOnConflict && isNameExists(err)) {
        try {
          const rawChildren = await fetchChildren(parentId);
          const children = this.overlayListing(parentId, rawChildren);
          this.queryClient.setQueryData(childrenKey(parentId), children);
          void writeCachedFolder(parentId, children);
          const existing = children.find(
            (n) => n.kind === "folder" && n.name.toLowerCase() === name.toLowerCase(),
          );
          if (existing !== undefined) {
            return { status: "synced", node: existing, created: false };
          }
        } catch (lookupErr) {
          if (isTransientError(lookupErr)) {
            if (lookupErr instanceof TypeError) {
              this.onNetworkError?.();
            }
            return queueLocally(lookupErr);
          }
          throw lookupErr;
        }
      }
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  /** Renames a Markdown file (eagerly through `syncQueue.renameFile` online, or queued locally). */
  async renameFile(fileId: string, name: string, previousName?: string): Promise<RenameResult> {
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);
    const existing = findNode(this.queryClient, fileId);
    const prevName = previousName ?? existing?.name ?? name;
    const parentId = knownParentId(this.queryClient, fileId);

    const queueLocally = async (transientError?: unknown): Promise<RenameResult> => {
      const now = Date.now();
      const node: DriveNode = {
        id: fileId,
        name,
        kind: existing?.kind ?? "markdown",
        modifiedTime: nowIso(now),
      };
      const op: PendingOp = {
        opId: makeOpId(),
        kind: "rename_file",
        targetId: fileId,
        targetName: name,
        name,
        previousName: prevName,
        createdAt: now,
        updatedAt: now,
      };
      const result = await this.runSerialized(async () => {
        const res = await enqueueOrCoalesceOp(op, { inFlightOpId: this.inFlightOpId });
        await renameCachedChild(fileId, node);
        return res;
      });
      if (!this.isEpochCurrent(epoch)) {
        return { status: "queued", node, opId: result.activeOp?.opId };
      }

      renameChild(this.queryClient, fileId, node);
      renameInVaultIndex(this.queryClient, fileId, name, node.modifiedTime);

      this.syncOpsFromDb(result.ops);
      if (result.activeOp !== null) {
        if (transientError !== undefined) {
          this.recordFailure(result.activeOp.opId, transientError);
        } else {
          // Clear any prior error (e.g. 409 on create_file resolved by renaming) and retry online.
          this.cancelRetry(result.activeOp.opId);
          this.retryAttempts.delete(result.activeOp.opId);
          this.states.set(result.activeOp.opId, PENDING_STATUS);
          this.emit();
          if (isOnline()) {
            void this.flushAll();
          }
        }
      } else {
        this.emit();
      }
      return { status: "queued", node, opId: result.activeOp?.opId };
    };

    if (this.shouldQueueImmediately([fileId, parentId])) {
      return queueLocally();
    }

    try {
      const result = await this.syncQueue.renameFile(fileId, name);
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        renameChild(this.queryClient, fileId, result.node);
        renameInVaultIndex(this.queryClient, fileId, result.node.name, result.node.modifiedTime);
        void renameCachedChild(fileId, result.node);
      }
      return { status: "synced", node: result.node, revision: result.revision };
    } catch (err) {
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  /** Renames a folder (eagerly online or queued locally). */
  async renameFolder(folderId: string, name: string, previousName?: string): Promise<RenameResult> {
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);
    const existing = findNode(this.queryClient, folderId);
    const prevName = previousName ?? existing?.name ?? name;
    const parentId = knownParentId(this.queryClient, folderId);

    const queueLocally = async (transientError?: unknown): Promise<RenameResult> => {
      const now = Date.now();
      const node: DriveNode = {
        id: folderId,
        name,
        kind: "folder",
        modifiedTime: nowIso(now),
      };
      const op: PendingOp = {
        opId: makeOpId(),
        kind: "rename_folder",
        targetId: folderId,
        targetName: name,
        name,
        previousName: prevName,
        createdAt: now,
        updatedAt: now,
      };
      const result = await this.runSerialized(async () => {
        const res = await enqueueOrCoalesceOp(op, { inFlightOpId: this.inFlightOpId });
        await renameCachedChild(folderId, node);
        return res;
      });
      if (!this.isEpochCurrent(epoch)) {
        return { status: "queued", node, opId: result.activeOp?.opId };
      }

      renameChild(this.queryClient, folderId, node);
      renameInVaultIndex(this.queryClient, folderId, name, node.modifiedTime);

      this.syncOpsFromDb(result.ops);
      if (result.activeOp !== null) {
        if (transientError !== undefined) {
          this.recordFailure(result.activeOp.opId, transientError);
        } else {
          this.cancelRetry(result.activeOp.opId);
          this.retryAttempts.delete(result.activeOp.opId);
          this.states.set(result.activeOp.opId, PENDING_STATUS);
          this.emit();
          if (isOnline()) {
            void this.flushAll();
          }
        }
      } else {
        this.emit();
      }
      return { status: "queued", node, opId: result.activeOp?.opId };
    };

    if (this.shouldQueueImmediately([folderId, parentId])) {
      return queueLocally();
    }

    try {
      const updated = await apiRenameFolder(folderId, name);
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        renameChild(this.queryClient, folderId, updated);
        renameInVaultIndex(this.queryClient, folderId, updated.name, updated.modifiedTime);
        void renameCachedChild(folderId, updated);
      }
      return { status: "synced", node: updated };
    } catch (err) {
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  /** Moves a note or folder to `toParentId` (file moves serialize through `syncQueue.moveFile`). */
  async moveNode(input: MoveNodeInput): Promise<MoveResult> {
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);
    const existing = input.node ?? findNode(this.queryClient, input.id);
    const fromParentId = input.fromParentId ?? knownParentId(this.queryClient, input.id);
    const targetName = input.name ?? existing?.name ?? input.id;
    const isFolder = input.kind === "folder";

    const queueLocally = async (transientError?: unknown): Promise<MoveResult> => {
      const now = Date.now();
      const node: DriveNode = existing ?? {
        id: input.id,
        name: targetName,
        kind: input.kind,
        modifiedTime: nowIso(now),
      };
      const op: PendingOp = {
        opId: makeOpId(),
        kind: isFolder ? "move_folder" : "move_file",
        targetId: input.id,
        targetName,
        parentId: input.toParentId,
        ...(fromParentId !== undefined ? { previousParentId: fromParentId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const result = await this.runSerialized(async () => {
        const res = await enqueueOrCoalesceOp(op, { inFlightOpId: this.inFlightOpId });
        await moveCachedChild(node, input.toParentId);
        return res;
      });
      if (!this.isEpochCurrent(epoch)) {
        return { status: "queued", node, opId: result.activeOp?.opId };
      }

      removeChild(this.queryClient, node.id);
      this.addChildOrSeed(input.toParentId, node);
      moveInVaultIndex(this.queryClient, node.id, input.toParentId);

      this.syncOpsFromDb(result.ops);
      if (result.activeOp !== null) {
        if (transientError !== undefined) {
          this.recordFailure(result.activeOp.opId, transientError);
        } else {
          this.cancelRetry(result.activeOp.opId);
          this.retryAttempts.delete(result.activeOp.opId);
          this.states.set(result.activeOp.opId, PENDING_STATUS);
          this.emit();
          if (isOnline()) {
            void this.flushAll();
          }
        }
      } else {
        this.emit();
      }
      return { status: "queued", node, opId: result.activeOp?.opId };
    };

    if (this.shouldQueueImmediately([input.id, fromParentId, input.toParentId])) {
      return queueLocally();
    }

    try {
      let updated: DriveNode;
      let revision: string | undefined;
      if (isFolder) {
        updated = await apiMoveFolder(input.id, input.toParentId);
      } else {
        const res = await this.syncQueue.moveFile(input.id, input.toParentId);
        updated = res.node;
        revision = res.revision;
      }
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        moveChild(this.queryClient, updated, input.toParentId);
        moveInVaultIndex(this.queryClient, updated.id, input.toParentId);
        void moveCachedChild(updated, input.toParentId);
      }
      return { status: "synced", node: updated, revision };
    } catch (err) {
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  moveFile(fileId: string, toParentId: string, fromParentId?: string): Promise<MoveResult> {
    return this.moveNode({ id: fileId, kind: "markdown", fromParentId, toParentId });
  }

  moveFolder(folderId: string, toParentId: string, fromParentId?: string): Promise<MoveResult> {
    return this.moveNode({ id: folderId, kind: "folder", fromParentId, toParentId });
  }

  /** Deletes a Markdown file (cancelling un-flushed `local:` creates with 0 network calls). */
  async deleteFile(fileId: string, parentId?: string, node?: DriveNode): Promise<DeleteResult> {
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);
    const existing = node ?? findNode(this.queryClient, fileId);
    const previousParentId = parentId ?? knownParentId(this.queryClient, fileId);
    const targetName = existing?.name ?? fileId;

    const cleanupLocalFileInMemory = (id: string) => {
      void this.syncQueue.cancelDeletedFile(id);
      removeChild(this.queryClient, id);
      removeFromVaultIndex(this.queryClient, id);
      this.queryClient.removeQueries({ queryKey: ["files", id, "content"], exact: true });
      removeRecentFile(id);
    };

    const queueLocally = async (transientError?: unknown): Promise<DeleteResult> => {
      const now = Date.now();
      const cachedContent = this.queryClient.getQueryData<{ text: string; revision: string }>([
        "files",
        fileId,
        "content",
      ]);
      const op: PendingOp = {
        opId: makeOpId(),
        kind: "delete_file",
        targetId: fileId,
        targetName,
        ...(previousParentId !== undefined ? { previousParentId } : {}),
        ...(existing !== undefined ? { previousNode: existing } : {}),
        ...(cachedContent !== undefined ? { previousFile: cachedContent } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const result = await this.runSerialized(async () => {
        return enqueueOrCoalesceOp(op, { inFlightOpId: this.inFlightOpId });
      });
      if (!this.isEpochCurrent(epoch)) {
        return {
          status: result.activeOp === null ? "cancelled" : "queued",
          opId: result.activeOp?.opId,
        };
      }

      cleanupLocalFileInMemory(fileId);
      this.syncOpsFromDb(result.ops);

      if (result.activeOp === null) {
        this.emit();
        return { status: "cancelled" };
      }

      if (transientError !== undefined) {
        this.recordFailure(result.activeOp.opId, transientError);
      } else {
        this.emit();
        if (isOnline()) {
          void this.flushAll();
        }
      }
      return { status: "queued", opId: result.activeOp.opId };
    };

    if (this.shouldQueueImmediately([fileId, previousParentId])) {
      return queueLocally();
    }

    try {
      await apiDeleteFile(fileId);
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        cleanupLocalFileInMemory(fileId);
        void removeCachedChild(fileId);
        void deleteCachedFile(fileId);
      }
      return { status: "synced" };
    } catch (err) {
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  /**
   * Deletes a folder and its entire descendant subtree (cancelling un-flushed local creates and
   * emitting deletes for real items that had been moved into a deleted local folder).
   */
  async deleteFolder(folderId: string, parentId?: string, node?: DriveNode): Promise<DeleteResult> {
    const epoch = this.globalEpoch;
    await this.ensureHydrated(epoch);
    const existing = node ?? findNode(this.queryClient, folderId);
    const previousParentId = parentId ?? knownParentId(this.queryClient, folderId);
    const targetName = existing?.name ?? folderId;
    const descendants = collectDescendantIds(this.queryClient, folderId);

    const cleanupLocalSubtreeInMemory = (
      folderIds: readonly string[],
      fileIds: readonly string[],
    ) => {
      removeChild(this.queryClient, folderId);
      removeFromVaultIndex(this.queryClient, folderId, { folderIds, fileIds });
      for (const fid of folderIds) {
        this.queryClient.removeQueries({ queryKey: childrenKey(fid), exact: true });
      }
      for (const fileId of fileIds) {
        void this.syncQueue.cancelDeletedFile(fileId);
        this.queryClient.removeQueries({ queryKey: ["files", fileId, "content"], exact: true });
        removeRecentFile(fileId);
      }
    };

    const queueLocally = async (transientError?: unknown): Promise<DeleteResult> => {
      const now = Date.now();
      const op: PendingOp = {
        opId: makeOpId(),
        kind: "delete_folder",
        targetId: folderId,
        targetName,
        ...(previousParentId !== undefined ? { previousParentId } : {}),
        ...(existing !== undefined ? { previousNode: existing } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const result = await this.runSerialized(async () => {
        return enqueueOrCoalesceOp(op, {
          inFlightOpId: this.inFlightOpId,
          knownDescendantFolderIds: descendants.folderIds,
          knownDescendantFileIds: descendants.fileIds,
        });
      });
      if (!this.isEpochCurrent(epoch)) {
        return {
          status:
            result.activeOp === null && result.emittedDeleteOps.length === 0
              ? "cancelled"
              : "queued",
          opId: result.activeOp?.opId,
        };
      }

      const allDeletedFolders = Array.from(
        new Set([...descendants.folderIds, ...result.deletedFolderIds]),
      );
      const allDeletedFiles = Array.from(
        new Set([...descendants.fileIds, ...result.deletedFileIds]),
      );
      cleanupLocalSubtreeInMemory(allDeletedFolders, allDeletedFiles);
      this.syncOpsFromDb(result.ops);

      if (result.activeOp === null && result.emittedDeleteOps.length === 0) {
        this.emit();
        return { status: "cancelled" };
      }

      if (transientError !== undefined && result.activeOp !== null) {
        this.recordFailure(result.activeOp.opId, transientError);
      } else {
        this.emit();
        if (isOnline()) {
          void this.flushAll();
        }
      }
      return {
        status: "queued",
        opId: result.activeOp?.opId ?? result.emittedDeleteOps[0]?.opId,
      };
    };

    const blockingIds = [
      folderId,
      previousParentId,
      ...descendants.folderIds,
      ...descendants.fileIds,
    ];
    if (this.shouldQueueImmediately(blockingIds)) {
      return queueLocally();
    }

    try {
      await apiDeleteFolder(folderId);
      this.onNetworkSuccess?.();
      if (this.isEpochCurrent(epoch)) {
        const deleted = await deleteCachedSubtree(
          folderId,
          descendants.folderIds,
          descendants.fileIds,
        );
        void removeCachedChild(folderId);
        const allFolders = Array.from(new Set([...descendants.folderIds, ...deleted.folderIds]));
        const allFiles = Array.from(new Set([...descendants.fileIds, ...deleted.fileIds]));
        cleanupLocalSubtreeInMemory(allFolders, allFiles);
      }
      return { status: "synced" };
    } catch (err) {
      if (isTransientError(err)) {
        if (err instanceof TypeError) {
          this.onNetworkError?.();
        }
        return queueLocally(err);
      }
      if (isUnauthenticated(err)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      throw err;
    }
  }

  /**
   * Drains queued structural ops in strict FIFO `++seq` order.
   * When an op fails, dependent ops touching its id (directly or transitively) pause while
   * independent ops continue flushing.
   */
  flushAll(options?: { force?: boolean; automatic?: boolean }): Promise<void> {
    if (this.disposed || !isOnline()) {
      return Promise.resolve();
    }
    const force = options?.force === true;
    const automatic = options?.automatic === true;
    if (!automatic) {
      this.cancelAllRetries();
      if (force) {
        for (const op of this.ops) {
          const st = this.states.get(op.opId);
          if (st?.status === "error") {
            this.states.set(op.opId, PENDING_STATUS);
          }
        }
        this.emit();
      }
    }
    if (this.flushing !== null) {
      this.flushAgain = true;
      return this.flushing;
    }

    const epoch = this.globalEpoch;
    const run = (async () => {
      do {
        this.flushAgain = false;
        await this.drainOnce(epoch, force);
      } while (this.flushAgain && this.isEpochCurrent(epoch) && isOnline());
    })().finally(() => {
      if (this.flushing === run) {
        this.flushing = null;
      }
    });

    this.flushing = run;
    return run;
  }

  private async drainOnce(epoch: number, force: boolean): Promise<void> {
    await this.ensureHydrated(epoch);
    const blockedIds = new Set<string>();
    const attemptedInPass = new Set<string>();

    while (this.isEpochCurrent(epoch) && isOnline()) {
      const ops = await readAllPendingOps();
      if (!this.isEpochCurrent(epoch)) {
        return;
      }
      this.syncOpsFromDb(ops);

      let nextOp: PendingOp | undefined;
      for (const op of ops) {
        if (attemptedInPass.has(op.opId)) {
          blockedIds.add(op.targetId);
          continue;
        }
        const isBlocked =
          blockedIds.has(op.targetId) || ("parentId" in op && blockedIds.has(op.parentId));
        if (isBlocked) {
          blockedIds.add(op.targetId);
          continue;
        }
        const st = this.states.get(op.opId);
        if (!force && st?.status === "error" && isPermanentOpError(st.error)) {
          blockedIds.add(op.targetId);
          continue;
        }
        nextOp = op;
        break;
      }

      if (nextOp === undefined) {
        this.emit();
        return;
      }

      attemptedInPass.add(nextOp.opId);
      const outcome = await this.executeOp(nextOp, epoch);
      if (outcome === "blocked") {
        blockedIds.add(nextOp.targetId);
      } else if (outcome === "offline") {
        return;
      }
    }
  }

  private async executeOp(op: PendingOp, epoch: number): Promise<"ok" | "blocked" | "offline"> {
    if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
      return "ok";
    }
    this.inFlightOpId = op.opId;
    this.cancelRetry(op.opId);
    this.setOpState(op.opId, { status: "syncing" });

    try {
      switch (op.kind) {
        case "create_file": {
          const outbox = await readPendingWrite(op.targetId);
          const cached = await readCachedFile(op.targetId);
          const textToSend = outbox?.text ?? cached?.text ?? op.initialContent;
          const sentSeq = outbox?.seq;

          let realNode: DriveNode;
          let revision = "";
          let adoptedExisting = false;

          try {
            const res = await apiCreateFile(op.parentId, op.name, textToSend);
            realNode = res.node;
            revision = res.revision;
          } catch (err) {
            if (isNameExists(err) && op.autoSuffixOnConflict) {
              const taken = new Set(getFolderChildNames(this.queryClient, op.parentId));
              taken.add(op.name);
              let createdRes: { node: DriveNode; revision: string } | null = null;
              let nextIndex = 2;
              for (let attempt = 0; attempt < 20; attempt += 1) {
                const candidate = pickUntitledName(taken, nextIndex);
                try {
                  createdRes = await apiCreateFile(op.parentId, candidate, textToSend);
                  break;
                } catch (suffixErr) {
                  if (isNameExists(suffixErr)) {
                    taken.add(candidate);
                    nextIndex += 1;
                    continue;
                  }
                  throw suffixErr;
                }
              }
              if (createdRes === null) {
                createdRes = await apiCreateFile(
                  op.parentId,
                  `Untitled ${Date.now()}.md`,
                  textToSend,
                );
              }
              realNode = createdRes.node;
              revision = createdRes.revision;
            } else if (isNameExists(err) && op.openExistingOnConflict) {
              const untouched = textToSend === "" || textToSend === op.initialContent;
              if (!untouched) {
                throw err;
              }
              const children = await fetchChildren(op.parentId);
              const existing = children.find(
                (n) => n.kind === "markdown" && n.name.toLowerCase() === op.name.toLowerCase(),
              );
              if (existing === undefined) {
                throw err;
              }
              realNode = existing;
              adoptedExisting = true;
            } else {
              throw err;
            }
          }

          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.commitFileRemap(op, realNode, revision, textToSend, sentSeq, adoptedExisting);
          return "ok";
        }

        case "create_folder": {
          let realNode: DriveNode;
          try {
            realNode = await apiCreateFolder(op.parentId, op.name);
          } catch (err) {
            if (isNameExists(err) && op.adoptExistingOnConflict) {
              const children = await fetchChildren(op.parentId);
              const existing = children.find(
                (n) => n.kind === "folder" && n.name.toLowerCase() === op.name.toLowerCase(),
              );
              if (existing === undefined) {
                throw err;
              }
              realNode = existing;
            } else {
              throw err;
            }
          }

          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.commitFolderRemap(op, realNode);
          return "ok";
        }

        case "rename_file": {
          const res = await this.syncQueue.renameFile(op.targetId, op.name);
          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.completeSimpleOp(op.opId, async (remaining) => {
            const hasNewerRename = remaining.some(
              (o) => o.kind === "rename_file" && o.targetId === op.targetId,
            );
            if (!hasNewerRename) {
              renameChild(this.queryClient, op.targetId, res.node);
              renameInVaultIndex(
                this.queryClient,
                op.targetId,
                res.node.name,
                res.node.modifiedTime,
              );
              await renameCachedChild(op.targetId, res.node);
            }
          });
          return "ok";
        }

        case "rename_folder": {
          const node = await apiRenameFolder(op.targetId, op.name);
          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.completeSimpleOp(op.opId, async (remaining) => {
            const hasNewerRename = remaining.some(
              (o) => o.kind === "rename_folder" && o.targetId === op.targetId,
            );
            if (!hasNewerRename) {
              renameChild(this.queryClient, op.targetId, node);
              renameInVaultIndex(this.queryClient, op.targetId, node.name, node.modifiedTime);
              await renameCachedChild(op.targetId, node);
            }
          });
          return "ok";
        }

        case "move_file": {
          const res = await this.syncQueue.moveFile(op.targetId, op.parentId);
          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.completeSimpleOp(op.opId, async (remaining) => {
            const hasNewerMove = remaining.some(
              (o) => o.kind === "move_file" && o.targetId === op.targetId,
            );
            if (!hasNewerMove) {
              moveChild(this.queryClient, res.node, op.parentId);
              moveInVaultIndex(this.queryClient, res.node.id, op.parentId);
              await moveCachedChild(res.node, op.parentId);
            }
          });
          return "ok";
        }

        case "move_folder": {
          const node = await apiMoveFolder(op.targetId, op.parentId);
          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.completeSimpleOp(op.opId, async (remaining) => {
            const hasNewerMove = remaining.some(
              (o) => o.kind === "move_folder" && o.targetId === op.targetId,
            );
            if (!hasNewerMove) {
              moveChild(this.queryClient, node, op.parentId);
              moveInVaultIndex(this.queryClient, node.id, op.parentId);
              await moveCachedChild(node, op.parentId);
            }
          });
          return "ok";
        }

        case "delete_file": {
          try {
            await apiDeleteFile(op.targetId);
          } catch (err) {
            // Deferred delete 404 is idempotent success: already deleted on Drive.
            if (!isNotFound(err)) {
              throw err;
            }
          }
          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.completeSimpleOp(op.opId);
          return "ok";
        }

        case "delete_folder": {
          try {
            await apiDeleteFolder(op.targetId);
          } catch (err) {
            if (!isNotFound(err)) {
              throw err;
            }
          }
          if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
            return "ok";
          }
          this.onNetworkSuccess?.();
          await this.completeSimpleOp(op.opId);
          return "ok";
        }

        default: {
          const _exhaustive: never = op;
          return _exhaustive;
        }
      }
    } catch (err) {
      if (!this.isEpochCurrent(epoch) || this.discardedOpIds.has(op.opId)) {
        return "ok";
      }
      if (err instanceof TypeError) {
        this.onNetworkError?.();
      }
      this.recordFailure(op.opId, err);
      if (!isOnline() && err instanceof TypeError) {
        return "offline";
      }
      return "blocked";
    } finally {
      if (this.inFlightOpId === op.opId) {
        this.inFlightOpId = null;
      }
    }
  }

  private async completeSimpleOp(
    opId: string,
    afterDelete?: (remaining: PendingOp[]) => Promise<void> | void,
  ): Promise<void> {
    const remaining = await this.runSerialized(async () => {
      await deletePendingOp(opId);
      const nextOps = await readAllPendingOps();
      if (afterDelete !== undefined) {
        await afterDelete(nextOps);
      }
      return nextOps;
    });
    this.retryAttempts.delete(opId);
    this.cancelRetry(opId);
    this.syncOpsFromDb(remaining);
    this.emit();
  }

  private async commitFileRemap(
    op: Extract<PendingOp, { kind: "create_file" }>,
    realNode: DriveNode,
    revision: string,
    sentText: string,
    sentSeq: number | undefined,
    adoptedExisting: boolean,
  ): Promise<void> {
    const remap = await this.runSerialized(() =>
      remapLocalIdInDb({
        completedOpId: op.opId,
        localId: op.targetId,
        realNode,
        revision,
        sentText,
        sentSeq,
        adoptedExisting,
      }),
    );

    this.retryAttempts.delete(op.opId);
    this.cancelRetry(op.opId);
    this.syncOpsFromDb(remap.rewrittenOps);

    // Synchronous React Query + storage remap.
    remapNodeId(this.queryClient, op.targetId, remap.displayNode, {
      preserveName: remap.hasFollowUpRename,
    });
    upsertVaultIndexNode(this.queryClient, op.parentId, remap.displayNode);

    if (adoptedExisting) {
      this.queryClient.removeQueries({ queryKey: ["files", op.targetId, "content"], exact: true });
      void this.queryClient.invalidateQueries({
        queryKey: ["files", realNode.id, "content"],
        exact: true,
      });
    } else {
      this.queryClient.setQueryData(["files", realNode.id, "content"], {
        text: remap.hasChainedOutbox ? (remap.chainedText ?? sentText) : sentText,
        revision,
      });
      this.queryClient.removeQueries({ queryKey: ["files", op.targetId, "content"], exact: true });
    }

    this.syncQueue.remapFileId(
      op.targetId,
      realNode.id,
      adoptedExisting ? "" : revision,
      sentText,
      remap.hasChainedOutbox,
    );
    remapOpenFileId(op.targetId, realNode.id);
    remapRecentFile(op.targetId, realNode.id);

    this.emit();
    this.emitIdRemapped({
      localId: op.targetId,
      realId: realNode.id,
      node: remap.displayNode,
      kind: "file",
    });
  }

  private async commitFolderRemap(
    op: Extract<PendingOp, { kind: "create_folder" }>,
    realNode: DriveNode,
  ): Promise<void> {
    const remap = await this.runSerialized(() =>
      remapLocalIdInDb({
        completedOpId: op.opId,
        localId: op.targetId,
        realNode,
      }),
    );

    this.retryAttempts.delete(op.opId);
    this.cancelRetry(op.opId);
    this.syncOpsFromDb(remap.rewrittenOps);

    remapNodeId(this.queryClient, op.targetId, remap.displayNode, {
      preserveName: remap.hasFollowUpRename,
    });
    upsertVaultIndexNode(this.queryClient, op.parentId, remap.displayNode);
    remapExpandedFolder(op.targetId, realNode.id);

    this.emit();
    this.emitIdRemapped({
      localId: op.targetId,
      realId: realNode.id,
      node: remap.displayNode,
      kind: "folder",
    });
  }

  /** Manually retries a single op (clearing its permanent/backoff error and draining). */
  retryOp(opId: string): Promise<void> {
    if (this.disposed || !isOnline()) {
      return Promise.resolve();
    }
    this.cancelRetry(opId);
    this.retryAttempts.delete(opId);
    if (this.ops.some((o) => o.opId === opId)) {
      this.setOpState(opId, PENDING_STATUS);
    }
    return this.flushAll();
  }

  /**
   * Discards a queued structural op and cleanly rolls back its optimistic local changes in
   * Dexie and React Query (removing unsynced local creates, reverting renames/moves, or restoring
   * locally deleted files/subtrees).
   */
  async discardOp(opId: string): Promise<void> {
    const epoch = this.globalEpoch;
    this.discardedOpIds.add(opId);
    this.cancelRetry(opId);
    this.retryAttempts.delete(opId);

    const outcome = await this.runSerialized(async () => {
      const res = await discardPendingOpInDb(opId);
      const discarded = res.discarded;
      if (discarded === null) {
        return res;
      }

      if (discarded.kind === "rename_file" || discarded.kind === "rename_folder") {
        const hasOtherRename = res.remainingOps.some(
          (o) => o.kind === discarded.kind && o.targetId === discarded.targetId,
        );
        if (!hasOtherRename) {
          const current = findNode(this.queryClient, discarded.targetId);
          const reverted: DriveNode = {
            id: discarded.targetId,
            name: discarded.previousName,
            kind: current?.kind ?? (discarded.kind === "rename_folder" ? "folder" : "markdown"),
            modifiedTime: current?.modifiedTime ?? nowIso(),
          };
          await renameCachedChild(discarded.targetId, reverted);
        }
      } else if (discarded.kind === "move_file" || discarded.kind === "move_folder") {
        if (discarded.previousParentId !== undefined) {
          const current = findNode(this.queryClient, discarded.targetId);
          const reverted: DriveNode = current ?? {
            id: discarded.targetId,
            name: discarded.targetName,
            kind: discarded.kind === "move_folder" ? "folder" : "markdown",
            modifiedTime: nowIso(),
          };
          await moveCachedChild(reverted, discarded.previousParentId);
        }
      } else if (discarded.kind === "delete_file") {
        await restoreDeletedFileInDb(discarded);
      } else if (discarded.kind === "delete_folder") {
        await restoreDeletedSubtreeInDb(discarded);
      }

      return res;
    });

    if (!this.isEpochCurrent(epoch) || outcome.discarded === null) {
      return;
    }

    const discarded = outcome.discarded;
    if (discarded.kind === "create_file") {
      for (const fid of outcome.removedLocalFileIds) {
        void this.syncQueue.cancelDeletedFile(fid);
        removeChild(this.queryClient, fid);
        removeFromVaultIndex(this.queryClient, fid);
        this.queryClient.removeQueries({ queryKey: ["files", fid, "content"], exact: true });
        removeRecentFile(fid);
      }
    } else if (discarded.kind === "create_folder") {
      for (const moved of outcome.restoredMoves) {
        const node: DriveNode = moved.node ??
          findNode(this.queryClient, moved.id) ?? {
            id: moved.id,
            name: moved.id,
            kind: moved.kind === "folder" ? "folder" : "markdown",
            modifiedTime: nowIso(),
          };
        moveChild(this.queryClient, node, moved.toParentId);
        moveInVaultIndex(this.queryClient, node.id, moved.toParentId);
      }
      removeChild(this.queryClient, discarded.targetId);
      removeFromVaultIndex(this.queryClient, discarded.targetId, {
        folderIds: outcome.removedLocalFolderIds,
        fileIds: outcome.removedLocalFileIds,
      });
      for (const fid of outcome.removedLocalFolderIds) {
        this.queryClient.removeQueries({ queryKey: childrenKey(fid), exact: true });
      }
      for (const fileId of outcome.removedLocalFileIds) {
        void this.syncQueue.cancelDeletedFile(fileId);
        this.queryClient.removeQueries({ queryKey: ["files", fileId, "content"], exact: true });
        removeRecentFile(fileId);
      }
    } else if (discarded.kind === "rename_file" || discarded.kind === "rename_folder") {
      const hasOtherRename = outcome.remainingOps.some(
        (o) => o.kind === discarded.kind && o.targetId === discarded.targetId,
      );
      if (!hasOtherRename) {
        const current = findNode(this.queryClient, discarded.targetId);
        const reverted: DriveNode = {
          id: discarded.targetId,
          name: discarded.previousName,
          kind: current?.kind ?? (discarded.kind === "rename_folder" ? "folder" : "markdown"),
          modifiedTime: current?.modifiedTime ?? nowIso(),
        };
        renameChild(this.queryClient, discarded.targetId, reverted);
        renameInVaultIndex(this.queryClient, discarded.targetId, reverted.name);
      }
    } else if (discarded.kind === "move_file" || discarded.kind === "move_folder") {
      if (discarded.previousParentId !== undefined) {
        const current = findNode(this.queryClient, discarded.targetId);
        const reverted: DriveNode = current ?? {
          id: discarded.targetId,
          name: discarded.targetName,
          kind: discarded.kind === "move_folder" ? "folder" : "markdown",
          modifiedTime: nowIso(),
        };
        moveChild(this.queryClient, reverted, discarded.previousParentId);
        moveInVaultIndex(this.queryClient, reverted.id, discarded.previousParentId);
      } else if (isOnline()) {
        void this.queryClient.invalidateQueries({ queryKey: ["folders"] });
      }
    } else if (discarded.kind === "delete_file") {
      this.syncQueue.unmarkDeletedFile(discarded.targetId);
      if (discarded.previousParentId !== undefined && discarded.previousNode !== undefined) {
        addChild(this.queryClient, discarded.previousParentId, discarded.previousNode);
        upsertVaultIndexNode(this.queryClient, discarded.previousParentId, discarded.previousNode);
      }
      if (discarded.previousFile !== undefined) {
        this.queryClient.setQueryData(
          ["files", discarded.targetId, "content"],
          discarded.previousFile,
        );
      }
    } else if (discarded.kind === "delete_folder") {
      if (discarded.previousParentId !== undefined && discarded.previousNode !== undefined) {
        addChild(this.queryClient, discarded.previousParentId, discarded.previousNode);
        upsertVaultIndexNode(this.queryClient, discarded.previousParentId, discarded.previousNode);
      }
      if (discarded.previousSubtree !== undefined) {
        for (const folder of discarded.previousSubtree.folders) {
          this.queryClient.setQueryData<DriveNode[]>(childrenKey(folder.folderId), folder.nodes);
          for (const child of folder.nodes) {
            upsertVaultIndexNode(this.queryClient, folder.folderId, child);
          }
        }
        for (const file of discarded.previousSubtree.files) {
          this.syncQueue.unmarkDeletedFile(file.fileId);
          this.queryClient.setQueryData(["files", file.fileId, "content"], {
            text: file.text,
            revision: file.revision,
          });
        }
      }
    }

    for (const cid of outcome.cancelledOpIds) {
      this.cancelRetry(cid);
      this.retryAttempts.delete(cid);
    }
    this.syncOpsFromDb(outcome.remainingOps);
    this.emit();
    this.onOpDiscarded?.(discarded);

    if (isOnline() && this.ops.length > 0) {
      void this.flushAll();
    }
  }

  /**
   * Inserts `node` into `folderId`'s cached listing, or seeds a stale single-item listing when
   * `folderId` was never expanded/cached before going offline so optimistic moves/creates stay
   * visible in the tree and reconcile with Drive once online.
   */
  private addChildOrSeed(folderId: string, node: DriveNode): void {
    const existing = this.queryClient.getQueryData<DriveNode[]>(childrenKey(folderId));
    if (existing === undefined) {
      this.queryClient.setQueryData<DriveNode[]>(childrenKey(folderId), [node], {
        updatedAt: CACHE_STALE_TIMESTAMP,
      });
      return;
    }
    addChild(this.queryClient, folderId, node);
  }

  /**
   * Projects queued structural ops onto the hydrated TanStack Query folder caches (including
   * destination folders whose full remote listings were never cached before going offline)
   * using a stale timestamp so the next online fetch reconciles with Drive.
   */
  applyPendingOverlaysToCache = (): void => {
    if (this.ops.length === 0) {
      return;
    }
    const targetFolders = new Set<string>();
    const otherFolders = new Set<string>();
    for (const op of this.ops) {
      if (
        op.kind === "create_file" ||
        op.kind === "create_folder" ||
        op.kind === "move_file" ||
        op.kind === "move_folder"
      ) {
        targetFolders.add(op.parentId);
      }
      if (
        (op.kind === "move_file" ||
          op.kind === "move_folder" ||
          op.kind === "delete_file" ||
          op.kind === "delete_folder") &&
        op.previousParentId !== undefined &&
        !targetFolders.has(op.previousParentId)
      ) {
        otherFolders.add(op.previousParentId);
      }
    }
    for (const [key] of this.queryClient.getQueriesData<DriveNode[]>({ queryKey: ["folders"] })) {
      if (typeof key[1] === "string" && !targetFolders.has(key[1])) {
        otherFolders.add(key[1]);
      }
    }
    for (const folderId of [...targetFolders, ...otherFolders]) {
      const existing = this.queryClient.getQueryData<DriveNode[]>(childrenKey(folderId));
      const overlaid = this.overlayListing(folderId, existing ?? []);
      if (existing !== undefined || overlaid.length > 0) {
        this.queryClient.setQueryData<DriveNode[]>(childrenKey(folderId), overlaid, {
          updatedAt: CACHE_STALE_TIMESTAMP,
        });
      }
    }
  };

  /** Whether `id` (a file or folder) is deleted by a pending `delete_file` or `delete_folder` op. */
  isPendingDeleted = (id: string): boolean => {
    for (const op of this.ops) {
      if ((op.kind === "delete_file" || op.kind === "delete_folder") && op.targetId === id) {
        return true;
      }
      if (op.kind === "delete_folder" && op.previousSubtree !== undefined) {
        if (
          op.previousSubtree.folders.some((f) => f.folderId === id) ||
          op.previousSubtree.files.some((f) => f.fileId === id)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Replays queued structural ops in strict FIFO order on top of a remote folder listing so
   * stale Drive revalidations never clobber optimistic local creates, renames, moves, or deletes.
   */
  overlayListing = (folderId: string, nodes: DriveNode[]): DriveNode[] => {
    if (this.ops.length === 0) {
      return nodes;
    }
    if (this.isPendingDeleted(folderId)) {
      return [];
    }
    let result = [...nodes];
    for (const op of this.ops) {
      switch (op.kind) {
        case "create_file":
        case "create_folder": {
          const kind = op.kind === "create_folder" ? "folder" : "markdown";
          if (op.parentId === folderId) {
            const idx = result.findIndex((n) => n.id === op.targetId);
            const synthesized: DriveNode = {
              id: op.targetId,
              name: op.name,
              kind,
              modifiedTime: nowIso(op.updatedAt),
            };
            if (idx === -1) {
              result.push(synthesized);
            } else {
              result[idx] = { ...result[idx], name: op.name };
            }
          } else {
            result = result.filter((n) => n.id !== op.targetId);
          }
          break;
        }
        case "rename_file":
        case "rename_folder": {
          const idx = result.findIndex((n) => n.id === op.targetId);
          if (idx !== -1) {
            result[idx] = { ...result[idx], name: op.name };
          }
          break;
        }
        case "move_file":
        case "move_folder": {
          if (op.parentId === folderId) {
            if (!result.some((n) => n.id === op.targetId)) {
              const existing = findNode(this.queryClient, op.targetId);
              result.push(
                existing ?? {
                  id: op.targetId,
                  name: op.targetName,
                  kind: op.kind === "move_folder" ? "folder" : "markdown",
                  modifiedTime: nowIso(op.updatedAt),
                },
              );
            }
          } else {
            result = result.filter((n) => n.id !== op.targetId);
          }
          break;
        }
        case "delete_file":
        case "delete_folder": {
          result = result.filter((n) => n.id !== op.targetId);
          break;
        }
      }
    }
    return result;
  };

  /**
   * Replays queued structural ops in strict FIFO order on top of a remote `VaultIndex` so
   * `VaultSync` sees pending creates, renames, moves, and deletes consistently.
   */
  overlayVaultIndex = (index: VaultIndex): VaultIndex => {
    if (this.ops.length === 0) {
      return index;
    }
    let folders = [...index.folders];
    let files = [...index.files];

    for (const op of this.ops) {
      switch (op.kind) {
        case "create_folder": {
          folders = [
            ...folders.filter((f) => f.id !== op.targetId),
            {
              id: op.targetId,
              name: op.name,
              parentId: op.parentId,
              modifiedTime: nowIso(op.updatedAt),
            },
          ];
          break;
        }
        case "create_file": {
          files = [
            ...files.filter((f) => f.id !== op.targetId),
            {
              id: op.targetId,
              name: op.name,
              parentId: op.parentId,
              modifiedTime: nowIso(op.updatedAt),
            },
          ];
          break;
        }
        case "rename_folder": {
          folders = folders.map((f) => (f.id === op.targetId ? { ...f, name: op.name } : f));
          break;
        }
        case "rename_file": {
          files = files.map((f) => (f.id === op.targetId ? { ...f, name: op.name } : f));
          break;
        }
        case "move_folder": {
          const hit = folders.some((f) => f.id === op.targetId);
          if (hit) {
            folders = folders.map((f) =>
              f.id === op.targetId ? { ...f, parentId: op.parentId } : f,
            );
          } else {
            folders.push({
              id: op.targetId,
              name: op.targetName,
              parentId: op.parentId,
              modifiedTime: nowIso(op.updatedAt),
            });
          }
          break;
        }
        case "move_file": {
          const hit = files.some((f) => f.id === op.targetId);
          if (hit) {
            files = files.map((f) => (f.id === op.targetId ? { ...f, parentId: op.parentId } : f));
          } else {
            files.push({
              id: op.targetId,
              name: op.targetName,
              parentId: op.parentId,
              modifiedTime: nowIso(op.updatedAt),
            });
          }
          break;
        }
        case "delete_file": {
          files = files.filter((f) => f.id !== op.targetId);
          break;
        }
        case "delete_folder": {
          const dropFolders = new Set<string>([op.targetId]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const f of folders) {
              if (dropFolders.has(f.parentId) && !dropFolders.has(f.id)) {
                dropFolders.add(f.id);
                grew = true;
              }
            }
          }
          folders = folders.filter((f) => !dropFolders.has(f.id));
          files = files.filter((f) => !dropFolders.has(f.parentId));
          break;
        }
      }
    }

    return { ...index, folders, files };
  };

  /** Cancels in-flight work and clears in-memory state on sign-out or vault switch. */
  resetAll(): void {
    this.globalEpoch += 1;
    this.cancelAllRetries();
    this.ops = [];
    this.states.clear();
    this.discardedOpIds.clear();
    this.inFlightOpId = null;
    this.flushing = null;
    this.flushAgain = false;
    this.hydrated = false;
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.globalEpoch += 1;
    this.cancelAllRetries();
    this.listeners.clear();
    this.remapListeners.clear();
  }
}

export const OpsQueueContext = createContext<OpsQueue | null>(null);

export function useOptionalOpsQueue(): OpsQueue | null {
  return useContext(OpsQueueContext);
}

export function useOpsQueue(): OpsQueue {
  const queue = useContext(OpsQueueContext);
  if (queue === null) {
    throw new Error("useOpsQueue must be used within OpsQueueContext.");
  }
  return queue;
}

const EMPTY_OPS_SNAPSHOT: OpsSnapshot = {
  ops: [],
  pendingCount: 0,
  failedCount: 0,
  syncing: false,
};
const noSubscribe = () => () => {};
const emptyOpsSnapshot = () => EMPTY_OPS_SNAPSHOT;

/** Snapshot of pending structural operations; gracefully empty when rendered without a provider. */
export function useOpsSnapshot(): OpsSnapshot {
  const queue = useOptionalOpsQueue();
  return useSyncExternalStore(
    queue?.subscribe ?? noSubscribe,
    queue?.getSnapshot ?? emptyOpsSnapshot,
    queue?.getSnapshot ?? emptyOpsSnapshot,
  );
}

export function usePendingOps(): readonly PendingOpView[] {
  return useOpsSnapshot().ops;
}

export function usePendingOpsCount(): number {
  return useOpsSnapshot().pendingCount;
}

/**
 * Combined deduplicated pending count across `OpsQueue` and `SyncQueue` (never double-counts a
 * `local:` note that is in both `db.ops` and `db.outbox`).
 */
export function useTotalPendingSyncCount(): number {
  const ops = usePendingOps();
  const syncStates = useSyncStates();
  return countTotalPendingSync(ops, syncStates);
}
