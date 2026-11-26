import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DriveNode } from "./api";
import { useOptionalDriveChanges } from "./driveChanges";
import {
  type CachedCustomCss,
  customCssCacheToken,
  readCachedCustomCss,
  writeCachedCustomCss,
} from "./localCache";
import { type AppSettings, getSettings, useSettings } from "./settings";
import { isTemplatesFolder } from "./templates";
import { childrenKey } from "./treeCache";
import { readRootFolderNotes } from "./vaultDocuments";

// Applies user-authored CSS from vault notes under the strict CSP (default-src 'self'):
// one shared constructable CSSStyleSheet updated via replaceSync() and appended last to
// document.adoptedStyleSheets and each mounted shadow root.

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Extracts fenced code blocks whose trimmed info string is exactly `css`, in document order.
 * Supports backtick and tilde fences and tracks non-css fences so nested examples are ignored.
 */
export function extractCssBlocks(markdown: string): string[] {
  const lines = markdown.split(/\r\n|\n|\r/);
  const blocks: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLength = 0;
  let capturing = false;
  let current: string[] = [];

  for (const line of lines) {
    if (fenceChar === null) {
      const open = OPEN_FENCE.exec(line);
      if (open === null) {
        continue;
      }
      const marker = open[1];
      const info = open[2];
      // CommonMark: backtick info strings cannot contain backticks.
      if (marker[0] === "`" && info.includes("`")) {
        continue;
      }
      fenceChar = marker[0] as "`" | "~";
      fenceLength = marker.length;
      capturing = info.trim() === "css";
      current = [];
      continue;
    }

    const closePattern = fenceChar === "`" ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/;
    const close = closePattern.exec(line);
    if (close !== null && close[1].length >= fenceLength) {
      if (capturing) {
        blocks.push(current.join("\n"));
      }
      fenceChar = null;
      fenceLength = 0;
      capturing = false;
      current = [];
      continue;
    }

    if (capturing) {
      current.push(line);
    }
  }

  if (fenceChar !== null && capturing) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

export interface StyleNote {
  name: string;
  text: string;
}

/** Extracts CSS from `notes`, sorted by note name (`localeCompare`) and block order. */
export function compileCustomCssWithNotes(notes: readonly StyleNote[]): {
  css: string;
  noteNames: string[];
} {
  const sorted = [...notes].sort((a, b) => a.name.localeCompare(b.name));
  const blocks: string[] = [];
  const noteNames: string[] = [];
  for (const note of sorted) {
    const extracted = extractCssBlocks(note.text);
    if (extracted.length > 0) {
      noteNames.push(note.name);
      blocks.push(...extracted);
    }
  }
  return { css: blocks.join("\n\n"), noteNames };
}

/** Concatenates every `css` fenced block across `notes` in `localeCompare` name order. */
export function compileCustomCss(notes: readonly StyleNote[]): string {
  return compileCustomCssWithNotes(notes).css;
}

let cachedNoCss: boolean | null = null;

/** Whether this page load disabled custom CSS via `?nocss=1` (cached for the page load). */
export function customCssDisabledByQuery(): boolean {
  if (cachedNoCss === null) {
    cachedNoCss =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("nocss") === "1";
  }
  return cachedNoCss;
}

let sharedSheet: CSSStyleSheet | null = null;

function supportsConstructableSheet(): boolean {
  return (
    typeof CSSStyleSheet === "function" &&
    typeof CSSStyleSheet.prototype.replaceSync === "function" &&
    typeof document !== "undefined" &&
    "adoptedStyleSheets" in document
  );
}

/** Returns the lazily created shared user stylesheet, or `null` when unsupported. */
export function getCustomCssSheet(): CSSStyleSheet | null {
  if (!supportsConstructableSheet()) {
    return null;
  }
  sharedSheet ??= new CSSStyleSheet();
  return sharedSheet;
}

/** Appends the shared user stylesheet last on `root`, removing any earlier copy. */
export function adoptUserSheet(root: Document | ShadowRoot): void {
  if (
    customCssDisabledByQuery() ||
    !supportsConstructableSheet() ||
    !("adoptedStyleSheets" in root)
  ) {
    return;
  }
  const sheet = getCustomCssSheet();
  if (sheet === null) {
    return;
  }
  const current = root.adoptedStyleSheets;
  if (current[current.length - 1] === sheet) {
    return;
  }
  root.adoptedStyleSheets = [...current.filter((entry) => entry !== sheet), sheet];
}

/** Replaces the shared user stylesheet's rules and ensures it is adopted on `document`. */
export function setCustomCss(css: string): void {
  if (customCssDisabledByQuery()) {
    if (sharedSheet !== null) {
      sharedSheet.replaceSync("");
    }
    return;
  }
  if (css.length === 0) {
    if (sharedSheet !== null) {
      sharedSheet.replaceSync("");
    }
    return;
  }
  const sheet = getCustomCssSheet();
  if (sheet === null) {
    return;
  }
  sheet.replaceSync(css);
  if (typeof document !== "undefined") {
    adoptUserSheet(document);
  }
}

let loadedNotes: readonly string[] = [];
const statusListeners = new Set<() => void>();

function emitStatus(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

function getLoadedNotes(): readonly string[] {
  return loadedNotes;
}

export function subscribeCustomCssStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function setCustomCssLoadedNotes(notes: readonly string[]): void {
  if (
    notes.length === loadedNotes.length &&
    notes.every((name, index) => name === loadedNotes[index])
  ) {
    return;
  }
  loadedNotes = [...notes];
  emitStatus();
}

export function getCustomCssStatusText(
  settings: Pick<AppSettings, "customCss" | "stylesFolder"> = getSettings(),
): string {
  if (customCssDisabledByQuery()) {
    return "Disabled for this load by ?nocss=1";
  }
  if (!settings.customCss) {
    return "Custom CSS is off";
  }
  if (loadedNotes.length > 0) {
    return `Loaded: ${loadedNotes.join(", ")}`;
  }
  return `No style notes in ${settings.stylesFolder}`;
}

export function useCustomCssStatus(): string {
  const settings = useSettings();
  useSyncExternalStore(subscribeCustomCssStatus, getLoadedNotes, getLoadedNotes);
  return getCustomCssStatusText(settings);
}

const BOOT_TIMEOUT_MS = 300;

/**
 * Loads cached custom CSS from IndexedDB and applies it to `document` before React renders, so
 * reloads never flash unstyled. Bounded by `timeoutMs` so slow storage never blocks boot.
 */
export async function bootCustomCss(timeoutMs = BOOT_TIMEOUT_MS): Promise<void> {
  if (customCssDisabledByQuery() || !getSettings().customCss) {
    return;
  }
  const token = customCssCacheToken();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cached: CachedCustomCss | undefined;
  try {
    cached = await Promise.race([
      readCachedCustomCss(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  if (
    cached === undefined ||
    token !== customCssCacheToken() ||
    customCssDisabledByQuery() ||
    !getSettings().customCss
  ) {
    return;
  }
  if (cached.css.length > 0) {
    setCustomCss(cached.css);
  }
  setCustomCssLoadedNotes(cached.notes);
}

/** Clears the shared sheet, removes it from `document`, and resets cached query/status state. */
export function resetCustomCssForTests(): void {
  if (sharedSheet !== null) {
    sharedSheet.replaceSync("");
    if (typeof document !== "undefined" && "adoptedStyleSheets" in document) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (entry) => entry !== sharedSheet,
      );
    }
  }
  loadedNotes = [];
  cachedNoCss = null;
  emitStatus();
}

/**
 * Keeps the shared custom CSS stylesheet synchronized with the vault's styles folder, live edits,
 * Drive change polls, folder setting changes, vault switches, and account sign-out/unmount.
 */
export function useCustomCss({
  accountEmail,
  signedOut,
}: {
  accountEmail: string | undefined;
  signedOut: boolean;
}): void {
  const queryClient = useQueryClient();
  const driveChanges = useOptionalDriveChanges();
  const settings = useSettings();
  const disabledByQuery = customCssDisabledByQuery();
  const enabled = !disabledByQuery && settings.customCss && !signedOut;

  const lastAccountRef = useRef<string | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const lastRootIdRef = useRef<string | null>(null);
  const rootEpochRef = useRef(0);
  const stylesFolderIdRef = useRef<string | null>(null);
  const stylesNoteIdsRef = useRef<Set<string>>(new Set());
  const lastModifiedByIdRef = useRef<Map<string, string>>(new Map());
  const lastForcedTimeByIdRef = useRef<Map<string, string>>(new Map());
  const seenChangesRef = useRef<Set<string>>(new Set());
  const seenHydratedRef = useRef(false);

  // Clear the shared sheet when the session tree unmounts.
  useEffect(() => {
    return () => {
      setCustomCss("");
      setCustomCssLoadedNotes([]);
    };
  }, []);

  // Re-key on account switch without clearing during initial undefined -> email resolution.
  useEffect(() => {
    if (accountEmail === undefined) {
      return;
    }
    if (lastAccountRef.current !== null && lastAccountRef.current !== accountEmail) {
      rootEpochRef.current += 1;
      lastRootIdRef.current = null;
      stylesFolderIdRef.current = null;
      stylesNoteIdsRef.current = new Set();
      lastModifiedByIdRef.current = new Map();
      lastForcedTimeByIdRef.current = new Map();
      seenChangesRef.current = new Set();
      seenHydratedRef.current = false;
      setCustomCss("");
      setCustomCssLoadedNotes([]);
      setAccountEpoch((value) => value + 1);
    }
    lastAccountRef.current = accountEmail;
  }, [accountEmail]);

  useEffect(() => {
    if (!enabled) {
      setCustomCss("");
      setCustomCssLoadedNotes([]);
      if (signedOut) {
        rootEpochRef.current += 1;
        lastRootIdRef.current = null;
        stylesFolderIdRef.current = null;
        stylesNoteIdsRef.current = new Set();
        lastModifiedByIdRef.current = new Map();
        lastForcedTimeByIdRef.current = new Map();
        seenChangesRef.current = new Set();
        seenHydratedRef.current = false;
      }
      return;
    }

    let cancelled = false;
    let activeController: AbortController | null = null;
    let inFlight = false;
    let needsFollowUp = false;
    let scheduled = false;
    let ignoreSelfQueryUpdates = false;
    const pendingForceIds = new Set<string>();
    const folderName = settings.stylesFolder;

    stylesFolderIdRef.current = null;
    stylesNoteIdsRef.current = new Set();
    lastModifiedByIdRef.current = new Map();
    lastForcedTimeByIdRef.current = new Map();

    const seedSeenChanges = () => {
      if (driveChanges === null) {
        return;
      }
      seenHydratedRef.current = false;
      seenChangesRef.current = new Set();
      const seedEpoch = rootEpochRef.current;
      void driveChanges.hydrate().then(() => {
        if (cancelled || seedEpoch !== rootEpochRef.current) {
          return;
        }
        for (const entry of driveChanges.getSnapshot().recent) {
          seenChangesRef.current.add(`${entry.id}:${entry.time}`);
        }
        seenHydratedRef.current = true;
      });
    };

    const syncFolderRefs = (detectModifiedChanges: boolean): void => {
      const root = queryClient.getQueryData<DriveNode>(["root"]);
      if (root === undefined) {
        return;
      }
      const rootList = queryClient.getQueryData<DriveNode[]>(childrenKey(root.id));
      if (rootList === undefined) {
        return;
      }
      const folder = rootList.find(
        (node) => node.kind === "folder" && isTemplatesFolder([node.name], folderName),
      );
      if (folder === undefined) {
        stylesFolderIdRef.current = null;
        stylesNoteIdsRef.current = new Set();
        lastModifiedByIdRef.current = new Map();
        return;
      }
      if (stylesFolderIdRef.current !== folder.id) {
        stylesFolderIdRef.current = folder.id;
        stylesNoteIdsRef.current = new Set();
        lastModifiedByIdRef.current = new Map();
      }
      const children = queryClient.getQueryData<DriveNode[]>(childrenKey(folder.id));
      if (children === undefined) {
        return;
      }
      const nextIds = new Set<string>();
      const nextModified = new Map<string, string>();
      for (const child of children) {
        if (child.kind !== "markdown") {
          continue;
        }
        nextIds.add(child.id);
        nextModified.set(child.id, child.modifiedTime);
        if (detectModifiedChanges) {
          const prevModified = lastModifiedByIdRef.current.get(child.id);
          const lastForcedTime = lastForcedTimeByIdRef.current.get(child.id);
          if (
            prevModified !== undefined &&
            prevModified !== child.modifiedTime &&
            (lastForcedTime === undefined || child.modifiedTime > lastForcedTime)
          ) {
            pendingForceIds.add(child.id);
          }
        }
      }
      stylesNoteIdsRef.current = nextIds;
      lastModifiedByIdRef.current = nextModified;
    };

    const handleRootCheck = (): boolean => {
      const root = queryClient.getQueryData<DriveNode>(["root"]);
      if (root === undefined) {
        return false;
      }
      if (lastRootIdRef.current !== null && lastRootIdRef.current !== root.id) {
        lastRootIdRef.current = root.id;
        rootEpochRef.current += 1;
        activeController?.abort();
        activeController = null;
        stylesFolderIdRef.current = null;
        stylesNoteIdsRef.current = new Set();
        lastModifiedByIdRef.current = new Map();
        lastForcedTimeByIdRef.current = new Map();
        pendingForceIds.clear();
        setCustomCss("");
        setCustomCssLoadedNotes([]);
        seedSeenChanges();
        return true;
      }
      lastRootIdRef.current = root.id;
      return true;
    };

    const runRecompute = async () => {
      if (cancelled) {
        return;
      }
      if (inFlight) {
        needsFollowUp = true;
        return;
      }
      inFlight = true;
      needsFollowUp = false;

      const forceIds = pendingForceIds.size > 0 ? new Set(pendingForceIds) : undefined;
      pendingForceIds.clear();

      const controller = new AbortController();
      activeController = controller;
      const epoch = rootEpochRef.current;
      const token = customCssCacheToken();

      try {
        ignoreSelfQueryUpdates = true;
        const result = await readRootFolderNotes(queryClient, folderName, {
          signal: controller.signal,
          forceIds,
        });
        ignoreSelfQueryUpdates = false;
        if (cancelled || epoch !== rootEpochRef.current) {
          return;
        }
        syncFolderRefs(false);
        if (result.state === "unknown") {
          return;
        }
        if (token !== customCssCacheToken()) {
          needsFollowUp = false;
          return;
        }
        const { css, noteNames } = compileCustomCssWithNotes(result.notes);
        setCustomCss(css);
        setCustomCssLoadedNotes(noteNames);
        await writeCachedCustomCss({ css, notes: noteNames }, token);
      } finally {
        ignoreSelfQueryUpdates = false;
        if (activeController === controller) {
          activeController = null;
        }
        inFlight = false;
        if (
          !cancelled &&
          token === customCssCacheToken() &&
          (needsFollowUp || pendingForceIds.size > 0)
        ) {
          needsFollowUp = false;
          scheduleRecompute();
        } else {
          needsFollowUp = false;
        }
      }
    };

    const scheduleRecompute = () => {
      if (cancelled || scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void runRecompute();
      });
    };

    seedSeenChanges();
    if (handleRootCheck()) {
      syncFolderRefs(false);
      scheduleRecompute();
    }

    const unsubscribeQuery = queryClient.getQueryCache().subscribe((event) => {
      if (cancelled || event.type !== "updated") {
        return;
      }
      const key = event.query.queryKey;
      if (key[0] === "root") {
        if (handleRootCheck()) {
          syncFolderRefs(false);
          scheduleRecompute();
        }
        return;
      }
      if (key[0] === "folders" && key[2] === "children") {
        const folderId = key[1];
        const root = queryClient.getQueryData<DriveNode>(["root"]);
        if (root !== undefined && folderId === root.id) {
          handleRootCheck();
          syncFolderRefs(false);
          scheduleRecompute();
          return;
        }
        if (stylesFolderIdRef.current !== null && folderId === stylesFolderIdRef.current) {
          if (ignoreSelfQueryUpdates) {
            return;
          }
          syncFolderRefs(true);
          scheduleRecompute();
        }
        return;
      }
      if (
        key[0] === "files" &&
        key[2] === "content" &&
        typeof key[1] === "string" &&
        stylesNoteIdsRef.current.has(key[1])
      ) {
        if (ignoreSelfQueryUpdates) {
          return;
        }
        scheduleRecompute();
      }
    });

    const unsubscribeChanges =
      driveChanges?.subscribe(() => {
        if (cancelled || !seenHydratedRef.current) {
          return;
        }
        let relevant = false;
        for (const entry of driveChanges.getSnapshot().recent) {
          const seenKey = `${entry.id}:${entry.time}`;
          if (seenChangesRef.current.has(seenKey)) {
            continue;
          }
          seenChangesRef.current.add(seenKey);
          const inStylesFolder =
            stylesNoteIdsRef.current.has(entry.id) ||
            (stylesFolderIdRef.current !== null && entry.parentId === stylesFolderIdRef.current);
          if (inStylesFolder) {
            pendingForceIds.add(entry.id);
            lastForcedTimeByIdRef.current.set(entry.id, entry.time);
            relevant = true;
          }
        }
        if (relevant) {
          scheduleRecompute();
        }
      }) ?? null;

    return () => {
      cancelled = true;
      activeController?.abort();
      unsubscribeQuery();
      unsubscribeChanges?.();
    };
  }, [queryClient, driveChanges, enabled, signedOut, settings.stylesFolder, accountEpoch]);
}
