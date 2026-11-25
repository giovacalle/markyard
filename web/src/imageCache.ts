// The service worker keeps attachment images on the device (see `buildServiceWorkerSource`):
// originals from `/api/files/<id>/blob` and Drive thumbnails from `/api/files/<id>/thumb`, so a
// note's images load without the network after their first view. The page forgets them on
// sign-out and when a file goes to the Trash. Kept free of browser globals at import time: the
// Vite config imports the names through `sw-source.ts`.

/** Cache names; outside the `markyard-shell-` prefix, so a deploy keeps them. */
export const IMAGE_CACHES = {
  blob: "markyard-images-v1",
  thumb: "markyard-thumbs-v1",
} as const;

/** Most entries kept per cache; the oldest go first. */
export const IMAGE_CACHE_LIMITS = { blob: 150, thumb: 600 } as const;

function cacheStorage(): CacheStorage | undefined {
  return typeof caches === "undefined" ? undefined : caches;
}

/** Drops the cached original and thumbnails of one file (e.g. after trashing it). */
export async function forgetCachedImage(id: string): Promise<void> {
  const storage = cacheStorage();
  if (storage === undefined) {
    return;
  }
  const base = `/api/files/${encodeURIComponent(id)}`;
  try {
    for (const name of Object.values(IMAGE_CACHES)) {
      if (!(await storage.has(name))) continue;
      const cache = await storage.open(name);
      await cache.delete(`${base}/blob`);
      await cache.delete(`${base}/thumb`, { ignoreSearch: true });
    }
  } catch {
    // The cache is best effort; a failure only costs a stale image.
  }
}

/** Deletes every cached image (sign-out, clearing local data). */
export async function clearCachedImages(): Promise<void> {
  const storage = cacheStorage();
  if (storage === undefined) {
    return;
  }
  try {
    await Promise.all(Object.values(IMAGE_CACHES).map((name) => storage.delete(name)));
  } catch {
    // Best effort, as above.
  }
}
