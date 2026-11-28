import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import * as Effect from "effect/Effect";

import { FAKE_GOOGLE, NOW, RANDOM, signedInCookie, testEnv } from "../bff/test/support/harness.ts";
import { createHost } from "./host.mjs";
import { createGuardedFetch, guardedLookup, isBlockedAddress } from "./ssrf-guard.mjs";

/** A DNS stand-in: name -> addresses, like `dns.lookup(name, { all: true })`. */
const RECORDS = {
  "127.0.0.1.nip.io": ["127.0.0.1"],
  "169.254.169.254.nip.io": ["169.254.169.254"],
  "intranet.corp.example": ["10.0.0.5"],
  "v6-loopback.example": ["::1"],
  "v6-ula.example": ["fd00::1"],
  "v6-mapped.example": ["::ffff:192.168.1.1"],
  "mixed.example": ["93.184.215.14", "10.0.0.1"],
  "public.example": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
};
const fakeResolve = (hostname, options, callback) => {
  const addresses = RECORDS[hostname];
  if (addresses === undefined) {
    return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
  }
  callback(
    null,
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
};

const lookupOf = (hostname, options) =>
  new Promise((resolve) => {
    guardedLookup(fakeResolve)(hostname, options, (error, address, family) =>
      resolve({ error, address, family }),
    );
  });

describe("isBlockedAddress", () => {
  const cases = [
    ["127.0.0.1", true],
    ["127.255.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.0.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["::", true],
    ["::1", true],
    ["[::1]", true],
    ["fd00::1", true],
    ["fc00::1", true],
    ["fe80::1%eth0", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:a9fe:a9fe", true],
    ["64:ff9b::10.0.0.1", true],
    ["::127.0.0.1", true],
    ["not-an-ip", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["100.128.0.1", false],
    ["93.184.215.14", false],
    ["::ffff:8.8.8.8", false],
    ["2606:4700::1111", false],
  ];
  for (const [address, expected] of cases) {
    it(`${address} -> ${expected ? "blocked" : "allowed"}`, () => {
      assert.equal(isBlockedAddress(address), expected);
    });
  }
});

describe("guardedLookup", () => {
  for (const name of [
    "127.0.0.1.nip.io",
    "169.254.169.254.nip.io",
    "intranet.corp.example",
    "v6-loopback.example",
    "v6-ula.example",
    "v6-mapped.example",
    "mixed.example",
  ]) {
    it(`rejects ${name}`, async () => {
      for (const all of [false, true]) {
        const { error } = await lookupOf(name, { all });
        assert.equal(error?.code, "ERR_SSRF_BLOCKED");
        assert.doesNotMatch(error.message.replace(name, ""), /\d+\.\d+\.\d+\.\d+|::/, "no address");
      }
    });
  }

  it("allows a public host, answering in the shape asked for", async () => {
    const one = await lookupOf("public.example", {});
    assert.deepEqual(one, { error: null, address: "93.184.215.14", family: 4 });
    const all = await lookupOf("public.example", { all: true });
    assert.equal(all.error, null);
    assert.equal(all.address.length, 2);
  });

  it("passes resolver errors through", async () => {
    const { error } = await lookupOf("nxdomain.example", {});
    assert.equal(error.code, "ENOTFOUND");
  });
});

describe("createGuardedFetch", () => {
  const guarded = createGuardedFetch({ resolve: fakeResolve });
  let server;
  let port;
  let hits = 0;

  before(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("internal");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  const rejection = async (url) => {
    try {
      await guarded(new Request(url));
    } catch (error) {
      return error.cause?.code ?? error.code;
    }
    return "resolved";
  };

  it("never dials a name that resolves to a blocked address, nor a blocked literal", async () => {
    assert.equal(await rejection(`http://127.0.0.1.nip.io:${port}/`), "ERR_SSRF_BLOCKED");
    assert.equal(await rejection(`http://v6-loopback.example:${port}/`), "ERR_SSRF_BLOCKED");
    assert.equal(await rejection(`http://127.0.0.1:${port}/`), "ERR_SSRF_BLOCKED");
    assert.equal(await rejection(`http://[::1]:${port}/`), "ERR_SSRF_BLOCKED");
    assert.equal(hits, 0);
  });
});

describe("the BFF behind the guard", () => {
  const entropy = { nowSeconds: Effect.succeed(NOW), random64: Effect.sync(() => RANDOM.slice()) };
  const guarded = createGuardedFetch({ resolve: fakeResolve });
  const guardedCalls = [];
  /** `start.example` redirects to a blocked name without dialling; everything else is guarded. */
  const upstream = async (request) => {
    const { hostname } = new URL(request.url);
    if (hostname === "start.example") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254.nip.io/latest/meta-data/" },
      });
    }
    guardedCalls.push(hostname);
    return guarded(request);
  };
  const distDir = mkdtempSync(join(tmpdir(), "markyard-ssrf-"));
  after(() => rmSync(distDir, { recursive: true, force: true }));
  const host = createHost({ distDir, env: testEnv(), fetch: upstream, entropy, google: FAKE_GOOGLE });
  const preview = async (url) =>
    host(
      new Request(`http://host.test/api/link-preview?url=${encodeURIComponent(url)}`, {
        headers: { cookie: await signedInCookie() },
      }),
    );

  for (const url of [
    "http://127.0.0.1.nip.io/",
    "http://169.254.169.254.nip.io/latest/meta-data/",
    "https://intranet.corp.example/",
    "https://v6-ula.example/",
    "https://start.example/",
  ]) {
    it(`answers the existing link-preview failure for ${url}`, async () => {
      guardedCalls.length = 0;
      const res = await preview(url);
      assert.equal(guardedCalls.length, 1, "the blocked hop went through the guarded fetch");
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), {
        code: "upstream_error",
        message: "The link could not be reached.",
      });
      assert.doesNotMatch(text, /169\.254|10\.0\.0|127\.0\.0|fd00|ERR_SSRF|at /);
    });
  }
});
