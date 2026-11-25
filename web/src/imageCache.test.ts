import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clearCachedImages, forgetCachedImage, IMAGE_CACHES } from "./imageCache";

/** A CacheStorage over plain maps of request paths (with their query). */
function fakeCaches(initial: Record<string, string[]>) {
  const stores = new Map(Object.entries(initial).map(([name, keys]) => [name, new Set(keys)]));
  const storage = {
    has: async (name: string) => stores.has(name),
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      const keys = stores.get(name) ?? new Set<string>();
      stores.set(name, keys);
      return {
        delete: async (url: string, options?: CacheQueryOptions) => {
          let removed = false;
          for (const key of keys) {
            if (key === url || (options?.ignoreSearch === true && key.split("?")[0] === url)) {
              removed = keys.delete(key) || removed;
            }
          }
          return removed;
        },
      };
    },
  };
  vi.stubGlobal("caches", storage);
  return stores;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("image cache", () => {
  it("forgets one file's original and every thumbnail size", async () => {
    const stores = fakeCaches({
      [IMAGE_CACHES.blob]: ["/api/files/img-1/blob", "/api/files/img-2/blob"],
      [IMAGE_CACHES.thumb]: [
        "/api/files/img-1/thumb?size=640",
        "/api/files/img-1/thumb?size=800",
        "/api/files/img-2/thumb?size=800",
      ],
    });
    await forgetCachedImage("img-1");
    expect([...stores.get(IMAGE_CACHES.blob)!]).toEqual(["/api/files/img-2/blob"]);
    expect([...stores.get(IMAGE_CACHES.thumb)!]).toEqual(["/api/files/img-2/thumb?size=800"]);
  });

  it("clears every cached image", async () => {
    const stores = fakeCaches({
      [IMAGE_CACHES.blob]: ["/api/files/img-1/blob"],
      [IMAGE_CACHES.thumb]: ["/api/files/img-1/thumb?size=800"],
      "markyard-shell-v1": ["/"],
    });
    await clearCachedImages();
    expect([...stores.keys()]).toEqual(["markyard-shell-v1"]);
  });

  it("does nothing without the Cache API", async () => {
    await expect(forgetCachedImage("img-1")).resolves.toBeUndefined();
    await expect(clearCachedImages()).resolves.toBeUndefined();
  });
});
