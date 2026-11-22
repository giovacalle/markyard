import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";
import {
  ApiError,
  fetchContent,
  isConflict,
  isNotFound,
  isPreconditionRequired,
  isTooLarge,
  isTransientError,
  isUnauthenticated,
  moveFile as apiMoveFile,
  renameFile as apiRenameFile,
  saveContent,
  type DriveNode,
} from "./api";
import {
  completePendingWrite,
  deletePendingWrite,
  readAllPendingWrites,
  readPendingWrite,
  updateCachedFileRevision,
  upsertPendingWrite,
  type PendingWrite,
} from "./localCache";

export type FileSyncState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "syncing" }
  | { status: "synced" }
  | {
      status: "error";
      error: unknown;
      /** Set while an automatic retry is scheduled: which attempt comes next, and when. */
      retry?: { attempt: number; maxAttempts: number; at: number };
    };

/** Automatic retries for transient failures (network, 408, 429, 5xx) before waiting for the user. */
export const MAX_AUTO_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

/** Exponential backoff with a little jitter; honours the server's `Retry-After` when it sends one. */
export function retryDelayMs(attempt: number, error: unknown): number {
  if (error instanceof ApiError && error.retryAfter !== undefined) {
    return Math.min(Math.max(error.retryAfter * 1000, RETRY_BASE_DELAY_MS), RETRY_MAX_DELAY_MS);
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = 1 + Math.random() * 0.25;
  return Math.min(Math.round(exponential * jitter), RETRY_MAX_DELAY_MS);
}

const IDLE_STATE: FileSyncState = { status: "idle" };

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function isPermanentSyncError(error: unknown): boolean {
  return isConflict(error) || isUnauthenticated(error) || isNotFound(error) || isTooLarge(error);
}

/** Drive's current copy, fetched to tell a false conflict from a real one. */
type RemoteSnapshot = { text: string; revision: string };

interface SyncSnapshot {
  byFile: ReadonlyMap<string, FileSyncState>;
  pendingCount: number;
}

export class SyncQueue {
  private readonly queryClient: QueryClient;
  private readonly onNetworkError?: () => void;
  private readonly onNetworkSuccess?: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly states = new Map<string, FileSyncState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly renaming = new Map<string, Promise<void>>();
  private readonly writeChains = new Map<string, Promise<unknown>>();
  private readonly syncedRevisions = new Map<string, string>();
  /** Drive text that `syncedRevisions` names, when known (it becomes a queued edit's base text). */
  private readonly syncedTexts = new Map<string, string>();
  /** Bumped by every local write and acknowledged upload: stale background reads compare it. */
  private readonly generations = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private snapshot: SyncSnapshot = { byFile: new Map(), pendingCount: 0 };
  private disposed = false;

  constructor(
    queryClient: QueryClient,
    callbacks?: { onNetworkError?: () => void; onNetworkSuccess?: () => void },
  ) {
    this.queryClient = queryClient;
    this.onNetworkError = callbacks?.onNetworkError;
    this.onNetworkSuccess = callbacks?.onNetworkSuccess;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SyncSnapshot => this.snapshot;

  getFileState(fileId: string): FileSyncState {
    return this.snapshot.byFile.get(fileId) ?? IDLE_STATE;
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    let pendingCount = 0;
    for (const state of this.states.values()) {
      if (state.status === "pending" || state.status === "syncing" || state.status === "error") {
        pendingCount += 1;
      }
    }
    this.snapshot = {
      byFile: new Map(this.states),
      pendingCount,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setFileState(fileId: string, state: FileSyncState): void {
    if (this.disposed) {
      return;
    }
    if (state.status === "idle") {
      if (!this.states.has(fileId)) {
        return;
      }
      this.states.delete(fileId);
    } else {
      this.states.set(fileId, state);
    }
    this.emit();
  }

  /**
   * A per-file counter that moves whenever a local edit is queued or an upload lands. A background
   * Drive read that started before it moved may carry text older than what is now saved, so its
   * result must not replace the local copy.
   */
  writeGeneration(fileId: string): number {
    return this.generations.get(fileId) ?? 0;
  }

  private bumpGeneration(fileId: string): void {
    this.generations.set(fileId, this.writeGeneration(fileId) + 1);
  }

  private setSynced(fileId: string, revision: string, text: string | undefined): void {
    this.syncedRevisions.set(fileId, revision);
    if (text === undefined) {
      this.syncedTexts.delete(fileId);
    } else {
      this.syncedTexts.set(fileId, text);
    }
  }

  private cancelRetry(fileId: string): void {
    const timer = this.retryTimers.get(fileId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(fileId);
    }
  }

  private cancelAllRetries(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  /** Records a failed upload; transient failures get a bounded, backed-off automatic retry. */
  private fail(fileId: string, error: unknown): void {
    this.cancelRetry(fileId);
    const attempt = (this.retryAttempts.get(fileId) ?? 0) + 1;
    if (!isTransientError(error) || attempt > MAX_AUTO_RETRIES) {
      this.retryAttempts.delete(fileId);
      this.setFileState(fileId, { status: "error", error });
      return;
    }
    this.retryAttempts.set(fileId, attempt);
    const delay = retryDelayMs(attempt, error);
    this.setFileState(fileId, {
      status: "error",
      error,
      retry: { attempt, maxAttempts: MAX_AUTO_RETRIES, at: Date.now() + delay },
    });
    this.retryTimers.set(
      fileId,
      setTimeout(() => {
        this.retryTimers.delete(fileId);
        if (!this.disposed) {
          void this.flushFile(fileId, { force: true, automatic: true });
        }
      }, delay),
    );
  }

  /**
   * After a 412 or 428, reads Drive's copy: if it already holds our text (an earlier upload landed
   * but its answer was lost) the edit is done; if it still holds our base text (only the tag moved)
   * the edit is rebased onto the fresh tag. Anything else is a real conflict.
   */
  private async reconcile(
    entry: PendingWrite,
  ): Promise<
    | { kind: "done"; remote: RemoteSnapshot }
    | { kind: "rebased" }
    | { kind: "conflict" }
    | { kind: "unreachable"; error: unknown }
  > {
    let remote: RemoteSnapshot;
    try {
      remote = await fetchContent(entry.fileId);
    } catch (error) {
      return { kind: "unreachable", error };
    }
    if (remote.revision.length === 0) {
      return { kind: "conflict" };
    }
    if (remote.text === entry.text) {
      return { kind: "done", remote };
    }
    if (entry.baseText !== undefined && remote.text === entry.baseText) {
      await this.chainWrite(entry.fileId, () =>
        updateCachedFileRevision(entry.fileId, remote.revision),
      );
      return { kind: "rebased" };
    }
    return { kind: "conflict" };
  }

  private chainWrite<T>(fileId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(fileId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.writeChains.set(fileId, next);
    void next.finally(() => {
      if (this.writeChains.get(fileId) === next) {
        this.writeChains.delete(fileId);
      }
    });
    return next;
  }

  /**
   * Loads any edits persisted in IndexedDB's outbox from a previous session and triggers a
   * background sync if online.
   */
  async hydrate(canSyncNow: boolean): Promise<void> {
    const entries = await readAllPendingWrites();
    if (this.disposed || entries.length === 0) {
      return;
    }
    let changed = false;
    for (const entry of entries) {
      if (!this.states.has(entry.fileId)) {
        this.states.set(entry.fileId, { status: "pending" });
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
    if (canSyncNow && isOnline()) {
      void this.flushAll();
    }
  }

  /**
   * Saves a note locally in IndexedDB immediately and pushes it to Google Drive in the background.
   */
  enqueueSave(
    fileId: string,
    text: string,
    fallbackRevision: string,
    fallbackBaseText?: string,
  ): void {
    if (this.disposed) {
      return;
    }
    const synced = this.syncedRevisions.get(fileId);
    const revision = synced ?? fallbackRevision;
    const baseText = synced !== undefined ? this.syncedTexts.get(fileId) : fallbackBaseText;
    this.bumpGeneration(fileId);
    this.cancelRetry(fileId);
    this.retryAttempts.delete(fileId);
    this.queryClient.setQueryData(["files", fileId, "content"], { text, revision });
    this.setFileState(fileId, isOnline() ? { status: "syncing" } : { status: "pending" });

    const writePromise = this.chainWrite(fileId, () =>
      upsertPendingWrite(fileId, text, revision, baseText),
    );
    void writePromise.then(() => {
      if (this.disposed) {
        return;
      }
      if (isOnline()) {
        void this.flushFile(fileId, { force: true });
      } else {
        this.setFileState(fileId, { status: "pending" });
      }
    });
  }

  /**
   * Records a freshly loaded remote revision (e.g. from GET /content or POST /files) when no
   * local save or rename is currently in progress, preventing an older in-memory revision from
   * overriding it later.
   */
  observeRemoteRevision(fileId: string, revision: string, text?: string): void {
    if (this.disposed || revision.length === 0) {
      return;
    }
    if (this.inFlight.has(fileId) || this.renaming.has(fileId)) {
      return;
    }
    const state = this.states.get(fileId);
    if (state?.status === "pending" || state?.status === "syncing") {
      return;
    }
    this.setSynced(fileId, revision, text);
  }

  /**
   * Renames a file while serialized against any in-flight content upload for the same file, then
   * propagates Drive's refreshed ETag to memory, IndexedDB (files + outbox), and React Query so
   * the next save does not hit a false 412 conflict.
   */
  renameFile(fileId: string, name: string): Promise<{ node: DriveNode; revision: string }> {
    return this.patchMetadata(fileId, () => apiRenameFile(fileId, name));
  }

  /**
   * Moves a file to another folder, serialized like a rename: Drive answers a fresh ETag for the
   * same text, which every local copy adopts so the next save does not hit a false 412.
   */
  moveFile(fileId: string, parentId: string): Promise<{ node: DriveNode; revision: string }> {
    return this.patchMetadata(fileId, () => apiMoveFile(fileId, parentId));
  }

  private async patchMetadata(
    fileId: string,
    call: () => Promise<{ node: DriveNode; revision: string }>,
  ): Promise<{ node: DriveNode; revision: string }> {
    // Wait for any previous rename or move on the same file to settle.
    const prevRename = this.renaming.get(fileId);
    if (prevRename !== undefined) {
      await prevRename.catch(() => undefined);
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.renaming.set(fileId, gate);

    try {
      // Wait for any active PUT to finish so PATCH never invalidates its If-Match mid-flight.
      const activePut = this.inFlight.get(fileId);
      if (activePut !== undefined) {
        await activePut.catch(() => undefined);
      }

      const result = await call();
      if (!this.disposed && result.revision.length > 0) {
        // A rename or move only touches metadata: the text that the fresh tag names is unchanged.
        this.setSynced(fileId, result.revision, this.syncedTexts.get(fileId));
        await this.chainWrite(fileId, () => updateCachedFileRevision(fileId, result.revision));
        this.queryClient.setQueryData<{ text: string; revision: string }>(
          ["files", fileId, "content"],
          (prev) => (prev === undefined ? prev : { ...prev, revision: result.revision }),
        );
      }
      return result;
    } finally {
      if (this.renaming.get(fileId) === gate) {
        this.renaming.delete(fileId);
      }
      release();
    }
  }

  /**
   * Flushes a single file's queued outbox entry to Google Drive, serializing concurrent saves
   * for the same file and chaining ETags when newer edits arrive mid-upload.
   */
  flushFile(
    fileId: string,
    { force = false, automatic = false }: { force?: boolean; automatic?: boolean } = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!automatic) {
      // A user- or app-driven flush starts a fresh round of automatic retries.
      this.cancelRetry(fileId);
      this.retryAttempts.delete(fileId);
    }
    const existing = this.inFlight.get(fileId);
    if (existing !== undefined) {
      return existing;
    }

    const run = (async () => {
      let reconciled = false;
      while (!this.disposed) {
        const pendingRename = this.renaming.get(fileId);
        if (pendingRename !== undefined) {
          await pendingRename.catch(() => undefined);
          continue;
        }
        const pendingWrite = this.writeChains.get(fileId);
        if (pendingWrite !== undefined) {
          await pendingWrite.catch(() => undefined);
        }
        if (this.disposed) {
          return;
        }
        // Re-check rename gate in case a rename started while awaiting IndexedDB writes.
        if (this.renaming.has(fileId)) {
          continue;
        }
        const entry = await readPendingWrite(fileId);
        if (entry === undefined) {
          return;
        }
        const currentState = this.states.get(fileId);
        if (
          !force &&
          currentState?.status === "error" &&
          isPermanentSyncError(currentState.error)
        ) {
          return;
        }
        if (!isOnline()) {
          this.setFileState(fileId, { status: "pending" });
          return;
        }

        this.setFileState(fileId, { status: "syncing" });
        try {
          let newRevision: string;
          let syncedText = entry.text;
          try {
            if (entry.baseRevision.length === 0) {
              // No usable tag (the BFF would answer 428): reconcile against Drive instead.
              throw new ApiError(428, "precondition_required", "Missing revision tag.");
            }
            newRevision = await saveContent(entry.fileId, entry.text, entry.baseRevision);
          } catch (error) {
            if (reconciled || !(isConflict(error) || isPreconditionRequired(error))) {
              throw error;
            }
            reconciled = true;
            const outcome = await this.reconcile(entry);
            if (this.disposed) {
              return;
            }
            if (outcome.kind === "rebased") {
              continue;
            }
            if (outcome.kind === "unreachable" && !isConflict(error)) {
              // The read that would settle it failed: let the transient-retry path take over.
              throw outcome.error;
            }
            if (outcome.kind !== "done") {
              throw isConflict(error)
                ? error
                : new ApiError(
                    412,
                    "conflict",
                    "Drive did not confirm which version this edit is based on.",
                  );
            }
            newRevision = outcome.remote.revision;
            syncedText = outcome.remote.text;
          }
          if (this.disposed) {
            return;
          }
          this.onNetworkSuccess?.();
          this.retryAttempts.delete(fileId);
          this.bumpGeneration(fileId);
          this.setSynced(fileId, newRevision, syncedText);
          const next = await this.chainWrite(fileId, () =>
            completePendingWrite(fileId, entry.seq, entry.text, newRevision),
          );
          if (this.disposed) {
            return;
          }
          this.queryClient.setQueryData(["files", fileId, "content"], {
            text: next ? next.text : entry.text,
            revision: newRevision,
          });
          if (next === null) {
            this.setFileState(fileId, { status: "synced" });
            return;
          }
          // A newer local edit arrived while the PUT was in flight: loop immediately with the new ETag.
        } catch (error) {
          if (this.disposed) {
            return;
          }
          if (error instanceof TypeError) {
            this.onNetworkError?.();
          }
          if (isUnauthenticated(error)) {
            void this.queryClient.invalidateQueries({ queryKey: ["session"] });
          }
          this.fail(fileId, error);
          return;
        }
      }
    })().finally(() => {
      this.inFlight.delete(fileId);
    });

    this.inFlight.set(fileId, run);
    return run;
  }

  retryFile(fileId: string): Promise<void> {
    return this.flushFile(fileId, { force: true });
  }

  async flushAll(): Promise<void> {
    if (this.disposed || !isOnline()) {
      return;
    }
    const entries = await readAllPendingWrites();
    if (this.disposed) {
      return;
    }
    await Promise.all(entries.map((entry) => this.flushFile(entry.fileId)));
  }

  discardFile(fileId: string, confirmedRevision?: string, confirmedText?: string): Promise<void> {
    this.cancelRetry(fileId);
    this.retryAttempts.delete(fileId);
    this.bumpGeneration(fileId);
    if (confirmedRevision !== undefined) {
      this.setSynced(fileId, confirmedRevision, confirmedText);
    }
    this.setFileState(fileId, IDLE_STATE);
    return this.chainWrite(fileId, () => deletePendingWrite(fileId));
  }

  resetAll(): void {
    this.cancelAllRetries();
    this.states.clear();
    this.syncedRevisions.clear();
    this.syncedTexts.clear();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAllRetries();
    this.listeners.clear();
  }
}

export const SyncQueueContext = createContext<SyncQueue | null>(null);

export function useSyncQueue(): SyncQueue {
  const queue = useContext(SyncQueueContext);
  if (queue === null) {
    throw new Error("useSyncQueue must be used within SyncQueueContext.");
  }
  return queue;
}

export function useFileSyncState(fileId: string): FileSyncState {
  const queue = useSyncQueue();
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return snapshot.byFile.get(fileId) ?? IDLE_STATE;
}

/** Every file the queue tracks, by id: pending, syncing, failed, or just synced. */
export function useSyncStates(): ReadonlyMap<string, FileSyncState> {
  const queue = useSyncQueue();
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot).byFile;
}

export function usePendingSyncCount(): number {
  const queue = useSyncQueue();
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return snapshot.pendingCount;
}
