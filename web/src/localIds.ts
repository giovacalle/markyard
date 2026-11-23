export const LOCAL_ID_PREFIX = "local:";

/** Whether `id` is a temporary client-only id awaiting creation on Google Drive. */
export function isLocalId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_ID_PREFIX);
}

/** Generates a collision-free temporary id for an offline-created note or folder. */
export function makeLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${LOCAL_ID_PREFIX}${crypto.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `${LOCAL_ID_PREFIX}${Date.now().toString(36)}-${rand}`;
}

/** Generates a stable UUID for a persisted `PendingOp`. */
export function makeOpId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `op-${Date.now().toString(36)}-${rand}`;
}
