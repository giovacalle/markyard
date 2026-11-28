import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import * as Effect from "effect/Effect";

import { signedInCookie, testEnv } from "../bff/test/support/harness.ts";
import { stateStoreFromEnv } from "../bff/src/infrastructure/d1-state-store.ts";
import { startServer } from "./server.mjs";
import { d1Of, openSqliteD1 } from "./sqlite-d1.mjs";

const STATE = (theme) => ({ theme });
const run = (effect) => Effect.runPromise(effect);

describe("d1Of", () => {
  it("first() answers null for no row, plain objects and numbers (not bigints) otherwise", async () => {
    const d1 = d1Of(new DatabaseSync(":memory:"));
    await d1.prepare("CREATE TABLE t (a INTEGER, b TEXT)").run();
    const inserted = await d1.prepare("INSERT INTO t VALUES (?1, ?2)").bind(1_700_000_000_000, "x").run();
    assert.equal(inserted.meta.changes, 1);
    assert.equal(await d1.prepare("SELECT * FROM t WHERE a = ?1").bind(5).first(), null);
    const row = await d1.prepare("SELECT * FROM t WHERE a = ?1").bind(1_700_000_000_000).first();
    assert.deepEqual(row, { a: 1_700_000_000_000, b: "x" });
    assert.equal(typeof row.a, "number");
  });

  it("rejects a bad query when it runs, like D1, instead of throwing from prepare", async () => {
    const d1 = d1Of(new DatabaseSync(":memory:"));
    const statement = d1.prepare("SELECT * FROM missing");
    await assert.rejects(statement.first(), /no such table/);
  });

  it("opens files with WAL and a busy timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "markyard-sqlite-"));
    try {
      const { db } = openSqliteD1(join(dir, "state.db"));
      assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the BFF D1 state store on node:sqlite", () => {
  const store = () => stateStoreFromEnv({ STATE_DB: d1Of(new DatabaseSync(":memory:")) });

  it("is enabled, and reads null before the first write", async () => {
    const s = store();
    assert.equal(s.enabled, true);
    assert.equal(await run(s.get("a@b.c")), null);
  });

  it("upserts, keyed by the lower-cased email", async () => {
    const s = store();
    assert.deepEqual(await run(s.put("A@B.c", STATE("dark"), 100)), { state: STATE("dark"), updatedAt: 100 });
    assert.deepEqual(await run(s.put("a@b.c", STATE("light"), 200)), { state: STATE("light"), updatedAt: 200 });
    assert.deepEqual(await run(s.get("a@B.C")), { state: STATE("light"), updatedAt: 200 });
  });

  it("keeps the newer row when a stale write arrives, and answers it", async () => {
    const s = store();
    await run(s.put("a@b.c", STATE("dark"), 200));
    assert.deepEqual(await run(s.put("a@b.c", STATE("light"), 100)), { state: STATE("dark"), updatedAt: 200 });
    assert.deepEqual(await run(s.put("a@b.c", STATE("light"), 200)), { state: STATE("light"), updatedAt: 200 });
  });

  it("a raw DatabaseSync passes the duck type but fails, which is why the adapter exists", async () => {
    const s = stateStoreFromEnv({ STATE_DB: new DatabaseSync(":memory:") });
    assert.equal(s.enabled, true);
    await assert.rejects(run(s.get("a@b.c")));
  });
});

describe("startServer with STATE_DB_FILE", () => {
  const parent = mkdtempSync(join(tmpdir(), "markyard-state-"));
  const dist = join(parent, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  after(() => rmSync(parent, { recursive: true, force: true }));

  const boot = (extra) =>
    startServer({ source: { ...testEnv(), DIST_DIR: dist, PORT: "0", HOST: "127.0.0.1", ...extra }, log: () => {} });

  it("persists state across restarts on the same file, and is off without it", async () => {
    const cookie = await signedInCookie();
    const file = join(parent, "data", "state.db");
    mkdirSync(join(parent, "data"));
    const state = { theme: "dark" };

    let server = await boot({ STATE_DB_FILE: file });
    const put = await fetch(new URL("/api/state", server.url), {
      method: "PUT",
      headers: { cookie, origin: testEnv().PUBLIC_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ state, updatedAt: 1000 }),
    });
    assert.equal(put.status, 200, await put.clone().text());
    await server.close(true);

    server = await boot({ STATE_DB_FILE: file });
    const got = await (await fetch(new URL("/api/state", server.url), { headers: { cookie } })).json();
    assert.deepEqual(got, { enabled: true, state, updatedAt: 1000 });
    await server.close(true);

    server = await boot({});
    const off = await (await fetch(new URL("/api/state", server.url), { headers: { cookie } })).json();
    assert.equal(off.enabled, false);
    await server.close(true);
  });
});
