import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildServiceWorkerSource,
  collectPrecacheUrls,
  SHELL_CACHE_PREFIX,
  STATIC_SHELL_URLS,
  type PrecacheBundleItem,
} from "./sw-source";
import { IMAGE_CACHE_LIMITS, IMAGE_CACHES } from "./imageCache";

interface MockCache {
  entries: Map<string, Response>;
  addAll: (urls: string[]) => Promise<void>;
  match: (req: Request | string) => Promise<Response | undefined>;
  put: (req: Request | string, res: Response) => Promise<void>;
  keys: () => Promise<string[]>;
  delete: (req: Request | string) => Promise<boolean>;
}

function keyOf(req: Request | string): string {
  const raw = typeof req === "string" ? req : req.url;
  const parsed = new URL(raw, "https://notes.example.com");
  return `${parsed.pathname}${parsed.search}`;
}

function createMockSwEnv(cacheName: string, precacheUrls: string[]) {
  const stores = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, (event: unknown) => void>();

  const openCache = (name: string): MockCache => {
    let entries = stores.get(name);
    if (!entries) {
      entries = new Map();
      stores.set(name, entries);
    }
    return {
      entries,
      addAll: async (urls) => {
        for (const u of urls) {
          entries.set(keyOf(u), new Response(`cached:${u}`, { status: 200 }));
        }
      },
      match: async (req) => entries.get(keyOf(req))?.clone(),
      put: async (req, res) => {
        entries.set(keyOf(req), res);
      },
      keys: async () => Array.from(entries.keys()),
      delete: async (req) => entries.delete(keyOf(req)),
    };
  };

  const fetchMock = vi.fn<(req: Request) => Promise<Response>>();
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);

  const mockSelf = {
    location: { origin: "https://notes.example.com" },
    caches: {
      open: async (name: string) => openCache(name),
      keys: async () => Array.from(stores.keys()),
      delete: async (name: string) => stores.delete(name),
    },
    clients: { claim },
    skipWaiting,
    fetch: fetchMock,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, fn);
    },
  };

  const source = buildServiceWorkerSource(cacheName, precacheUrls);
  // Execute the generated service worker source against the mock ServiceWorkerGlobalScope.
  // oxlint-disable-next-line typescript/no-implied-eval
  const run = new Function("self", source) as (s: typeof mockSelf) => void;
  run(mockSelf);

  const dispatchExtendable = async (type: "install" | "activate") => {
    let pending: Promise<unknown> | undefined;
    const listener = listeners.get(type);
    if (!listener) {
      throw new Error(`Missing ${type} listener`);
    }
    listener({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
  };

  const dispatchFetch = async (
    url: string,
    opts: { method?: string; mode?: RequestMode } = {},
  ): Promise<{ intercepted: boolean; response?: Response }> => {
    const listener = listeners.get("fetch");
    if (!listener) {
      throw new Error("Missing fetch listener");
    }
    const request = {
      url,
      method: opts.method ?? "GET",
      mode: opts.mode ?? "cors",
    } as Request;

    let responsePromise: Promise<Response> | undefined;
    const background: Promise<unknown>[] = [];
    listener({
      request,
      respondWith: (promise: Promise<Response>) => {
        responsePromise = promise;
      },
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    });

    if (responsePromise === undefined) {
      return { intercepted: false };
    }
    const response = await responsePromise;
    await Promise.all(background);
    return { intercepted: true, response };
  };

  return {
    stores,
    fetchMock,
    skipWaiting,
    claim,
    dispatchExtendable,
    dispatchFetch,
  };
}

function basicResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const res = new Response(body, { status, headers });
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
}

const png = (body: string, headers: Record<string, string> = {}) =>
  basicResponse(body, 200, { "content-type": "image/png", ...headers });

describe("collectPrecacheUrls", () => {
  const chunk = (
    isEntry: boolean,
    imports: string[] = [],
    css: string[] = [],
    assets: string[] = [],
    facadeModuleId: string | null = null,
  ): PrecacheBundleItem => ({
    type: "chunk",
    isEntry,
    facadeModuleId,
    imports,
    viteMetadata: { importedCss: new Set(css), importedAssets: new Set(assets) },
  });

  const SRC = "/repo/web/src";

  const bundle: Record<string, PrecacheBundleItem> = {
    "index.html": { type: "asset" },
    "assets/index-a.js": chunk(true, ["assets/vendor-b.js"], ["assets/index-a.css"]),
    "assets/vendor-b.js": chunk(false, [], [], ["assets/logo-c.svg"]),
    "assets/index-a.css": { type: "asset" },
    "assets/logo-c.svg": { type: "asset" },
    // Lazy, but needed to read and edit cached notes offline right after a deploy.
    "assets/Editor-d.js": chunk(
      false,
      ["assets/vendor-b.js", "assets/codemirror-h.js"],
      [],
      [],
      `${SRC}/components/Editor.tsx`,
    ),
    "assets/codemirror-h.js": chunk(false),
    "assets/Preview-i.js": chunk(
      false,
      ["assets/markdown-j.js"],
      ["assets/Preview-i.css"],
      [],
      `${SRC}/components/Preview.tsx`,
    ),
    "assets/markdown-j.js": chunk(false),
    "assets/Preview-i.css": { type: "asset" },
    // Reached only through import() from those chunks: cached by the fetch handler on first use.
    "assets/ConflictMerge-e.js": chunk(
      false,
      ["assets/codemirror-h.js"],
      [],
      [],
      `${SRC}/components/ConflictMerge.tsx`,
    ),
    "assets/mermaidRender-f.js": chunk(false, [], [], [], `${SRC}/mermaidRender.ts`),
    "assets/mathPlugins-g.js": chunk(
      false,
      [],
      ["assets/mathPlugins-g.css"],
      ["assets/KaTeX_Main.woff2"],
      `${SRC}/mathPlugins.ts`,
    ),
    "assets/mathPlugins-g.css": { type: "asset" },
    "assets/KaTeX_Main.woff2": { type: "asset" },
    "assets/highlightPlugin-k.js": chunk(false, [], [], [], `${SRC}/highlightPlugin.ts`),
    "assets/richHtml-l.js": chunk(false, [], [], [], `${SRC}/richHtml.ts`),
    "assets/index-a.js.map": { type: "asset" },
  };

  it("precaches the shell, entry chunks, and the Editor and Preview chunks with their static deps", () => {
    expect(collectPrecacheUrls(bundle)).toEqual(
      [
        ...STATIC_SHELL_URLS,
        "/assets/Editor-d.js",
        "/assets/Preview-i.css",
        "/assets/Preview-i.js",
        "/assets/codemirror-h.js",
        "/assets/index-a.css",
        "/assets/index-a.js",
        "/assets/logo-c.svg",
        "/assets/markdown-j.js",
        "/assets/vendor-b.js",
      ].sort(),
    );
  });

  it("leaves Mermaid, KaTeX, highlighting, the merge view and rich copy out of the precache", () => {
    const urls = collectPrecacheUrls(bundle).join("\n");
    expect(urls).not.toMatch(/mermaid|mathPlugins|KaTeX|highlightPlugin|ConflictMerge|richHtml/);
  });

  it("fails the build when the Editor or Preview chunk cannot be found", () => {
    const withoutPreview = { ...bundle };
    delete withoutPreview["assets/Preview-i.js"];
    expect(() => collectPrecacheUrls(withoutPreview)).toThrow(/Preview/);
  });
});

describe("app-shell service worker", () => {
  const CACHE_V2 = `${SHELL_CACHE_PREFIX}v2`;
  const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/assets/index-abc.js"];

  it("precaches the app shell on install and deletes stale shell caches on activate", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    env.stores.set(`${SHELL_CACHE_PREFIX}v1`, new Map([["/index.html", new Response("old")]]));
    env.stores.set("unrelated-cache", new Map([["/keep", new Response("keep")]]));

    await env.dispatchExtendable("install");
    expect(env.skipWaiting).toHaveBeenCalledTimes(1);
    expect(Array.from(env.stores.get(CACHE_V2)?.keys() ?? []).sort()).toEqual([...PRECACHE].sort());

    await env.dispatchExtendable("activate");
    expect(env.claim).toHaveBeenCalledTimes(1);
    expect(env.stores.has(`${SHELL_CACHE_PREFIX}v1`)).toBe(false);
    expect(env.stores.has(CACHE_V2)).toBe(true);
    expect(env.stores.has("unrelated-cache")).toBe(true);
  });

  it("never intercepts or caches any /api/* request, including auth navigations", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");

    const apiUrls = [
      "https://notes.example.com/api",
      "https://notes.example.com/api/session",
      "https://notes.example.com/api/root",
      "https://notes.example.com/api/folders/root-id/children",
      "https://notes.example.com/api/files/f1/content",
    ];
    for (const url of apiUrls) {
      const result = await env.dispatchFetch(url);
      expect(result.intercepted).toBe(false);
    }

    // OAuth login & callback navigations must also bypass the service worker completely.
    expect(
      (await env.dispatchFetch("https://notes.example.com/api/auth/login", { mode: "navigate" }))
        .intercepted,
    ).toBe(false);
    expect(
      (
        await env.dispatchFetch("https://notes.example.com/api/auth/callback?code=123", {
          mode: "navigate",
        })
      ).intercepted,
    ).toBe(false);

    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it("serves attachment originals and thumbnails cache-first, offline included", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");
    env.fetchMock.mockResolvedValueOnce(png("original"));
    env.fetchMock.mockResolvedValueOnce(png("thumb", { "x-thumbnail-source": "thumbnail" }));

    const blobUrl = "https://notes.example.com/api/files/img-1/blob";
    const thumbUrl = "https://notes.example.com/api/files/img-1/thumb?size=800";
    expect(await (await env.dispatchFetch(blobUrl)).response?.text()).toBe("original");
    expect(await (await env.dispatchFetch(thumbUrl)).response?.text()).toBe("thumb");
    expect(Array.from(env.stores.get(IMAGE_CACHES.blob)!.keys())).toEqual([
      "/api/files/img-1/blob",
    ]);
    expect(Array.from(env.stores.get(IMAGE_CACHES.thumb)!.keys())).toEqual([
      "/api/files/img-1/thumb?size=800",
    ]);

    env.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await (await env.dispatchFetch(blobUrl)).response?.text()).toBe("original");
    expect(await (await env.dispatchFetch(thumbUrl)).response?.text()).toBe("thumb");
    expect(env.fetchMock).toHaveBeenCalledTimes(2);

    // A deploy replaces the shell cache only.
    const next = createMockSwEnv("markyard-shell-v3", PRECACHE);
    for (const [name, entries] of env.stores) next.stores.set(name, entries);
    await next.dispatchExtendable("activate");
    expect(next.stores.has(IMAGE_CACHES.blob)).toBe(true);
    expect(next.stores.has(IMAGE_CACHES.thumb)).toBe(true);
  });

  it("does not store failed, non-image, redirected or stand-in thumbnail answers", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");
    const redirected = png("login");
    Object.defineProperty(redirected, "redirected", { value: true });
    for (const response of [
      basicResponse('{"error":"unauthenticated"}', 401, { "content-type": "application/json" }),
      basicResponse("<html>", 200, { "content-type": "text/html" }),
      redirected,
    ]) {
      env.fetchMock.mockResolvedValueOnce(response);
      await env.dispatchFetch("https://notes.example.com/api/files/img-1/blob");
    }
    env.fetchMock.mockResolvedValueOnce(png("original", { "x-thumbnail-source": "original" }));
    const standIn = await env.dispatchFetch(
      "https://notes.example.com/api/files/img-1/thumb?size=640",
    );
    expect(await standIn.response?.text()).toBe("original");

    expect(env.stores.get(IMAGE_CACHES.blob)?.size ?? 0).toBe(0);
    expect(env.stores.get(IMAGE_CACHES.thumb)?.size ?? 0).toBe(0);
  });

  it("keeps only the newest images up to the limit", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");
    env.fetchMock.mockImplementation(async () => png("x"));
    for (let n = 0; n <= IMAGE_CACHE_LIMITS.blob; n += 1) {
      await env.dispatchFetch(`https://notes.example.com/api/files/img-${n}/blob`);
    }
    const keys = Array.from(env.stores.get(IMAGE_CACHES.blob)!.keys());
    expect(keys).toHaveLength(IMAGE_CACHE_LIMITS.blob);
    expect(keys[0]).toBe("/api/files/img-1/blob");
  });

  it("ignores non-GET, cross-origin, and /sw.js requests", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");

    expect(
      (await env.dispatchFetch("https://notes.example.com/index.html", { method: "POST" }))
        .intercepted,
    ).toBe(false);
    expect(
      (await env.dispatchFetch("https://accounts.google.com/o/oauth2/v2/auth")).intercepted,
    ).toBe(false);
    expect((await env.dispatchFetch("https://notes.example.com/sw.js")).intercepted).toBe(false);
  });

  it("serves precached static assets from cache without hitting the network", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");

    const result = await env.dispatchFetch("https://notes.example.com/assets/index-abc.js");
    expect(result.intercepted).toBe(true);
    expect(await result.response?.text()).toBe("cached:/assets/index-abc.js");
    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it("uses network-first for navigations and falls back to cached /index.html when offline", async () => {
    const env = createMockSwEnv(CACHE_V2, PRECACHE);
    await env.dispatchExtendable("install");

    // Online navigation returns fresh HTML from network and updates cached /index.html.
    env.fetchMock.mockResolvedValueOnce(basicResponse("<html>fresh</html>"));
    const online = await env.dispatchFetch("https://notes.example.com/?file=a-id", {
      mode: "navigate",
    });
    expect(online.intercepted).toBe(true);
    expect(await online.response?.text()).toBe("<html>fresh</html>");

    // Offline navigation falls back to the cached /index.html shell.
    env.fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = await env.dispatchFetch("https://notes.example.com/?file=a-id", {
      mode: "navigate",
    });
    expect(offline.intercepted).toBe(true);
    expect(await offline.response?.text()).toBe("<html>fresh</html>");
  });
});
