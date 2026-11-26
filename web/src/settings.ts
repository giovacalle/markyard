import { useSyncExternalStore } from "react";
import { syncThemeColor } from "./theme";

// App-wide settings edited in the Settings dialog: vault folder names and editor defaults.
// Persisted per device in localStorage and, when the BFF has cloud sync, synced through
// `/api/state` by `cloudState.ts`.

export const SETTINGS_STORAGE_KEY = "markyard:settings";

export type DefaultMode = "preview" | "edit";
export type LayoutPreference = "default" | "borderless";

export interface AppSettings {
  /** Root subfolder that receives uploaded images. */
  attachmentsFolder: string;
  /** Whether the root attachments folder is shown in the file tree, move picker and command palette. */
  showAttachmentsFolder: boolean;
  /** Root subfolder for daily notes; empty means the vault root. */
  dailyNotesFolder: string;
  /** Root subfolder whose notes are templates. */
  templatesFolder: string;
  /** Root subfolder whose notes provide custom CSS. */
  stylesFolder: string;
  /** Whether custom CSS from `stylesFolder` is applied. */
  customCss: boolean;
  /** Chrome framing preset: edge-to-edge (`default`) or inset stage (`borderless`). */
  layout: LayoutPreference;
  /** How a note opens when read-only mode is off. */
  defaultMode: DefaultMode;
  /** Hover cards and bookmark cards for external links in Preview. */
  linkPreviewsEnabled: boolean;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  attachmentsFolder: "_attachments",
  showAttachmentsFolder: true,
  dailyNotesFolder: "",
  templatesFolder: "Templates",
  stylesFolder: "_styles",
  customCss: true,
  layout: "default",
  defaultMode: "preview",
  linkPreviewsEnabled: true,
});

/** Every settings field, in a stable order (used for change detection). */
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

/** Settings fields synced to the cloud (`/api/state`), in a stable order. */
export const SYNCED_SETTINGS_KEYS = [
  "attachmentsFolder",
  "showAttachmentsFolder",
  "dailyNotesFolder",
  "templatesFolder",
  "stylesFolder",
  "customCss",
  "layout",
  "defaultMode",
  "linkPreviewsEnabled",
] as const satisfies readonly (keyof AppSettings)[];

export type SyncedSettings = Pick<AppSettings, (typeof SYNCED_SETTINGS_KEYS)[number]>;

function copySyncedKey<K extends keyof SyncedSettings>(
  target: Partial<SyncedSettings>,
  source: Partial<AppSettings>,
  key: K,
): void {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

export function pickSyncedSettings(settings: AppSettings): SyncedSettings;
export function pickSyncedSettings(settings: Partial<AppSettings>): Partial<SyncedSettings>;
export function pickSyncedSettings(settings: Partial<AppSettings>): Partial<SyncedSettings> {
  const out: Partial<SyncedSettings> = {};
  for (const key of SYNCED_SETTINGS_KEYS) {
    copySyncedKey(out, settings, key);
  }
  return out;
}

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

function isLayoutPreference(value: unknown): value is LayoutPreference {
  return value === "default" || value === "borderless";
}

/** Applies the active layout attribute to `<html>` and keeps `theme-color` aligned. */
export function applyLayout(layout: LayoutPreference): void {
  if (typeof document === "undefined") {
    return;
  }
  if (layout === "borderless") {
    document.documentElement.dataset.layout = "borderless";
  } else {
    document.documentElement.removeAttribute("data-layout");
  }
  syncThemeColor();
}

/** The valid fields of `raw`, normalized; anything else is dropped. */
export function sanitizeSettings(raw: unknown): Partial<AppSettings> {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const input = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  const folder = (
    key: "attachmentsFolder" | "dailyNotesFolder" | "templatesFolder" | "stylesFolder",
  ) => {
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
  folder("stylesFolder");
  if (typeof input.customCss === "boolean") {
    out.customCss = input.customCss;
  }
  if (isLayoutPreference(input.layout)) {
    out.layout = input.layout;
  }
  if (isDefaultMode(input.defaultMode)) {
    out.defaultMode = input.defaultMode;
  }
  if (typeof input.showAttachmentsFolder === "boolean") {
    out.showAttachmentsFolder = input.showAttachmentsFolder;
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
  if (prev.layout !== next.layout) {
    applyLayout(next.layout);
  }
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
    applyLayout(DEFAULT_SETTINGS.layout);
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
