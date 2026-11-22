import { useCallback, useSyncExternalStore } from "react";

const OPEN_EVENT = "markyard:open";
const LAST_OPEN_STORAGE_KEY = "markyard:last-open-file";

/** The note reopened from storage on this page load, until it is confirmed or found missing. */
let restoredFileId: string | null = null;

/** The note in the URL (`?file=`), i.e. the open one. */
export function getOpenFileId(): string | null {
  const id = new URLSearchParams(window.location.search).get("file");
  return id !== null && id.length > 0 ? id : null;
}

function urlForFile(id: string | null): string {
  const url = new URL(window.location.href);
  if (id === null) {
    url.searchParams.delete("file");
  } else {
    url.searchParams.set("file", id);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readLastOpenFile(): string | null {
  try {
    const id = window.localStorage.getItem(LAST_OPEN_STORAGE_KEY);
    return id !== null && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function rememberLastOpenFile(id: string): void {
  try {
    window.localStorage.setItem(LAST_OPEN_STORAGE_KEY, id);
  } catch {
    // Storage full or blocked: the app just starts empty next time.
  }
}

export function forgetLastOpenFile(): void {
  restoredFileId = null;
  try {
    window.localStorage.removeItem(LAST_OPEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

/**
 * At `/` with no `?file=`, reopens the note that was open last time by rewriting the URL in place
 * (no new history entry). Call before the first read of the open document.
 */
export function restoreLastOpenFile(): string | null {
  if (window.location.pathname !== "/" || getOpenFileId() !== null) {
    return null;
  }
  const id = readLastOpenFile();
  if (id === null) {
    return null;
  }
  restoredFileId = id;
  window.history.replaceState(window.history.state, "", urlForFile(id));
  return id;
}

/**
 * Opens `id` as if it had been reopened from storage (cloud state sync adopting another device's
 * last note): no new history entry, and a missing note falls back to the empty workspace.
 * Only at `/`, like `restoreLastOpenFile`.
 */
export function openRestoredFile(id: string): void {
  rememberLastOpenFile(id);
  if (window.location.pathname !== "/" || getOpenFileId() === id) {
    return;
  }
  restoredFileId = id;
  window.history.replaceState(window.history.state, "", urlForFile(id));
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Whether `id` is the note that was reopened from storage (not opened by the user this time). */
export function wasRestoredFile(id: string): boolean {
  return restoredFileId === id;
}

/** Calls `listener` whenever the open note may have changed. */
export function subscribeOpenDocument(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(OPEN_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(OPEN_EVENT, listener);
  };
}

export function useOpenDocument(): [
  string | null,
  (id: string | null, options?: { replace?: boolean }) => void,
] {
  const fileId = useSyncExternalStore(subscribeOpenDocument, getOpenFileId);

  const open = useCallback((id: string | null, options?: { replace?: boolean }) => {
    if (id === null) {
      forgetLastOpenFile();
    } else if (id !== restoredFileId) {
      restoredFileId = null;
    }
    if (getOpenFileId() === id) {
      return;
    }
    if (options?.replace === true) {
      window.history.replaceState(window.history.state, "", urlForFile(id));
    } else {
      window.history.pushState(null, "", urlForFile(id));
    }
    window.dispatchEvent(new Event(OPEN_EVENT));
  }, []);

  return [fileId, open];
}
