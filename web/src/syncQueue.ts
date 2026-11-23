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
  discardPendingWrite,
  readAllPendingWrites,
  readPendingWrite,
  rebasePendingWrite,
  updateCachedFileRevision,
  upsertPendingWrite,
  writeCachedFile,
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
  discardVersions: ReadonlyMap<string, number>;
}

interface EpochToken {
  global: number;
  file: number;
}

export class SyncQueue {
  private readonly queryClient: QueryClient;
  private readonly onNetworkError?: () => void;
  private readonly onNetworkSuccess?: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly states = new Map<string, FileSyncState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly inFlightControllers = new Map<string, AbortController>();
  private readonly renaming = new Map<string, Promise<void>>();
  private readonly writeChains = new Map<string, Promise<unknown>>();
  private readonly syncedRevisions = new Map<string, string>();
  /** Drive text that `syncedRevisions` names, when known (it becomes a queued edit's base text). */
  private readonly syncedTexts = new Map<string, string>();
  /** Files whose `syncedRevisions` came from our own confirmed upload (safe for rapid chaining). */
  private readonly syncedBySelf = new Set<string>();
  /** Files explicitly deleted in this session; suppresses stale unmount flushes and late writes. */
  private readonly deletedFiles = new Set<string>();
  /** Bumped when a SyncInspector discard reverts a file so open sessions adopt the reverted text. */
  private readonly discardVersions = new Map<string, number>();
  /** Bumped by every local write and acknowledged upload: stale background reads compare it. */
  private readonly generations = new Map<string, number>();
  /** Global and per-file cancellation epochs: bumped by `resetAll`, `discardFile`, `cancelDeletedFile`. */
  private globalEpoch = 0;
  private readonly fileEpochs = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private snapshot: SyncSnapshot = {
    byFile: new Map(),
    pendingCount: 0,
    discardVersions: new Map(),
  };
  private disposed = false;

  constructor(
    queryClient: QueryClient,
    callbacks?: { onNetworkError?: () => void; onNetworkSuccess?: () => void },
  ) {
    this.queryClient = queryClient;
    this.onNetworkError = callbacks?.onNetworkError;
    this.onNetworkSuccess = callbacks?.onNetworkSuccess;
  }

  /** Monotonic counter bumped on `resetAll()` (sign-out / vault switch). */
  get sessionEpoch(): number {
    return this.globalEpoch;
  }

  /** Whether `fileId` was explicitly deleted in the current session. */
  isDeleted(fileId: string): boolean {
    return this.deletedFiles.has(fileId);
  }

  /** Monotonic discard counter for `fileId`, bumped when SyncInspector discards local edits. */
  discardVersion(fileId: string): number {
    return this.discardVersions.get(fileId) ?? 0;
  }

  private captureEpoch(fileId: string): EpochToken {
    return { global: this.globalEpoch, file: this.fileEpochs.get(fileId) ?? 0 };
  }

  private isCurrent(fileId: string, token: EpochToken): boolean {
    return (
      !this.disposed &&
      this.globalEpoch === token.global &&
      (this.fileEpochs.get(fileId) ?? 0) === token.file
    );
  }

  private bumpFileEpoch(fileId: string): void {
    this.fileEpochs.set(fileId, (this.fileEpochs.get(fileId) ?? 0) + 1);
  }

  private abortInFlight(fileId: string): void {
    const controller = this.inFlightControllers.get(fileId);
    if (controller !== undefined) {
      this.inFlightControllers.delete(fileId);
      controller.abort();
    }
    this.inFlight.delete(fileId);
  }

  private abortAllInFlight(): void {
    for (const controller of this.inFlightControllers.values()) {
      controller.abort();
    }
    this.inFlightControllers.clear();
    this.inFlight.clear();
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
      discardVersions: new Map(this.discardVersions),
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

  private setSynced(
    fileId: string,
    revision: string,
    text: string | undefined,
    bySelf = false,
  ): void {
    this.syncedRevisions.set(fileId, revision);
    if (text === undefined) {
      this.syncedTexts.delete(fileId);
    } else {
      this.syncedTexts.set(fileId, text);
    }
    if (bySelf) {
      this.syncedBySelf.add(fileId);
    } else {
      this.syncedBySelf.delete(fileId);
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
    const epoch = this.captureEpoch(fileId);
    this.setFileState(fileId, {
      status: "error",
      error,
      retry: { attempt, maxAttempts: MAX_AUTO_RETRIES, at: Date.now() + delay },
    });
    this.retryTimers.set(
      fileId,
      setTimeout(() => {
        this.retryTimers.delete(fileId);
        if (this.isCurrent(fileId, epoch)) {
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
    epoch: EpochToken,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "done"; remote: RemoteSnapshot }
    | { kind: "rebased" }
    | { kind: "conflict" }
    | { kind: "unreachable"; error: unknown }
  > {
    let remote: RemoteSnapshot;
    try {
      remote = await fetchContent(entry.fileId, signal);
    } catch (error) {
      return { kind: "unreachable", error };
    }
    if (!this.isCurrent(entry.fileId, epoch)) {
      return { kind: "conflict" };
    }
    if (remote.revision.length === 0) {
      return { kind: "conflict" };
    }
    if (remote.text === entry.text) {
      return { kind: "done", remote };
    }
    if (entry.baseText !== undefined && remote.text === entry.baseText) {
      await this.chainWrite(entry.fileId, async () => {
        if (!this.isCurrent(entry.fileId, epoch)) {
          return;
        }
        await rebasePendingWrite(entry.fileId, remote.revision);
      });
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
    const globalEpoch = this.globalEpoch;
    const entries = await readAllPendingWrites();
    if (this.disposed || this.globalEpoch !== globalEpoch || entries.length === 0) {
      return;
    }
    let changed = false;
    for (const entry of entries) {
      if (this.deletedFiles.has(entry.fileId)) {
        continue;
      }
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
    if (this.disposed || this.deletedFiles.has(fileId)) {
      return;
    }
    const synced = this.syncedRevisions.get(fileId);
    const syncedText = this.syncedTexts.get(fileId);
    // Only inherit `syncedRevisions` when the caller has no tag, already names that tag, is
    // chaining on our own confirmed upload, or proves its base text matches the observed remote
    // revision. Otherwise keep the caller's tag so an unrelated background GET never masks a 412.
    const canInheritSynced =
      synced !== undefined &&
      (fallbackRevision.length === 0 ||
        synced === fallbackRevision ||
        this.syncedBySelf.has(fileId) ||
        (fallbackBaseText !== undefined && syncedText === fallbackBaseText));
    const revision = canInheritSynced ? synced : fallbackRevision;
    const baseText = canInheritSynced ? (syncedText ?? fallbackBaseText) : fallbackBaseText;
    const epoch = this.captureEpoch(fileId);
    this.bumpGeneration(fileId);
    this.cancelRetry(fileId);
    this.retryAttempts.delete(fileId);
    this.queryClient.setQueryData(["files", fileId, "content"], { text, revision });
    this.setFileState(fileId, isOnline() ? { status: "syncing" } : { status: "pending" });

    const writePromise = this.chainWrite(fileId, async () => {
      if (!this.isCurrent(fileId, epoch)) {
        return undefined;
      }
      return upsertPendingWrite(fileId, text, revision, baseText);
    });
    void writePromise.then((written) => {
      if (written === undefined || !this.isCurrent(fileId, epoch)) {
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
    if (this.disposed || this.deletedFiles.has(fileId) || revision.length === 0) {
      return;
    }
    if (this.inFlight.has(fileId) || this.renaming.has(fileId)) {
      return;
    }
    const state = this.states.get(fileId);
    if (state?.status === "pending" || state?.status === "syncing" || state?.status === "error") {
      return;
    }
    this.setSynced(fileId, revision, text, false);
  }

  /**
   * Renames a file while serialized against any in-flight content upload for the same file, then
   * propagates Drive's refreshed ETag for clean files. Files with pending/errored edits keep their
   * outbox `baseRevision` so `reconcile()` verifies Drive's text before rebasing.
   */
  renameFile(fileId: string, name: string): Promise<{ node: DriveNode; revision: string }> {
    return this.patchMetadata(fileId, () => apiRenameFile(fileId, name));
  }

  /**
   * Moves a file to another folder, serialized like a rename: clean files adopt Drive's fresh ETag,
   * while queued/conflicted files keep their outbox `baseRevision` for safe reconciliation.
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

      const epoch = this.captureEpoch(fileId);
      const result = await call();
      if (this.isCurrent(fileId, epoch) && result.revision.length > 0) {
        const state = this.states.get(fileId);
        const hasQueued =
          state?.status === "pending" || state?.status === "syncing" || state?.status === "error";
        if (!hasQueued) {
          const updatedClean = await this.chainWrite(fileId, async () => {
            if (!this.isCurrent(fileId, epoch)) {
              return false;
            }
            return updateCachedFileRevision(fileId, result.revision);
          });
          if (updatedClean && this.isCurrent(fileId, epoch)) {
            const latest = this.states.get(fileId);
            const stillClean =
              latest?.status !== "pending" &&
              latest?.status !== "syncing" &&
              latest?.status !== "error";
            if (stillClean) {
              // PATCH does not return Drive's current text: clear `syncedTexts` so a dirty draft
              // on an unseen remote edit still reconciles against Drive instead of clobbering it.
              this.setSynced(fileId, result.revision, undefined, false);
              this.queryClient.setQueryData<{ text: string; revision: string }>(
                ["files", fileId, "content"],
                (prev) => (prev === undefined ? prev : { ...prev, revision: result.revision }),
              );
            }
          }
        }
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
    if (this.disposed || this.deletedFiles.has(fileId)) {
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

    const epoch = this.captureEpoch(fileId);
    const controller = new AbortController();
    this.inFlightControllers.set(fileId, controller);

    const run = (async () => {
      let reconciledSeq: number | null = null;
      while (this.isCurrent(fileId, epoch)) {
        const pendingRename = this.renaming.get(fileId);
        if (pendingRename !== undefined) {
          await pendingRename.catch(() => undefined);
          continue;
        }
        const pendingWrite = this.writeChains.get(fileId);
        if (pendingWrite !== undefined) {
          await pendingWrite.catch(() => undefined);
        }
        if (!this.isCurrent(fileId, epoch)) {
          return;
        }
        // Re-check rename gate in case a rename started while awaiting IndexedDB writes.
        if (this.renaming.has(fileId)) {
          continue;
        }
        const entry = await readPendingWrite(fileId);
        if (entry === undefined || !this.isCurrent(fileId, epoch)) {
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
            newRevision = await saveContent(
              entry.fileId,
              entry.text,
              entry.baseRevision,
              controller.signal,
            );
          } catch (error) {
            if (!this.isCurrent(fileId, epoch)) {
              return;
            }
            if (
              reconciledSeq === entry.seq ||
              !(isConflict(error) || isPreconditionRequired(error))
            ) {
              throw error;
            }
            reconciledSeq = entry.seq;
            const outcome = await this.reconcile(entry, epoch, controller.signal);
            if (!this.isCurrent(fileId, epoch)) {
              return;
            }
            if (outcome.kind === "rebased") {
              continue;
            }
            if (outcome.kind === "unreachable") {
              // Propagate the read error (401, 404, 429, 5xx, network) instead of masking it as 412.
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
          if (!this.isCurrent(fileId, epoch)) {
            return;
          }
          this.onNetworkSuccess?.();
          this.retryAttempts.delete(fileId);
          this.bumpGeneration(fileId);
          this.setSynced(fileId, newRevision, syncedText, true);
          const next = await this.chainWrite(fileId, async () => {
            if (!this.isCurrent(fileId, epoch)) {
              return undefined;
            }
            return completePendingWrite(fileId, entry.seq, entry.text, newRevision);
          });
          if (next === undefined || !this.isCurrent(fileId, epoch)) {
            return;
          }
          this.queryClient.setQueryData(["files", fileId, "content"], {
            text: next !== null ? next.text : entry.text,
            revision: newRevision,
          });
          if (next === null) {
            this.setFileState(fileId, { status: "synced" });
            return;
          }
          // A newer local edit arrived while the PUT was in flight: loop immediately with the new ETag.
        } catch (error) {
          if (!this.isCurrent(fileId, epoch)) {
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
      if (this.inFlight.get(fileId) === run) {
        this.inFlight.delete(fileId);
      }
      if (this.inFlightControllers.get(fileId) === controller) {
        this.inFlightControllers.delete(fileId);
      }
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
    const globalEpoch = this.globalEpoch;
    const entries = await readAllPendingWrites();
    if (this.disposed || this.globalEpoch !== globalEpoch) {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => !this.deletedFiles.has(entry.fileId))
        .map((entry) => this.flushFile(entry.fileId)),
    );
  }

  /**
   * Discards any queued local write for `fileId`, cancelling any in-flight PUT.
   * When `confirmedRevision` is omitted (SyncInspector "Discard"), reverts `db.files` and React
   * Query to the outbox entry's `baseText`/`baseRevision` (or removes the cached file if unknown)
   * and signals any open session to adopt the reverted content.
   */
  discardFile(fileId: string, confirmedRevision?: string, confirmedText?: string): Promise<void> {
    this.bumpFileEpoch(fileId);
    this.abortInFlight(fileId);
    this.cancelRetry(fileId);
    this.retryAttempts.delete(fileId);
    this.bumpGeneration(fileId);
    const epoch = this.captureEpoch(fileId);
    const generation = this.writeGeneration(fileId);
    if (confirmedRevision !== undefined) {
      this.setSynced(fileId, confirmedRevision, confirmedText, false);
      this.setFileState(fileId, IDLE_STATE);
      return this.chainWrite(fileId, async () => {
        if (!this.isCurrent(fileId, epoch)) {
          return;
        }
        await deletePendingWrite(fileId);
        if (confirmedText !== undefined) {
          await writeCachedFile(fileId, confirmedText, confirmedRevision);
        }
      });
    }
    this.syncedBySelf.delete(fileId);
    this.setFileState(fileId, IDLE_STATE);
    return this.chainWrite(fileId, async () => {
      if (!this.isCurrent(fileId, epoch)) {
        return;
      }
      const { reverted, hadPending } = await discardPendingWrite(fileId);
      if (!this.isCurrent(fileId, epoch) || this.writeGeneration(fileId) !== generation) {
        return;
      }
      if (reverted !== null) {
        if (reverted.revision.length > 0) {
          this.setSynced(fileId, reverted.revision, reverted.text, false);
        } else {
          this.syncedRevisions.delete(fileId);
          this.syncedTexts.delete(fileId);
        }
        this.queryClient.setQueryData(["files", fileId, "content"], reverted);
        this.discardVersions.set(fileId, (this.discardVersions.get(fileId) ?? 0) + 1);
        this.emit();
        if (isOnline()) {
          void this.queryClient.invalidateQueries({
            queryKey: ["files", fileId, "content"],
            exact: true,
          });
        }
      } else if (hadPending) {
        this.syncedRevisions.delete(fileId);
        this.syncedTexts.delete(fileId);
        this.discardVersions.set(fileId, (this.discardVersions.get(fileId) ?? 0) + 1);
        this.emit();
        this.queryClient.removeQueries({
          queryKey: ["files", fileId, "content"],
          exact: true,
        });
      }
    });
  }

  /**
   * Permanently cancels any queued or in-flight sync for a deleted file so neither an in-flight
   * PUT nor an unmounting editor can resurrect it in the cache or outbox.
   */
  cancelDeletedFile(fileId: string): Promise<void> {
    this.deletedFiles.add(fileId);
    this.bumpFileEpoch(fileId);
    this.abortInFlight(fileId);
    this.cancelRetry(fileId);
    this.retryAttempts.delete(fileId);
    this.bumpGeneration(fileId);
    this.syncedRevisions.delete(fileId);
    this.syncedTexts.delete(fileId);
    this.syncedBySelf.delete(fileId);
    this.setFileState(fileId, IDLE_STATE);
    return this.chainWrite(fileId, () => deletePendingWrite(fileId));
  }

  resetAll(): void {
    this.globalEpoch += 1;
    this.fileEpochs.clear();
    this.abortAllInFlight();
    this.cancelAllRetries();
    this.states.clear();
    this.syncedRevisions.clear();
    this.syncedTexts.clear();
    this.syncedBySelf.clear();
    this.deletedFiles.clear();
    this.discardVersions.clear();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.globalEpoch += 1;
    this.abortAllInFlight();
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

export function useFileDiscardVersion(fileId: string): number {
  const queue = useSyncQueue();
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return snapshot.discardVersions.get(fileId) ?? 0;
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
