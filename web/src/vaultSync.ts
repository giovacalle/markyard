import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  ApiError,
  fetchContent,
  fetchVaultIndex,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
  type DriveNode,
  type VaultIndex,
} from "./api";
import {
  CACHE_STALE_TIMESTAMP,
  readAllCachedFolders,
  readAllPendingWrites,
  readCachedFileStamps,
  readVaultState,
  writeCachedFolders,
  writeCachedRemoteFile,
  writeVaultState,
} from "./localCache";
import { isLocalId } from "./localIds";
import { childrenKey, VAULT_INDEX_KEY } from "./treeCache";

export const VAULT_PIN_STORAGE_KEY = "markyard:vault-pinned";
/** Notes downloaded at once: low, so the editor's own requests never wait behind the sync. */
export const VAULT_SYNC_CONCURRENCY = 3;
const DEFAULT_RATE_LIMIT_PAUSE_S = 30;

export interface VaultSyncSnapshot {
  pinned: boolean;
  running: boolean;
  /** Markdown notes in the vault, as of the last index. */
  total: number;
  /** Of those, notes whose text is stored on this device. */
  cached: number;
  lastSyncedAt: number | null;
  /** Notes the last run could not download. */
  failed: number;
  truncated: boolean;
  error: unknown;
}

function readPinned(): boolean {
  try {
    return localStorage.getItem(VAULT_PIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

class AbortedError extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function untilOnline(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener("online", done);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      window.removeEventListener("online", done);
      reject(new AbortedError());
    };
    window.addEventListener("online", done);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Folder listings (folders and notes) built from the vault index, keyed by folder id. */
export function listingsFromIndex(index: VaultIndex): Map<string, DriveNode[]> {
  const out = new Map<string, DriveNode[]>([[index.rootId, []]]);
  for (const folder of index.folders) {
    out.set(folder.id, out.get(folder.id) ?? []);
  }
  const push = (parentId: string, node: DriveNode) => {
    const list = out.get(parentId) ?? [];
    list.push(node);
    out.set(parentId, list);
  };
  for (const folder of index.folders) {
    push(folder.parentId, {
      id: folder.id,
      name: folder.name,
      kind: "folder",
      modifiedTime: folder.modifiedTime,
    });
  }
  for (const file of index.files) {
    push(file.parentId, {
      id: file.id,
      name: file.name,
      kind: "markdown",
      modifiedTime: file.modifiedTime,
    });
  }
  return out;
}

/** Optional hooks supplied by `OpsQueue` so vault sync never clobbers pending structural ops. */
export interface VaultSyncOpsHooks {
  overlayListing?: (folderId: string, nodes: DriveNode[]) => DriveNode[];
  overlayVaultIndex?: (index: VaultIndex) => VaultIndex;
  isPendingDeleted?: (id: string) => boolean;
}

/**
 * Keeps every note of the vault readable offline ("Pin vault offline"): reads the vault index,
 * seeds folder listings nobody has opened yet, then downloads only notes that are missing or older
 * than Drive's copy, a few at a time. Notes with local edits waiting to sync are never touched.
 */
export class VaultSync {
  private readonly queryClient: QueryClient;
  private opsHooks: VaultSyncOpsHooks | undefined;
  private readonly listeners = new Set<() => void>();
  private snapshot: VaultSyncSnapshot;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private pausedUntil = 0;

  constructor(queryClient: QueryClient, opsHooks?: VaultSyncOpsHooks) {
    this.queryClient = queryClient;
    this.opsHooks = opsHooks;
    this.snapshot = {
      pinned: readPinned(),
      running: false,
      total: 0,
      cached: 0,
      lastSyncedAt: null,
      failed: 0,
      truncated: false,
      error: null,
    };
  }

  /** Attaches (or clears) pending structural op overlay hooks. */
  setOpsHooks(opsHooks: VaultSyncOpsHooks | undefined): void {
    this.opsHooks = opsHooks;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): VaultSyncSnapshot => this.snapshot;

  private update(next: Partial<VaultSyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Shows the last run's coverage before any new run. */
  async hydrate(): Promise<void> {
    const state = await readVaultState();
    if (state !== undefined && !this.snapshot.running && this.snapshot.lastSyncedAt === null) {
      this.update({ total: state.total, cached: state.cached, lastSyncedAt: state.lastSyncedAt });
    }
  }

  setPinned(pinned: boolean): void {
    try {
      if (pinned) {
        localStorage.setItem(VAULT_PIN_STORAGE_KEY, "1");
      } else {
        localStorage.removeItem(VAULT_PIN_STORAGE_KEY);
      }
    } catch {
      // Storage blocked: the choice lasts for this session only.
    }
    this.update({ pinned });
    if (pinned) {
      void this.run();
    } else {
      this.stop();
    }
  }

  /** One full pass; a pass already running is shared. */
  run(): Promise<void> {
    if (this.running !== null) {
      return this.running;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.update({ running: true, error: null, failed: 0 });
    this.running = this.pass(controller.signal)
      .catch((error: unknown) => {
        if (!(error instanceof AbortedError) && !controller.signal.aborted) {
          this.update({ error });
        }
      })
      .finally(() => {
        if (this.controller === controller) {
          this.controller = null;
          this.running = null;
          this.update({ running: false });
        }
      });
    return this.running;
  }

  /** Aborts the pass in flight, if any. */
  stop(): void {
    const controller = this.controller;
    if (controller === null) {
      return;
    }
    this.controller = null;
    this.running = null;
    controller.abort();
    this.update({ running: false });
  }

  /** Signed out: stop and forget coverage (Dexie and the pin are cleared by the caller). */
  reset(): void {
    this.stop();
    this.pausedUntil = 0;
    this.update({
      total: 0,
      cached: 0,
      lastSyncedAt: null,
      failed: 0,
      truncated: false,
      error: null,
    });
  }

  private async pass(signal: AbortSignal): Promise<void> {
    while (!isOnline()) {
      await untilOnline(signal);
    }
    const rawIndex = await fetchVaultIndex(signal);
    if (signal.aborted) {
      throw new AbortedError();
    }
    const index = this.opsHooks?.overlayVaultIndex
      ? this.opsHooks.overlayVaultIndex(rawIndex)
      : rawIndex;
    this.queryClient.setQueryData(VAULT_INDEX_KEY, index);
    await this.seedFolders(index);

    const [stamps, pending] = await Promise.all([readCachedFileStamps(), readAllPendingWrites()]);
    const pendingIds = new Set(pending.map((entry) => entry.fileId));
    const queue = index.files.filter((file) => {
      if (
        isLocalId(file.id) ||
        pendingIds.has(file.id) ||
        this.opsHooks?.isPendingDeleted?.(file.id) === true
      ) {
        return false;
      }
      const stamp = stamps.get(file.id);
      const modified = Date.parse(file.modifiedTime);
      return stamp === undefined || (!Number.isNaN(modified) && modified > stamp);
    });
    const total = index.files.length;
    let cached = total - queue.length;
    let failed = 0;
    this.update({ total, cached, truncated: index.truncated });

    const worker = async () => {
      for (;;) {
        const file = queue.shift();
        if (file === undefined) {
          return;
        }
        if (isLocalId(file.id) || this.opsHooks?.isPendingDeleted?.(file.id) === true) {
          continue;
        }
        for (;;) {
          if (signal.aborted) {
            throw new AbortedError();
          }
          if (!isOnline()) {
            await untilOnline(signal);
            continue;
          }
          const wait = this.pausedUntil - Date.now();
          if (wait > 0) {
            await sleep(wait, signal);
            continue;
          }
          try {
            const fresh = await fetchContent(file.id, signal);
            if (signal.aborted) {
              throw new AbortedError();
            }
            if (this.opsHooks?.isPendingDeleted?.(file.id) === true) {
              break;
            }
            await writeCachedRemoteFile(file.id, fresh.text, fresh.revision);
            cached += 1;
          } catch (error) {
            if (error instanceof AbortedError || signal.aborted) {
              throw new AbortedError();
            }
            if (isRateLimited(error)) {
              const seconds =
                error instanceof ApiError && error.retryAfter !== undefined
                  ? error.retryAfter
                  : DEFAULT_RATE_LIMIT_PAUSE_S;
              this.pausedUntil = Math.max(this.pausedUntil, Date.now() + seconds * 1000);
              continue;
            }
            if (isUnauthenticated(error)) {
              throw error;
            }
            if (error instanceof TypeError && !isOnline()) {
              continue;
            }
            if (!isNotFound(error)) {
              failed += 1;
            }
          }
          break;
        }
        this.update({ cached, failed });
        // Let the UI breathe between notes.
        await sleep(0, signal);
      }
    };

    await Promise.all(Array.from({ length: VAULT_SYNC_CONCURRENCY }, worker));
    const lastSyncedAt = Date.now();
    this.update({ cached, failed, lastSyncedAt });
    await writeVaultState({ lastSyncedAt, total, cached });
  }

  /** Seeds listings not loaded yet, marked stale so an opened folder still revalidates. */
  private async seedFolders(index: VaultIndex): Promise<void> {
    const listings = listingsFromIndex(index);
    const stored = new Set((await readAllCachedFolders()).map((folder) => folder.folderId));
    const toStore: { folderId: string; nodes: DriveNode[] }[] = [];
    for (const [folderId, rawNodes] of listings) {
      if (this.opsHooks?.isPendingDeleted?.(folderId) === true) {
        continue;
      }
      const nodes = this.opsHooks?.overlayListing
        ? this.opsHooks.overlayListing(folderId, rawNodes)
        : rawNodes;
      if (this.queryClient.getQueryData(childrenKey(folderId)) === undefined) {
        this.queryClient.setQueryData(childrenKey(folderId), nodes, {
          updatedAt: CACHE_STALE_TIMESTAMP,
        });
      }
      if (!stored.has(folderId)) {
        toStore.push({ folderId, nodes });
      }
    }
    if (toStore.length > 0) {
      await writeCachedFolders(toStore);
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}

export const VaultSyncContext = createContext<VaultSync | null>(null);

export function useVaultSync(): VaultSync | null {
  return useContext(VaultSyncContext);
}

const IDLE: VaultSyncSnapshot = {
  pinned: false,
  running: false,
  total: 0,
  cached: 0,
  lastSyncedAt: null,
  failed: 0,
  truncated: false,
  error: null,
};
const noSubscribe = () => () => {};
const idleSnapshot = () => IDLE;

export function useVaultSyncState(): VaultSyncSnapshot {
  const sync = useVaultSync();
  return useSyncExternalStore(
    sync?.subscribe ?? noSubscribe,
    sync?.getSnapshot ?? idleSnapshot,
    sync?.getSnapshot ?? idleSnapshot,
  );
}
