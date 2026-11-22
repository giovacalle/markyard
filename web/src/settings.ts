import { useSyncExternalStore } from "react";

// App-wide settings edited in the Settings dialog: vault folder names and editor defaults.
// Persisted per device in localStorage and, when the BFF has cloud sync, synced through
// `/api/state` by `cloudState.ts`.

export const SETTINGS_STORAGE_KEY = "markyard:settings";

export type DefaultMode = "preview" | "edit";

export interface AppSettings {
  /** Root subfolder that receives uploaded images. */
  attachmentsFolder: string;
  /** Root subfolder for daily notes; empty means the vault root. */
  dailyNotesFolder: string;
  /** Root subfolder whose notes are templates. */
  templatesFolder: string;
  /** How a note opens when read-only mode is off. */
  defaultMode: DefaultMode;
  /** Hover cards and bookmark cards for external links in Preview. */
  linkPreviewsEnabled: boolean;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  attachmentsFolder: "_attachments",
  dailyNotesFolder: "",
  templatesFolder: "Templates",
  defaultMode: "preview",
  linkPreviewsEnabled: true,
});

/** Settings fields synced to the cloud, in a stable order. */
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

const MAX_NAME_BYTES = 255;

/** Why `name` cannot be a vault subfolder name, or `null` when it can. */
export function validateFolderSetting(
  name: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return allowEmpty ? null : "Enter a folder name.";
  }
  if (trimmed.includes("/")) {
    return "A folder name cannot contain “/”.";
  }
  if (trimmed === "." || trimmed === "..") {
    return "“.” and “..” are not valid folder names.";
  }
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) {
    return "This folder name is too long.";
  }
  return null;
}

function isDefaultMode(value: unknown): value is DefaultMode {
  return value === "preview" || value === "edit";
}

/** The valid fields of `raw`, normalized; anything else is dropped. */
export function sanitizeSettings(raw: unknown): Partial<AppSettings> {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const input = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  const folder = (key: "attachmentsFolder" | "dailyNotesFolder" | "templatesFolder") => {
    const value = input[key];
    if (
      typeof value === "string" &&
      validateFolderSetting(value, { allowEmpty: key === "dailyNotesFolder" }) === null
    ) {
      out[key] = value.trim();
    }
  };
  folder("attachmentsFolder");
  folder("dailyNotesFolder");
  folder("templatesFolder");
  if (isDefaultMode(input.defaultMode)) {
    out.defaultMode = input.defaultMode;
  }
  if (typeof input.linkPreviewsEnabled === "boolean") {
    out.linkPreviewsEnabled = input.linkPreviewsEnabled;
  }
  return out;
}

export interface SettingsChange {
  /** The change came from the cloud, not from the user: nothing to push back. */
  silent: boolean;
}

let current: AppSettings | null = null;
const listeners = new Set<(change: SettingsChange) => void>();

function load(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    return { ...DEFAULT_SETTINGS, ...sanitizeSettings(raw === null ? {} : JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function emit(change: SettingsChange): void {
  for (const listener of listeners) {
    listener(change);
  }
}

export function getSettings(): AppSettings {
  current ??= load();
  return current;
}

/**
 * Applies the valid fields of `patch`. `silent` marks changes adopted from the cloud, so cloud
 * sync does not echo them back as local edits.
 */
export function updateSettings(
  patch: Partial<AppSettings>,
  { silent = false }: { silent?: boolean } = {},
): void {
  const prev = getSettings();
  const next = { ...prev, ...sanitizeSettings(patch) };
  if (SETTINGS_KEYS.every((key) => prev[key] === next[key])) {
    return;
  }
  current = next;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the settings still apply to this session.
  }
  emit({ silent });
}

/**
 * Back to the defaults and drops the stored copy (sign-out, account switch). `keepStorage` only
 * drops the in-memory copy, so the next read reloads storage (tests).
 */
export function resetSettings({ keepStorage = false }: { keepStorage?: boolean } = {}): void {
  current = null;
  if (!keepStorage) {
    try {
      window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
  emit({ silent: true });
}

export function subscribeSettings(listener: (change: SettingsChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribeSettings, getSettings);
}
