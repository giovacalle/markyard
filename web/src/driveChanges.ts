import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import {
  ApiError,
  fetchChanges,
  fetchContent,
  fetchStartPageToken,
  isRateLimited,
  isTokenExpired,
  isUnauthenticated,
  type DriveChange,
  type DriveNode,
} from "./api";
import {
  readChangesState,
  readPendingWrite,
  updateChangesState,
  type RecentDriveChange,
} from "./localCache";
import { isLocalId } from "./localIds";
import {
  clearSelfWrites,
  isSelfChange,
  onSelfWrite,
  restoreSelfWrites,
  snapshotSelfWrites,
} from "./selfWrites";
import { childrenKey, knownFolders, listingsContaining } from "./treeCache";

/** Background poll cadence while the app is visible and online. */
export const POLL_INTERVAL_MS = 60_000;
/** Pages drained in one poll; the rest continue on the next one. */
const MAX_PAGES_PER_POLL = 10;
export const MAX_RECENT_CHANGES = 10;
const DEFAULT_RATE_LIMIT_PAUSE_S = 30;

/** The open note changed on Drive by someone else: `at` tells one report from the next. */
export interface ExternalChange {
  fileId: string;
  at: number;
}

interface Snapshot {
  recent: readonly RecentDriveChange[];
  external: ExternalChange | null;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/** The last change per file, in feed order. */
function lastPerFile(changes: readonly DriveChange[]): DriveChange[] {
  const byId = new Map<string, DriveChange>();
  for (const change of changes) {
    byId.delete(change.fileId);
    byId.set(change.fileId, change);
  }
  return [...byId.values()];
}

/**
 * Follows Drive's changes feed (`/api/changes`) for the signed-in account: refreshes only the
 * folder listings a change touches, keeps a short list of notes others updated, and reports when
 * the open note itself changed on Drive.
 */
export class DriveChanges {
  private readonly queryClient: QueryClient;
  private readonly listeners = new Set<() => void>();
  private snapshot: Snapshot = { recent: [], external: null };
  private token: string | null = null;
  private loading: Promise<void> | null = null;
  private polling: Promise<void> | null = null;
  private followUp: Promise<void> | null = null;
  private openFileId: string | null = null;
  private pausedUntil = 0;
  /** Bumped by `reset()`: work begun for a previous account must not land. */
  private epoch = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(queryClient: QueryClient) {
    this.queryClient = queryClient;
  }

  /**
   * Persists our own writes (so a reload does not report them as someone else's) while connected.
   * Returns the disconnect; safe to call again after it (React Strict Mode remounts effects).
   */
  connect(): () => void {
    const unsubscribe = onSelfWrite(() => this.schedulePersistSelfWrites());
    return () => {
      unsubscribe();
      if (this.persistTimer !== null) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private update(next: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) {
      listener();
    }
  }

  setOpenFileId(id: string | null): void {
    this.openFileId = id;
    if (this.snapshot.external !== null && this.snapshot.external.fileId !== id) {
      this.update({ external: null });
    }
  }

  /** The open note's banner or toast was handled: forget the report. */
  dismissExternal(fileId: string): void {
    if (this.snapshot.external?.fileId === fileId) {
      this.update({ external: null });
    }
  }

  private schedulePersistSelfWrites(): void {
    if (this.persistTimer !== null) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void updateChangesState({ selfWrites: snapshotSelfWrites() });
    }, 500);
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const epoch = this.epoch;
      const state = await readChangesState();
      if (epoch !== this.epoch || state === undefined) {
        return;
      }
      this.token ??= state.startPageToken;
      restoreSelfWrites(state.selfWrites);
      if (this.snapshot.recent.length === 0 && state.recent.length > 0) {
        this.update({ recent: state.recent });
      }
    })();
    return this.loading;
  }

  /** Loads the persisted recent list (for the empty workspace) without polling Drive. */
  hydrate(): Promise<void> {
    return this.load();
  }

  /**
   * One poll of the feed. A trigger during a running poll may come after that poll already read
   * the feed, so it queues exactly one follow-up poll (further triggers share that follow-up).
   */
  poll(): Promise<void> {
    if (this.polling !== null) {
      this.followUp ??= this.polling.then(() => {
        this.followUp = null;
        return this.poll();
      });
      return this.followUp;
    }
    this.polling = this.runPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async runPoll(): Promise<void> {
    if (!isOnline() || Date.now() < this.pausedUntil) {
      return;
    }
    const epoch = this.epoch;
    await this.load();
    if (epoch !== this.epoch) {
      return;
    }
    try {
      if (this.token === null) {
        await this.startFresh(epoch);
        return;
      }
      let token = this.token;
      const changes: DriveChange[] = [];
      for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        const result = await fetchChanges(token);
        if (epoch !== this.epoch) {
          return;
        }
        changes.push(...result.changes);
        token = result.nextPageToken;
        if (!result.hasMore) {
          break;
        }
      }
      const openChanged = this.apply(changes);
      this.token = token;
      await updateChangesState({
        startPageToken: token,
        recent: [...this.snapshot.recent],
        selfWrites: snapshotSelfWrites(),
      });
      if (openChanged !== null) {
        await this.checkOpenNote(openChanged, epoch);
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      if (isTokenExpired(error)) {
        // The feed lost our place: start over and re-read every loaded folder once.
        try {
          await this.startFresh(epoch);
          void this.queryClient.invalidateQueries({ queryKey: ["folders"] });
        } catch {
          // Try again on the next trigger.
        }
        return;
      }
      if (isRateLimited(error)) {
        const seconds =
          error instanceof ApiError && error.retryAfter !== undefined
            ? error.retryAfter
            : DEFAULT_RATE_LIMIT_PAUSE_S;
        this.pausedUntil = Date.now() + seconds * 1000;
        return;
      }
      if (isUnauthenticated(error)) {
        void this.queryClient.invalidateQueries({ queryKey: ["session"] });
      }
      // Network or server trouble: the next trigger tries again from the same token.
    }
  }

  private async startFresh(epoch: number): Promise<void> {
    const token = await fetchStartPageToken();
    if (epoch !== this.epoch) {
      return;
    }
    this.token = token;
    await updateChangesState({ startPageToken: token });
  }

  /**
   * Applies a batch of changes to the caches; answers the open note's id when Drive reported
   * someone else changing it.
   */
  private apply(changes: readonly DriveChange[]): string | null {
    const folders = knownFolders(this.queryClient);
    const stale = new Set<string>();
    const added: RecentDriveChange[] = [];
    const removed = new Set<string>();
    let openChanged: string | null = null;

    for (const change of lastPerFile(changes)) {
      const oldParents = listingsContaining(this.queryClient, change.fileId);
      const newParents = change.parentIds.filter((id) => folders.has(id));
      const inVault =
        oldParents.length > 0 ||
        newParents.length > 0 ||
        folders.has(change.fileId) ||
        change.fileId === this.openFileId;
      if (!inVault) {
        continue;
      }
      if (change.removed) {
        removed.add(change.fileId);
      }
      // Our own write: the caches already hold its outcome. The open note is still checked (by
      // its text, so our uploads never raise a banner): someone may have edited it right after.
      if (isSelfChange(change.fileId, change.time)) {
        if (!change.removed && change.fileId === this.openFileId) {
          openChanged = change.fileId;
        }
        continue;
      }
      for (const id of [...oldParents, ...newParents]) {
        stale.add(id);
      }
      const node: DriveNode | undefined = change.node;
      if (!change.removed && node?.kind === "markdown") {
        added.push({
          id: change.fileId,
          name: node.name,
          parentId: newParents[0] ?? change.parentIds[0],
          time: change.time,
        });
        if (change.fileId === this.openFileId) {
          openChanged = change.fileId;
        }
      }
    }

    for (const folderId of stale) {
      void this.queryClient.invalidateQueries({ queryKey: childrenKey(folderId), exact: true });
    }

    if (added.length > 0 || removed.size > 0) {
      const addedIds = new Set(added.map((entry) => entry.id));
      const recent = [
        ...added.sort((a, b) => b.time.localeCompare(a.time)),
        ...this.snapshot.recent.filter((entry) => !addedIds.has(entry.id)),
      ]
        .filter((entry) => !removed.has(entry.id))
        .slice(0, MAX_RECENT_CHANGES);
      this.update({ recent });
    }
    return openChanged;
  }

  /**
   * Reads the open note from Drive and reports it only when Drive's text differs from what this
   * device last knew of it, so our own uploads (or metadata-only changes) never raise a banner.
   */
  private async checkOpenNote(fileId: string, epoch: number): Promise<void> {
    if (isLocalId(fileId)) {
      return;
    }
    let fresh: { text: string; revision: string };
    try {
      fresh = await fetchContent(fileId);
    } catch {
      return;
    }
    const pending = await readPendingWrite(fileId);
    if (epoch !== this.epoch || this.openFileId !== fileId) {
      return;
    }
    let external: boolean;
    if (pending !== undefined) {
      external =
        fresh.revision !== pending.baseRevision &&
        fresh.text !== pending.text &&
        fresh.text !== pending.baseText;
    } else {
      const current = this.queryClient.getQueryData<{ text: string; revision: string }>([
        "files",
        fileId,
        "content",
      ]);
      external = current !== undefined && fresh.text !== current.text;
    }
    if (external) {
      this.update({ external: { fileId, at: Date.now() } });
    }
  }

  /** Forgets everything for the signed-out account (Dexie is cleared by the caller). */
  reset(): void {
    this.epoch += 1;
    this.token = null;
    this.loading = null;
    this.pausedUntil = 0;
    clearSelfWrites();
    this.update({ recent: [], external: null });
  }

  dispose(): void {
    this.epoch += 1;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.listeners.clear();
  }
}

export const DriveChangesContext = createContext<DriveChanges | null>(null);

export function useOptionalDriveChanges(): DriveChanges | null {
  return useContext(DriveChangesContext);
}

export function useDriveChanges(): DriveChanges {
  const changes = useContext(DriveChangesContext);
  if (changes === null) {
    throw new Error("useDriveChanges must be used within DriveChangesContext.");
  }
  return changes;
}

const EMPTY_SNAPSHOT: Snapshot = { recent: [], external: null };
const noSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

/** Without a provider (isolated component tests) there are simply no Drive changes. */
function useChangesSnapshot(): Snapshot {
  const changes = useContext(DriveChangesContext);
  return useSyncExternalStore(
    changes?.subscribe ?? noSubscribe,
    changes?.getSnapshot ?? emptySnapshot,
    changes?.getSnapshot ?? emptySnapshot,
  );
}

export function useRecentDriveChanges(): readonly RecentDriveChange[] {
  return useChangesSnapshot().recent;
}

/** The latest report that `fileId` changed on Drive, or `null`. */
export function useExternalChange(fileId: string): ExternalChange | null {
  const external = useChangesSnapshot().external;
  return external?.fileId === fileId ? external : null;
}

/**
 * Polls the feed while `enabled`: right away, on focus, when the page becomes visible, when the
 * network comes back, and every `POLL_INTERVAL_MS` while visible and online.
 */
export function useDriveChangesPolling(changes: DriveChanges, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const trigger = () => {
      void changes.poll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        trigger();
      }
    };
    trigger();
    window.addEventListener("focus", trigger);
    window.addEventListener("online", trigger);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && isOnline()) {
        trigger();
      }
    }, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", trigger);
      window.removeEventListener("online", trigger);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [changes, enabled]);
}
