export const SHELL_CACHE_PREFIX = "markyard-shell-";

export const STATIC_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
] as const;

/** The subset of a Rollup/Vite output bundle entry that decides what gets precached. */
export type PrecacheBundleItem =
  | { type: "asset" }
  | {
      type: "chunk";
      isEntry: boolean;
      facadeModuleId?: string | null;
      imports: readonly string[];
      viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> };
    };

/**
 * Lazy modules that must work offline right after a deploy: reading (Preview) and editing
 * (Editor) a note cached in IndexedDB. Matched on the chunk's facade module path.
 */
export const OFFLINE_LAZY_MODULES = ["/components/Editor.tsx", "/components/Preview.tsx"] as const;

/**
 * Lists the URLs the service worker precaches on install: the static shell, every entry
 * chunk, the Editor and Preview chunks, the chunks they import statically (transitively),
 * and their CSS and assets. Chunks reached only through `import()` from those (Mermaid,
 * KaTeX, highlighting, merge view, rich copy) stay out, so install and update stay lean;
 * the fetch handler caches them on first use. Throws when an offline module has no chunk.
 */
export function collectPrecacheUrls(bundle: Record<string, PrecacheBundleItem>): string[] {
  const urls = new Set<string>(STATIC_SHELL_URLS);
  const chunkNames = Object.keys(bundle).filter((fileName) => bundle[fileName]?.type === "chunk");
  const facadeOf = (fileName: string) => {
    const item = bundle[fileName];
    return item?.type === "chunk" ? (item.facadeModuleId ?? "").replaceAll("\\", "/") : "";
  };
  const lazyRoots = OFFLINE_LAZY_MODULES.map((suffix) => {
    const fileName = chunkNames.find((name) => facadeOf(name).endsWith(suffix));
    if (fileName === undefined) {
      throw new Error(`No chunk found for ${suffix}; offline reading and editing would break.`);
    }
    return fileName;
  });
  const pending = [
    ...chunkNames.filter((fileName) => {
      const item = bundle[fileName];
      return item?.type === "chunk" && item.isEntry;
    }),
    ...lazyRoots,
  ];
  const visited = new Set<string>();

  for (let fileName = pending.pop(); fileName !== undefined; fileName = pending.pop()) {
    const item = bundle[fileName];
    if (visited.has(fileName) || item?.type !== "chunk") {
      continue;
    }
    visited.add(fileName);
    urls.add(`/${fileName}`);
    for (const file of [
      ...(item.viteMetadata?.importedCss ?? []),
      ...(item.viteMetadata?.importedAssets ?? []),
    ]) {
      urls.add(`/${file}`);
    }
    pending.push(...item.imports);
  }

  return Array.from(urls).sort();
}

/**
 * Generates the standalone `/sw.js` app-shell service worker source.
 *
 * Guarantees:
 * - Never intercepts or caches `/api` or `/api/*` (including `/api/auth/*` navigations).
 * - Never intercepts non-GET, cross-origin, or `/sw.js` requests.
 * - Network-first for HTML navigations with offline fallback to cached `/index.html`.
 * - Cache-first for static app-shell assets (hashed JS/CSS chunks, icons, manifest).
 * - Replaces stale `markyard-shell-*` caches on activate.
 */
export function buildServiceWorkerSource(
  cacheName: string,
  precacheUrls: readonly string[],
): string {
  const uniqueUrls = Array.from(new Set(precacheUrls)).sort();
  return `const CACHE_PREFIX = ${JSON.stringify(SHELL_CACHE_PREFIX)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(uniqueUrls, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    self.caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => self.caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never intercept or cache any BFF /api/* request (auth redirects, Drive reads, writes).
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return;
  }

  if (url.pathname === "/sw.js") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      self
        .fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void self.caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await self.caches.open(CACHE_NAME);
          return (await cache.match("/index.html")) ?? (await cache.match("/")) ?? Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    self.caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) {
        return cached;
      }
      const response = await self.fetch(request);
      if (response.ok && response.type === "basic") {
        void cache.put(request, response.clone());
      }
      return response;
    }),
  );
});
`;
}
