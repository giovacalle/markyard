import { useSyncExternalStore } from "react";

// Reading and editing modes shared by the document header, the editor toolbar and the command
// palette. Read-only, focus and typewriter modes survive reloads; the Info Drawer does not, so a
// phone never reopens on an overlay sheet.

export const VIEW_PREFS_STORAGE_KEY = "markyard:view-prefs:v1";

export interface ViewPrefs {
  readOnly: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  infoDrawerOpen: boolean;
}

export type ViewPrefKey = keyof ViewPrefs;

const PERSISTED_KEYS = ["readOnly", "focusMode", "typewriterMode"] as const;

let current: ViewPrefs | null = null;
const listeners = new Set<() => void>();

function load(): ViewPrefs {
  const prefs: ViewPrefs = {
    readOnly: false,
    focusMode: false,
    typewriterMode: false,
    infoDrawerOpen: false,
  };
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(VIEW_PREFS_STORAGE_KEY) ?? "{}");
    if (typeof parsed === "object" && parsed !== null) {
      for (const key of PERSISTED_KEYS) {
        prefs[key] = (parsed as Record<string, unknown>)[key] === true;
      }
    }
  } catch {
    // Corrupt or unavailable storage: keep the defaults.
  }
  return prefs;
}

export function getViewPrefs(): ViewPrefs {
  current ??= load();
  return current;
}

export function setViewPref(key: ViewPrefKey, value: boolean): void {
  const prev = getViewPrefs();
  if (prev[key] === value) {
    return;
  }
  current = { ...prev, [key]: value };
  if (key !== "infoDrawerOpen") {
    const persisted = Object.fromEntries(PERSISTED_KEYS.map((k) => [k, current?.[k] ?? false]));
    try {
      window.localStorage.setItem(VIEW_PREFS_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Ignore storage quota / privacy mode errors: the mode still applies to this session.
    }
  }
  for (const listener of listeners) {
    listener();
  }
}

export function toggleViewPref(key: ViewPrefKey): void {
  setViewPref(key, !getViewPrefs()[key]);
}

/** Drops the in-memory state so the next read reloads storage (tests, sign-out). */
export function resetViewPrefs(): void {
  current = null;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeViewPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useViewPrefs(): ViewPrefs {
  return useSyncExternalStore(subscribeViewPrefs, getViewPrefs);
}
