import { useSyncExternalStore } from "react";
import { type AppSettings, getSettings, useSettings } from "./settings";

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
