import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as Effect from "effect/Effect";

import {
  FAKE_GOOGLE,
  FakeGoogle,
  NOW,
  RANDOM,
  json,
  on,
  signedInCookie,
  testEnv,
} from "../bff/test/support/harness.ts";
import { CSP, NO_STORE_NO_TRANSFORM } from "../bff/src/http/app.ts";
import { BFF_ENV_NAMES, bffEnvFrom, createHost, withAccessLog } from "./host.mjs";
import { startServer } from "./server.mjs";

const INDEX = "<!doctype html><html><body>ok</body></html>";
const entropy = { nowSeconds: Effect.succeed(NOW), random64: Effect.sync(() => RANDOM.slice()) };

function makeDist() {
  const parent = mkdtempSync(join(tmpdir(), "markyard-host-"));
  const dir = join(parent, "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets/app-1.js"), "console.log(1)");
  return { parent, dir };
}

/** A `node:http` request, so the test controls the socket (and can drop it mid-response). */
function rawRequest(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest(new URL(path, baseUrl), { method, headers, agent: false }, (res) => resolveReq({ req, res }));
    req.on("error", rejectReq);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const readAll = (res) =>
  new Promise((done) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });

describe("bffEnvFrom", () => {
  it("keeps only the Cloudflare binding names and freezes the object", () => {
    const env = bffEnvFrom({ PUBLIC_ORIGIN: "http://localhost:8080", PATH: "/bin", COOKIE_KEYS: "1:aa" });
    assert.deepEqual(env, { PUBLIC_ORIGIN: "http://localhost:8080", COOKIE_KEYS: "1:aa" });
    assert.ok(Object.isFrozen(env));
    assert.deepEqual(BFF_ENV_NAMES, [
      "PUBLIC_ORIGIN",
      "ALLOWED_EMAILS",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "COOKIE_KEYS",
    ]);
  });
});

describe("createHost routing", () => {
  const { parent, dir } = makeDist();
  const google = new FakeGoogle();
  const host = createHost({ distDir: dir, env: testEnv(), fetch: google.fetch, entropy, google: FAKE_GOOGLE });
  const send = (path, init = {}) => host(new Request(`http://host.test${path}`, init));
  after(() => rmSync(parent, { recursive: true, force: true }));

  it("sends /api/* to the BFF with its security headers", async () => {
    const res = await send("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), CSP);
    assert.equal(res.headers.get("cache-control"), NO_STORE_NO_TRANSFORM);
    assert.equal((await send("/api/session")).status, 401);
  });

  it("serves static files and SPA navigations, and hands other misses to the BFF JSON 404", async () => {
    assert.equal(await (await send("/")).text(), INDEX);
    assert.equal((await send("/assets/app-1.js")).status, 200);
    const nav = await send("/notes/a", { headers: { "sec-fetch-mode": "navigate" } });
    assert.equal(await nav.text(), INDEX);
    for (const path of ["/notes/a", "/assets/missing.js", "/api"]) {
      const res = await send(path, { headers: { "sec-fetch-mode": "cors" } });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { code: "not_found", message: "Not found" });
      assert.equal(res.headers.get("content-security-policy"), CSP);
    }
    // A navigation to /api/* never gets the SPA shell.
    const apiNav = await send("/api/nope", { headers: { "sec-fetch-mode": "navigate" } });
    assert.equal(apiNav.status, 404);
  });

  it("does not let static files shadow the BFF", async () => {
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(join(dir, "api", "health"), "shadow");
    const res = await send("/api/health");
    assert.equal(res.headers.get("content-type"), "application/json");
  });
});

describe("withAccessLog", () => {
  it("logs method, path without query, status and duration", async () => {
    const lines = [];
    const handler = withAccessLog(async () => new Response(null, { status: 204 }), (l) => lines.push(l));
    await handler(new Request("http://host.test/api/auth/callback?code=SECRET&state=x"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+Z GET \/api\/auth\/callback 204 \d+\.\dms$/);
    assert.doesNotMatch(lines[0], /SECRET/);
  });

  it("logs 500 when the handler throws", async () => {
    const lines = [];
    const handler = withAccessLog(async () => {
      throw new Error("boom");
    }, (l) => lines.push(l));
    await assert.rejects(handler(new Request("http://host.test/x")));
    assert.match(lines[0], / GET \/x 500 /);
  });
});

describe("startServer (srvx bridge)", () => {
  const { parent, dir } = makeDist();
  const logs = [];
  let server;
  let baseUrl;
  let cookie;
  const upstream = { cancelled: false, cancelledResolve: undefined };
  const cancelled = new Promise((r) => (upstream.cancelledResolve = r));

  const google = new FakeGoogle([
    on(
      "GET",
      "https://fake.test/drive/v2/files/doc-1",
      json(200, {
        etag: '"MTcwMDAwMDAwMDAwMA"',
        fileSize: String(5 * 1024 * 1024),
        mimeType: "text/markdown",
        labels: { trashed: false },
      }),
    ),
  ]);
  /** Drive's `alt=media` answer: one chunk, then nothing until it is cancelled. */
  const fetchUpstream = async (request) => {
    if (request.url.includes("alt=media")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024).fill(65));
          },
          cancel() {
            upstream.cancelled = true;
            upstream.cancelledResolve();
          },
        }),
        { status: 200 },
      );
    }
    return google.fetch(request);
  };

  before(async () => {
    cookie = await signedInCookie();
    server = await startServer({
      source: { ...testEnv(), DIST_DIR: dir, PORT: "0", HOST: "127.0.0.1" },
      log: (line) => logs.push(line),
      fetch: fetchUpstream,
      entropy,
      google: FAKE_GOOGLE,
    });
    baseUrl = server.url;
  });

  after(async () => {
    await server?.close(true);
    rmSync(parent, { recursive: true, force: true });
  });

  it("serves /api/health with security headers and writes an access log line", async () => {
    const res = await fetch(new URL("/api/health", baseUrl));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), CSP);
    await res.text();
    assert.ok(logs.some((l) => / GET \/api\/health 200 /.test(l)), logs.join("\n"));
  });

  it("passes Content-Length through, so the BFF 10 MB cap answers before reading the body", async () => {
    const { req, res } = await rawRequest(baseUrl, "/api/files/doc-1/content", {
      method: "PUT",
      headers: {
        cookie,
        origin: "https://notes.test",
        "if-match": '"MTcwMDAwMDAwMDAwMA"',
        "content-length": String(11 * 1024 * 1024),
      },
      body: "partial",
    });
    assert.equal(res.statusCode, 413);
    await readAll(res);
    req.destroy();
  });

  it("cancels the upstream Drive download when the client disconnects mid-stream", async () => {
    const { req, res } = await rawRequest(baseUrl, "/api/files/doc-1/content", { headers: { cookie } });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => res.once("data", r));
    assert.equal(upstream.cancelled, false);
    req.destroy();
    const outcome = await Promise.race([
      cancelled.then(() => "cancelled"),
      new Promise((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    assert.equal(outcome, "cancelled");
  });
});
