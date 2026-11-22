/**
 * When this device last changed a synced preference (or adopted the cloud's), in epoch ms. Cloud
 * state sync compares it with the server's `updatedAt` to decide which side wins.
 */
export const CLOUD_STATE_STAMP_KEY = "markyard:state-updated-at";

export function readCloudStateStamp(): number {
  try {
    const value = Number(window.localStorage.getItem(CLOUD_STATE_STAMP_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeCloudStateStamp(updatedAt: number): void {
  try {
    window.localStorage.setItem(CLOUD_STATE_STAMP_KEY, String(updatedAt));
  } catch {
    // Storage blocked: the next sync just treats this device as never changed.
  }
}

/** Sign-out and account switches: the next account starts from the cloud's state. */
export function clearCloudStateStamp(): void {
  try {
    window.localStorage.removeItem(CLOUD_STATE_STAMP_KEY);
  } catch {
    // Ignore storage errors.
  }
}
