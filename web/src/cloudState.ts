import { useEffect, useRef } from "react";
import {
  fetchCloudState,
  putCloudState,
  type CloudStateResponse,
  type CloudUserState,
} from "./api";
import { readCloudStateStamp, writeCloudStateStamp } from "./cloudStateStamp";
import {
  forgetLastOpenFile,
  getOpenFileId,
  openRestoredFile,
  readLastOpenFile,
  subscribeOpenDocument,
  wasRestoredFile,
} from "./openDocument";
import {
  getStoredTheme,
  isThemePreference,
  subscribeThemePreference,
  type ThemePreference,
} from "./theme";
import {
  readExpandedFolders,
  subscribeExpandedFolders,
  writeExpandedFolders,
} from "./treeExpanded";
import {
  getSettings,
  sanitizeSettings,
  SETTINGS_KEYS,
  subscribeSettings,
  updateSettings,
} from "./settings";
import { getViewPrefs, setViewPref, subscribeViewPrefs, type ViewPrefKey } from "./viewPrefs";

// Optional multi-device sync of UI preferences through `/api/state` (D1 on the BFF). Runs only
// while `session.cloudSync` is true; otherwise nothing here touches the network. Best-effort:
// every failure is swallowed, and preferences keep working locally.
//
// Conflict rule: last writer wins by `updatedAt`. This device's side is the stamp in
// `cloudStateStamp.ts`, bumped on every local change, so edits made offline still win later.

export const CLOUD_STATE_PUSH_DELAY_MS = 1000;

const VIEW_PREF_KEYS: readonly ViewPrefKey[] = [
  "readOnly",
  "focusMode",
  "typewriterMode",
  "infoDrawerOpen",
];

/** Every synced field this device owns. `rootFolderId` belongs to the BFF and is only echoed. */
type FullState = Required<Omit<CloudUserState, "rootFolderId">>;

/** This device's current synced preferences. */
export function readLocalCloudState(rootFolderId: string): FullState {
  const prefs = getViewPrefs();
  return {
    theme: getStoredTheme(),
    lastOpenFileId: getOpenFileId() ?? readLastOpenFile(),
    expandedFolders: readExpandedFolders(rootFolderId),
    readOnly: prefs.readOnly,
    focusMode: prefs.focusMode,
    typewriterMode: prefs.typewriterMode,
    infoDrawerOpen: prefs.infoDrawerOpen,
    ...getSettings(),
  };
}

function stateKey(state: FullState): string {
  return JSON.stringify(state);
}

/** `remote`'s valid fields over `base`: what this device looks like once `remote` is applied. */
function mergeRemote(base: FullState, remote: CloudUserState): FullState {
  const merged = { ...base };
  if (isThemePreference(remote.theme)) {
    merged.theme = remote.theme;
  }
  if (remote.lastOpenFileId === null || typeof remote.lastOpenFileId === "string") {
    merged.lastOpenFileId = remote.lastOpenFileId;
  }
  if (Array.isArray(remote.expandedFolders)) {
    merged.expandedFolders = remote.expandedFolders.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  }
  for (const key of VIEW_PREF_KEYS) {
    if (typeof remote[key] === "boolean") {
      merged[key] = remote[key];
    }
  }
  Object.assign(merged, sanitizeSettings(remote));
  return merged;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export interface CloudStateSyncOptions {
  rootFolderId: string;
  /** Applies a theme coming from the cloud (the app's `useTheme` setter). */
  setTheme: (theme: ThemePreference) => void;
  pushDelayMs?: number;
}

/** Starts syncing; returns the function that stops it. */
export function startCloudStateSync({
  rootFolderId,
  setTheme,
  pushDelayMs = CLOUD_STATE_PUSH_DELAY_MS,
}: CloudStateSyncOptions): () => void {
  let stopped = false;
  /** The server answered `enabled: false`: nothing more to do this session. */
  let disabled = false;
  /** The first GET succeeded, so pushes may go out. */
  let hydrated = false;
  let applying = false;
  /** The server's `updatedAt` last agreed on. */
  let lastSyncedAt = 0;
  let lastKey = stateKey(readLocalCloudState(rootFolderId));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  /** The vault folder the server's state names; sent back unchanged so a PUT never drops it. */
  let remoteRootFolderId: string | null | undefined;

  const rememberRemoteRoot = (state: CloudUserState | null) => {
    const root = state?.rootFolderId;
    if (root === null || typeof root === "string") {
      remoteRootFolderId = root;
    }
  };

  const snapshot = (): CloudUserState => {
    const local: CloudUserState = readLocalCloudState(rootFolderId);
    return remoteRootFolderId === undefined
      ? local
      : { ...local, rootFolderId: remoteRootFolderId };
  };

  const canTalk = () => !stopped && !disabled && isOnline();

  const schedulePush = () => {
    clearTimeout(timer);
    if (!hydrated || !canTalk()) {
      // Hydration (now or when back online) compares stamps and pushes then.
      return;
    }
    timer = setTimeout(() => void push(), pushDelayMs);
  };

  /** A synced preference may have changed here: bump the stamp and push if it did. */
  const onLocalChange = () => {
    if (applying || stopped) {
      return;
    }
    const key = stateKey(readLocalCloudState(rootFolderId));
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    writeCloudStateStamp(Math.max(Date.now(), readCloudStateStamp() + 1));
    schedulePush();
  };

  const applyRemote = (remote: CloudUserState, updatedAt: number) => {
    const before = readLocalCloudState(rootFolderId);
    const target = mergeRemote(before, remote);
    applying = true;
    try {
      if (target.theme !== before.theme) {
        setTheme(target.theme);
      }
      for (const key of VIEW_PREF_KEYS) {
        setViewPref(key, target[key]);
      }
      updateSettings(Object.fromEntries(SETTINGS_KEYS.map((key) => [key, target[key]])), {
        silent: true,
      });
      if (stateKey({ ...before, expandedFolders: target.expandedFolders }) !== stateKey(before)) {
        writeExpandedFolders(rootFolderId, target.expandedFolders);
      }
      // Follow the other device's note only while the user has not picked one here.
      const open = getOpenFileId();
      if (open === null || wasRestoredFile(open)) {
        if (target.lastOpenFileId !== null) {
          openRestoredFile(target.lastOpenFileId);
        } else if (open === null) {
          forgetLastOpenFile();
        }
      }
    } finally {
      applying = false;
    }
    writeCloudStateStamp(updatedAt);
    lastSyncedAt = updatedAt;
    lastKey = stateKey(readLocalCloudState(rootFolderId));
    if (lastKey !== stateKey(target)) {
      // Part of the cloud state did not apply (a note picked here): this device is now newer.
      lastKey = "";
      onLocalChange();
    }
  };

  /** Adopts the server's answer when it is newer than this device. */
  const settle = (response: CloudStateResponse) => {
    if (!response.enabled) {
      disabled = true;
      clearTimeout(timer);
      return;
    }
    if (response.state === null || response.updatedAt === null) {
      return;
    }
    rememberRemoteRoot(response.state);
    const local = readCloudStateStamp();
    if (local === 0 || response.updatedAt > local) {
      applyRemote(response.state, response.updatedAt);
    } else {
      // Equal stamps: in sync. Local newer: `lastSyncedAt` stays behind, so a push follows.
      lastSyncedAt = response.updatedAt;
    }
  };

  const push = async (): Promise<void> => {
    clearTimeout(timer);
    if (!canTalk()) {
      return;
    }
    if (inFlight !== null) {
      // One PUT at a time; the newer snapshot follows once this one lands.
      await inFlight;
      return readCloudStateStamp() > lastSyncedAt ? push() : undefined;
    }
    let stamp = readCloudStateStamp();
    if (stamp === 0) {
      stamp = Date.now();
      writeCloudStateStamp(stamp);
    }
    inFlight = (async () => {
      try {
        const response = await putCloudState(snapshot(), stamp);
        if (!stopped) {
          settle(response);
        }
      } catch {
        // Best-effort: the stamp stays ahead of `lastSyncedAt`, so a reconnect retries.
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  const hydrate = async (): Promise<void> => {
    if (!canTalk()) {
      return;
    }
    let response: CloudStateResponse;
    try {
      response = await fetchCloudState();
    } catch {
      return;
    }
    if (stopped) {
      return;
    }
    hydrated = response.enabled;
    if (!response.enabled || response.state === null || response.updatedAt === null) {
      settle(response);
      if (response.enabled) {
        // First use of cloud sync: seed it with this device's preferences.
        await push();
      }
      return;
    }
    settle(response);
    if (readCloudStateStamp() > response.updatedAt) {
      // Changes made here (for example offline) are newer than the cloud's.
      await push();
    }
  };

  /** Back online or back in view: push what is pending, else look for other devices' changes. */
  const resync = () => {
    if (!canTalk()) {
      return;
    }
    if (hydrated && readCloudStateStamp() > lastSyncedAt) {
      void push();
    } else {
      void hydrate();
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      resync();
    }
  };

  const unsubscribers = [
    subscribeThemePreference(onLocalChange),
    subscribeViewPrefs(onLocalChange),
    subscribeSettings(({ silent }) => {
      if (!silent) {
        onLocalChange();
      }
    }),
    subscribeExpandedFolders((root) => {
      if (root === rootFolderId) {
        onLocalChange();
      }
    }),
    subscribeOpenDocument(onLocalChange),
  ];
  window.addEventListener("online", resync);
  document.addEventListener("visibilitychange", onVisibility);
  void hydrate();

  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    window.removeEventListener("online", resync);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Syncs preferences through `/api/state` while `enabled` (i.e. `session.cloudSync === true`). */
export function useCloudStateSync({
  enabled,
  rootFolderId,
  setTheme,
}: {
  enabled: boolean;
  rootFolderId: string | undefined;
  setTheme: (theme: ThemePreference) => void;
}): void {
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;
  useEffect(() => {
    if (!enabled || rootFolderId === undefined) {
      return;
    }
    return startCloudStateSync({
      rootFolderId,
      setTheme: (theme) => setThemeRef.current(theme),
    });
  }, [enabled, rootFolderId]);
}
