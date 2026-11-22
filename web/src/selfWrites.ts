/**
 * Drive items this app itself just wrote (content upload, create, rename, move, delete), so the
 * changes feed does not report our own edits as "updated on Drive".
 */

/** A change Drive stamps within this window after our own write is taken to be that write. */
export const SELF_WRITE_WINDOW_MS = 2 * 60_000;
const MAX_ENTRIES = 500;

const writes = new Map<string, number>();
const listeners = new Set<() => void>();

export function markSelfWrite(id: string, at = Date.now()): void {
  if (id.length === 0) {
    return;
  }
  writes.delete(id);
  writes.set(id, at);
  while (writes.size > MAX_ENTRIES) {
    const oldest = writes.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    writes.delete(oldest);
  }
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Whether a change Drive reported at `changeTime` (ISO) for `id` is most likely our own write:
 * we wrote `id` and Drive's change is not clearly later than that write.
 */
export function isSelfChange(id: string, changeTime: string | undefined): boolean {
  const at = writes.get(id);
  if (at === undefined) {
    return false;
  }
  const time = changeTime === undefined ? Number.NaN : Date.parse(changeTime);
  if (Number.isNaN(time)) {
    return Date.now() - at <= SELF_WRITE_WINDOW_MS;
  }
  return time <= at + SELF_WRITE_WINDOW_MS;
}

export function snapshotSelfWrites(): [string, number][] {
  return [...writes.entries()];
}

/** Restores marks persisted by a previous session, keeping any newer in-memory mark. */
export function restoreSelfWrites(entries: readonly (readonly [string, number])[]): void {
  for (const [id, at] of entries) {
    const current = writes.get(id);
    if (current === undefined || current < at) {
      writes.set(id, at);
    }
  }
}

export function clearSelfWrites(): void {
  writes.clear();
}

export function onSelfWrite(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
