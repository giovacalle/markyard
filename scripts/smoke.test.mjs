import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createRawServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createMockServer, loadFixture } from "./mock-api.mjs";
import { testEnv } from "../bff/test/support/harness.ts";
import { startServer } from "../host-node/server.mjs";
import { main, runHostMatrix, runMatrix, runSmoke } from "./smoke.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const defaultFixtureFile = resolve(testDir, "mock-api.fixture.json");
const rootPackageJson = resolve(repoRoot, "package.json");

function makeTempDist() {
  const parent = mkdtempSync(join(tmpdir(), "markyard-smoke-"));
  const dir = join(parent, "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>ok</body></html>");
  return { parent, dir };
}

function makeMemoryOut() {
  let text = "";
  return {
    out: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

describe("smoke runner", () => {
  const { parent, dir: distDir } = makeTempDist();
  const emptyDist = join(parent, "empty-dist");
  mkdirSync(emptyDist, { recursive: true });

  after(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("t1: runs the full matrix against mock-api and stops the server on success", async () => {
    const capture = makeMemoryOut();
    const result = await runSmoke({
      build: async () => {},
      distDir,
      out: capture.out,
    });

    assert.equal(result.exitCode, 0, capture.text());
    assert.match(result.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(
      () => fetch(result.baseUrl),
      (err) => err?.cause?.code === "ECONNREFUSED" || err?.code === "ECONNREFUSED",
    );
  });

  it("t2: fails the matrix and names the broken step when a route returns 500", async () => {
    const defaultFixture = JSON.parse(readFileSync(defaultFixtureFile, "utf8"));
    const inner = createMockServer({
      distDir,
      fixture: loadFixture(defaultFixture),
    });
    const innerHandler = inner.listeners("request")[0];
    const wrapper = createRawServer((req, res) => {
      if (req.url === "/api/session") {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("boom");
        return;
      }
      innerHandler(req, res);
    });

    await new Promise((resolveListen, rejectListen) => {
      wrapper.once("error", rejectListen);
      wrapper.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = wrapper.address();
    assert.ok(address && typeof address === "object");
    const wrapperBaseUrl = `http://127.0.0.1:${address.port}`;
    const capture = makeMemoryOut();

    try {
      await assert.rejects(
        () => runMatrix(wrapperBaseUrl, { out: capture.out }),
        /\bsession\b/i,
      );
      assert.match(capture.text(), /FAIL session:/);
    } finally {
      await new Promise((done) => wrapper.close(() => done()));
    }
  });

  it("t3: stops the server and returns exitCode 1 when the matrix fails on a fixture without root notes", async () => {
    const noRootNoteFixture = join(parent, "no-root-note.json");
    writeFileSync(noRootNoteFixture, JSON.stringify({ files: { "notes/a.md": "x" } }));
    const capture = makeMemoryOut();

    const result = await runSmoke({
      build: async () => {},
      distDir,
      fixtureFile: noRootNoteFixture,
      out: capture.out,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(capture.text(), /FAIL children:/);
    await assert.rejects(
      () => fetch(result.baseUrl),
      (err) => err?.cause?.code === "ECONNREFUSED" || err?.code === "ECONNREFUSED",
    );
  });

  it("t4: returns non-zero exitCode with undefined baseUrl when build fails", async () => {
    const capture = makeMemoryOut();
    const result = await runSmoke({
      build: () => Promise.reject(new Error("boom")),
      out: capture.out,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.baseUrl, undefined);
    assert.match(capture.text(), /boom/);
  });

  it("t4b: fails immediately with child stderr when mock-api exits before listening", async () => {
    const capture = makeMemoryOut();
    const startedAt = Date.now();
    const result = await runSmoke({
      build: async () => {},
      distDir: emptyDist,
      out: capture.out,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.exitCode, 1);
    assert.equal(result.baseUrl, undefined);
    assert.ok(elapsedMs < 5000, `expected fast exit, took ${elapsedMs}ms`);
    assert.match(capture.text(), /pnpm build/);
  });

  it("t5: registers smoke and smoke.test.mjs in root package.json", () => {
    const pkg = JSON.parse(readFileSync(rootPackageJson, "utf8"));
    assert.equal(pkg.scripts.smoke, "node scripts/smoke.mjs");
    assert.match(pkg.scripts["test:scripts"], /(^| )scripts\/smoke\.test\.mjs( |$)/);
  });

  it("t6: runs the host matrix against the Node host", async () => {
    const hostDist = join(parent, "host-dist");
    mkdirSync(join(hostDist, "assets"), { recursive: true });
    writeFileSync(
      join(hostDist, "index.html"),
      '<!doctype html><html><head><script type="module" src="/assets/app-1.js"></script></head></html>',
    );
    writeFileSync(join(hostDist, "assets/app-1.js"), "console.log(1)");
    writeFileSync(join(hostDist, "_headers"), "/*\n  X-Test: 1\n");
    const server = await startServer({
      source: { ...testEnv(), DIST_DIR: hostDist, PORT: "0", HOST: "127.0.0.1" },
      log: () => {},
    });
    const capture = makeMemoryOut();
    try {
      await runHostMatrix(server.url.replace(/\/$/, ""), { out: capture.out });
      assert.match(capture.text(), /ok traversal/);
      assert.doesNotMatch(capture.text(), /FAIL/);
    } finally {
      await server.close(true);
    }
  });

  it("t7: main rejects a malformed --target with usage and exit code 2", async () => {
    const capture = makeMemoryOut();
    assert.equal(await main(["--target", "not-a-url"], capture.out), 2);
    assert.match(capture.text(), /usage:/);
  });
});
