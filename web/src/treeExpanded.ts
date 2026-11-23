// Which folders the file tree shows expanded, per root folder. Stored in localStorage so it
// survives reloads; subscribers hear every write, so the tree follows changes made elsewhere
// (cloud state sync adopting another device's folders).

const EXPANDED_STORAGE_PREFIX = "markyard:tree-expanded:";

const listeners = new Set<(rootFolderId: string, expanded: readonly string[]) => void>();

function expandedStorageKey(rootFolderId: string): string {
  return `${EXPANDED_STORAGE_PREFIX}${rootFolderId}`;
}

export function readExpandedFolders(rootFolderId: string): string[] {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const raw = localStorage.getItem(expandedStorageKey(rootFolderId));
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function writeExpandedFolders(rootFolderId: string, expanded: readonly string[]): void {
  if (typeof localStorage !== "undefined") {
    try {
      if (expanded.length === 0) {
        localStorage.removeItem(expandedStorageKey(rootFolderId));
      } else {
        localStorage.setItem(expandedStorageKey(rootFolderId), JSON.stringify(expanded));
      }
    } catch {
      // Ignore storage quota or private-browsing errors.
    }
  }
  for (const listener of listeners) {
    listener(rootFolderId, expanded);
  }
}

export function subscribeExpandedFolders(
  listener: (rootFolderId: string, expanded: readonly string[]) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drops every stored expanded-folder list from localStorage (sign-out, account switch). */
export function clearExpandedFolders(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(EXPANDED_STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}
