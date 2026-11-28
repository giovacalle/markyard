// Serves the built web app (`web/dist`) the way Cloudflare Workers static assets do for Markyard:
// security headers, SPA fallback for navigations only, MIME types, ETag / 304 and Cache-Control.
// Shared by the Node host and `scripts/mock-api.mjs`, so both serve static files the same way.
// Web-standard `(Request) => Response`; no Cloudflare or Alchemy import.

import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

// The single source of truth for security header values is the BFF (`bff/test/app.test.ts`
// pins them against `web/public/_headers`). They are imported here, never parsed or copied.
import { CSP, NOSNIFF, PERMISSIONS_POLICY, REFERRER_POLICY } from "../bff/src/http/app.ts";

/** Headers `web/public/_headers` applies to every static response (`/*`). */
export const SECURITY_HEADERS = Object.freeze([
  ["content-security-policy", CSP],
  ["x-content-type-options", NOSNIFF],
  ["referrer-policy", REFERRER_POLICY],
  ["permissions-policy", PERMISSIONS_POLICY],
]);

/** Cloudflare's default for assets without a content hash: always revalidate. */
export const CACHE_REVALIDATE = "public, max-age=0, must-revalidate";
/** Vite writes content-hashed file names under `/assets/`, so they never change. */
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
]);

/** Files in the dist folder that configure the host and are never served. */
const HIDDEN_FILES = new Set(["_headers", "_redirects"]);

export const contentTypeFor = (filePath) =>
  MIME_TYPES.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";

export const cacheControlFor = (pathname) =>
  pathname.startsWith("/assets/") ? CACHE_IMMUTABLE : CACHE_REVALIDATE;

/**
 * A browser navigation (address bar, link, reload). Requests without Fetch Metadata count as
 * navigations when they ask for HTML, so `curl -H 'Accept: text/html'` behaves like a browser.
 */
export const isNavigation = (request) => {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
};

const plain = (status, text) =>
  new Response(text, {
    status,
    headers: withSecurity(new Headers({ "content-type": "text/plain; charset=utf-8" })),
  });

const withSecurity = (headers) => {
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  return headers;
};

const etagFor = (stats) => `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

/** `If-None-Match` uses the weak comparison (RFC 9110 13.1.2). */
const matchesIfNoneMatch = (header, etag) => {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === bare);
};

/**
 * The regular file `rel` names inside `root`, or `undefined`. Refuses symlinks anywhere below
 * `root` (lstat on every segment), so a link cannot point outside the dist folder.
 */
const regularFileInside = async (root, rel) => {
  const segments = rel.split(sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      return undefined;
    }
    if (stats.isSymbolicLink()) return undefined;
    if (index === segments.length - 1) {
      return stats.isFile() ? { path: current, stats } : undefined;
    }
    if (!stats.isDirectory()) return undefined;
  }
  return undefined;
};

/**
 * Builds the static handler for `distDir`. It answers `GET`/`HEAD` for files that exist, SPA
 * navigations (`index.html`) and refused paths; it returns `undefined` for everything else, so
 * the caller can hand the request to the BFF (whose catch-all is the JSON 404).
 *
 * @param {{ distDir: string }} options
 * @returns {(request: Request) => Promise<Response | undefined>}
 */
export const createStaticHandler = ({ distDir }) => {
  const rootPromise = realpath(resolve(distDir));

  const serveFile = (request, pathname, file) => {
    const etag = etagFor(file.stats);
    const headers = withSecurity(
      new Headers({
        etag,
        "cache-control": cacheControlFor(pathname),
        "last-modified": file.stats.mtime.toUTCString(),
      }),
    );
    if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("content-type", contentTypeFor(file.path));
    headers.set("content-length", String(file.stats.size));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    // Streamed from disk, never read whole into memory.
    const body = Readable.toWeb(createReadStream(file.path));
    return new Response(body, { status: 200, headers });
  };

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const root = await rootPromise;
    const rawPathname = new URL(request.url).pathname;

    let pathname;
    try {
      pathname = decodeURIComponent(rawPathname);
    } catch {
      return plain(400, "Bad Request");
    }
    if (pathname.includes("\0") || pathname.includes("\\")) return plain(400, "Bad Request");

    const target = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const rel = relative(root, resolve(root, `.${target}`));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return plain(403, "Forbidden");

    const hidden = HIDDEN_FILES.has(rel);
    const file = hidden ? undefined : await regularFileInside(root, rel);
    if (file !== undefined) return serveFile(request, pathname, file);

    if (!isNavigation(request)) return undefined;
    const index = await regularFileInside(root, "index.html");
    return index === undefined ? undefined : serveFile(request, "/index.html", index);
  };
};
