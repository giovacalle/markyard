import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CSP, NOSNIFF, PERMISSIONS_POLICY, REFERRER_POLICY } from "../bff/src/http/app.ts";
import {
  CACHE_IMMUTABLE,
  CACHE_REVALIDATE,
  SECURITY_HEADERS,
  createStaticHandler,
  isNavigation,
} from "./static-host.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = "<!doctype html><html><body>ok</body></html>";

function makeDist() {
  const parent = mkdtempSync(join(tmpdir(), "markyard-static-host-"));
  const dir = join(parent, "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "icons"), { recursive: true });
  writeFileSync(join(parent, "secret.txt"), "TOP_SECRET_OUTSIDE_DIST");
  mkdirSync(join(parent, "outside"));
  writeFileSync(join(parent, "outside", "leak.js"), "TOP_SECRET_OUTSIDE_DIST");
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(dir, "_headers"), "/*\n  X-From-Headers-File: yes\n");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"Markyard"}');
  writeFileSync(join(dir, "assets/app-Ab12Cd34.js"), "console.log('app');");
  writeFileSync(join(dir, "assets/app-Ab12Cd34.css"), "body{}");
  writeFileSync(join(dir, "assets/font-Ab12.woff2"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(dir, "icons/icon.svg"), "<svg></svg>");
  writeFileSync(join(dir, "icons/icon.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
  symlinkSync(join(parent, "secret.txt"), join(dir, "link.txt"));
  symlinkSync(join(parent, "outside"), join(dir, "linked-dir"));
  return { parent, dir };
}

const NAV = { "sec-fetch-mode": "navigate" };
const FETCH = { "sec-fetch-mode": "cors" };

describe("static host", () => {
  const { parent, dir } = makeDist();
  const handle = createStaticHandler({ distDir: dir });
  const get = (path, headers = FETCH, method = "GET") =>
    handle(new Request(`http://host.test${path}`, { method, headers }));

  after(() => rmSync(parent, { recursive: true, force: true }));

  it("uses the BFF security header constants, which match web/public/_headers", async () => {
    assert.deepEqual(SECURITY_HEADERS, [
      ["content-security-policy", CSP],
      ["x-content-type-options", NOSNIFF],
      ["referrer-policy", REFERRER_POLICY],
      ["permissions-policy", PERMISSIONS_POLICY],
    ]);
    const headersFile = readFileSync(join(repoRoot, "web/public/_headers"), "utf8");
    for (const [name, value] of SECURITY_HEADERS) {
      assert.match(headersFile.toLowerCase(), new RegExp(`${name}: `), name);
      assert.ok(headersFile.includes(value), `${name} value present in _headers`);
    }
    for (const res of [await get("/"), await get("/assets/app-Ab12Cd34.js"), await get("/x", NAV)]) {
      for (const [name, value] of SECURITY_HEADERS) assert.equal(res.headers.get(name), value);
      assert.equal(res.headers.get("x-from-headers-file"), null, "_headers is never parsed");
    }
  });

  it("serves files with their MIME type and exact length", async () => {
    const cases = [
      ["/", /^text\/html; charset=utf-8$/],
      ["/sw.js", /^text\/javascript\b/],
      ["/assets/app-Ab12Cd34.js", /^text\/javascript\b/],
      ["/assets/app-Ab12Cd34.css", /^text\/css\b/],
      ["/assets/font-Ab12.woff2", /^font\/woff2$/],
      ["/manifest.webmanifest", /^application\/manifest\+json\b/],
      ["/icons/icon.svg", /^image\/svg\+xml$/],
      ["/icons/icon.png", /^image\/png$/],
      ["/big.bin", /^application\/octet-stream$/],
    ];
    for (const [path, type] of cases) {
      const res = await get(path);
      assert.equal(res?.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", type, path);
      const body = new Uint8Array(await res.arrayBuffer());
      assert.equal(res.headers.get("content-length"), String(body.byteLength), path);
    }
    const head = await get("/", FETCH, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(INDEX.length));
    assert.equal(head.body, null);
  });

  it("streams bodies from disk in chunks", async () => {
    const res = await get("/big.bin");
    assert.ok(res.body instanceof ReadableStream);
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.ok(first.value.byteLength < 3 * 1024 * 1024, "first chunk is smaller than the file");
    await reader.cancel();
  });

  it("falls back to index.html for navigations only", async () => {
    const nav = await get("/some/deep/route", NAV);
    assert.equal(nav.status, 200);
    assert.equal(await nav.text(), INDEX);
    assert.equal(nav.headers.get("cache-control"), CACHE_REVALIDATE);

    assert.equal(await get("/some/deep/route", FETCH), undefined);
    assert.equal(await get("/assets/missing.js", FETCH), undefined);
    assert.equal(await get("/api/nothing", FETCH), undefined);

    const legacy = await get("/route", { accept: "text/html,application/xhtml+xml" });
    assert.equal(legacy.status, 200, "no Fetch Metadata + Accept: text/html is a navigation");
    assert.equal(await get("/route", { accept: "*/*" }), undefined);

    assert.equal(await get("/", NAV, "POST"), undefined, "non-GET/HEAD goes to the BFF");
  });

  it("classifies navigations", () => {
    const req = (headers) => new Request("http://host.test/", { headers });
    assert.equal(isNavigation(req(NAV)), true);
    assert.equal(isNavigation(req({ "sec-fetch-mode": "no-cors", accept: "text/html" })), false);
    assert.equal(isNavigation(req({ accept: "text/html" })), true);
    assert.equal(isNavigation(req({})), false);
  });

  it("answers ETag revalidation with 304", async () => {
    const first = await get("/assets/app-Ab12Cd34.js");
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await get("/assets/app-Ab12Cd34.js", { ...FETCH, "if-none-match": header });
      assert.equal(res.status, 304, header);
      assert.equal(res.body, null);
      assert.equal(res.headers.get("etag"), etag);
      assert.equal(res.headers.get("cache-control"), CACHE_IMMUTABLE);
      assert.equal(res.headers.get("content-security-policy"), CSP);
    }
    const stale = await get("/assets/app-Ab12Cd34.js", { ...FETCH, "if-none-match": '"nope"' });
    assert.equal(stale.status, 200);
  });

  it("sets Cache-Control per asset class", async () => {
    const cases = [
      ["/", CACHE_REVALIDATE],
      ["/index.html", CACHE_REVALIDATE],
      ["/sw.js", CACHE_REVALIDATE],
      ["/manifest.webmanifest", CACHE_REVALIDATE],
      ["/icons/icon.png", CACHE_REVALIDATE],
      ["/assets/app-Ab12Cd34.js", CACHE_IMMUTABLE],
      ["/assets/font-Ab12.woff2", CACHE_IMMUTABLE],
    ];
    for (const [path, expected] of cases) {
      assert.equal((await get(path)).headers.get("cache-control"), expected, path);
    }
  });

  it("never serves _headers", async () => {
    assert.equal(await get("/_headers"), undefined);
    const nav = await get("/_headers", NAV);
    assert.equal(await nav.text(), INDEX);
  });

  it("refuses traversal and symlinks", async () => {
    for (const path of ["/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%2fsecret.txt"]) {
      const res = await get(path, NAV);
      assert.equal(res.status, 403, path);
      assert.doesNotMatch(await res.text(), /TOP_SECRET/);
    }
    assert.equal((await get("/..%5csecret.txt")).status, 400);
    assert.equal((await get("/%E0%A4%A")).status, 400);
    assert.equal(await get("/link.txt"), undefined);
    assert.equal(await get("/linked-dir/leak.js"), undefined);
    assert.equal(await (await get("/link.txt", NAV)).text(), INDEX);
  });
});
