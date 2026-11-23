// `GET`/`PUT /api/state` and the `cloudSync` flag of `GET /api/session`, with and without a
// bound `STATE_DB`.

import { describe, expect, it } from "vite-plus/test";

import { MAX_EXPANDED_FOLDERS, MAX_STATE_BYTES } from "../src/domain/state.ts";
import { FakeD1 } from "./support/fake-d1.ts";
import {
  EMAIL,
  FakeGoogle,
  get,
  NOW,
  request,
  send,
  signedInCookie,
  storedSession,
  testEnv,
} from "./support/harness.ts";

const DISABLED = { enabled: false, state: null, updatedAt: null };

const STATE = {
  theme: "dark",
  lastOpenFileId: "file-1",
  expandedFolders: ["folder-a", "folder-b"],
  readOnly: false,
  focusMode: true,
  typewriterMode: false,
  infoDrawerOpen: true,
} as const;

const cookieFor = (email: string = EMAIL) =>
  signedInCookie({ ...storedSession(NOW + 3600), email, rootFolderId: "root-id" });

const putState = async (body: unknown, cookie?: string): Promise<Request> =>
  request("PUT", "/api/state", {
    cookie: cookie ?? (await cookieFor()),
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const getState = async (cookie?: string): Promise<Request> =>
  get("/api/state", { cookie: cookie ?? (await cookieFor()) });

describe("state without a session", () => {
  it("get_and_put_are_401", async () => {
    for (const stateDb of [undefined, new FakeD1()]) {
      const google = new FakeGoogle();
      const getRes = await send(get("/api/state"), { google, stateDb });
      const putRes = await send(
        request("PUT", "/api/state", { body: JSON.stringify({ state: {}, updatedAt: 1 }) }),
        { google, stateDb },
      );
      expect(getRes.status).toBe(401);
      expect(putRes.status).toBe(401);
      expect(google.calls).toEqual([]);
    }
  });
});

describe("state without STATE_DB", () => {
  it("session_omits_cloud_sync", async () => {
    const res = await send(get("/api/session", { cookie: await cookieFor() }));
    expect(await res.json()).toEqual({ email: EMAIL });
  });

  it("get_and_put_answer_disabled", async () => {
    const getRes = await send(await getState());
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(DISABLED);

    const putRes = await send(await putState({ state: STATE, updatedAt: 1 }));
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual(DISABLED);
  });

  it("a_non_d1_binding_counts_as_unbound", async () => {
    const res = await send(await getState(), { stateDb: "not a database" });
    expect(await res.json()).toEqual(DISABLED);
  });

  it("put_still_validates_the_body", async () => {
    const res = await send(await putState({ state: { theme: "neon" }, updatedAt: 1 }));
    expect(res.status).toBe(400);
  });
});

describe("state with STATE_DB", () => {
  it("session_reports_cloud_sync_without_upstream_and_only_reads_state", async () => {
    const google = new FakeGoogle();
    const db = new FakeD1();
    const res = await send(get("/api/session", { cookie: await cookieFor() }), {
      google,
      stateDb: db,
    });
    expect(await res.json()).toEqual({ email: EMAIL, cloudSync: true });
    expect(google.calls).toEqual([]);
    // The synced vault root is looked up; nothing is written.
    expect(db.queries.every((q) => !q.startsWith("INSERT"))).toBe(true);
    expect(db.rows.size).toBe(0);
  });

  it("session_survives_a_state_store_failure", async () => {
    const db = new FakeD1();
    db.failWith = "D1_ERROR: network";
    const res = await send(get("/api/session", { cookie: await cookieFor() }), { stateDb: db });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: EMAIL, cloudSync: true });
  });

  it("settings_fields_round_trip_trimmed", async () => {
    const db = new FakeD1();
    const settings = {
      rootFolderId: "vault-1",
      attachmentsFolder: "  assets ",
      dailyNotesFolder: "",
      templatesFolder: "Templates",
      defaultMode: "edit",
      linkPreviewsEnabled: false,
    };
    const res = await send(await putState({ state: settings, updatedAt: 7 }), { stateDb: db });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      state: { ...settings, attachmentsFolder: "assets" },
      updatedAt: 7,
    });

    const cleared = await send(
      await putState({ state: { rootFolderId: null, dailyNotesFolder: "Daily" }, updatedAt: 8 }),
      { stateDb: db },
    );
    expect(await cleared.json()).toEqual({
      enabled: true,
      state: { rootFolderId: null, dailyNotesFolder: "Daily" },
      updatedAt: 8,
    });
  });

  it("empty_user_reads_nulls", async () => {
    const res = await send(await getState(), { stateDb: new FakeD1() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, state: null, updatedAt: null });
  });

  it("put_then_get_round_trips_across_requests_with_case_insensitive_key", async () => {
    const db = new FakeD1();
    const putRes = await send(await putState({ state: STATE, updatedAt: 1000 }), { stateDb: db });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ enabled: true, state: STATE, updatedAt: 1000 });
    expect([...db.rows.keys()]).toEqual([EMAIL.toLowerCase()]);

    const res = await send(await getState(await cookieFor("Owner@Example.COM")), { stateDb: db });
    expect(await res.json()).toEqual({ enabled: true, state: STATE, updatedAt: 1000 });
  });

  it("table_is_ensured_once_per_database", async () => {
    const db = new FakeD1();
    await send(await getState(), { stateDb: db });
    await send(await getState(), { stateDb: db });
    expect(db.queries.filter((q) => q.startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it("stale_put_does_not_overwrite_and_answers_the_newer_state", async () => {
    const db = new FakeD1();
    const newer = { theme: "light", expandedFolders: ["x"] };
    await send(await putState({ state: newer, updatedAt: 2000 }), { stateDb: db });

    const stale = await send(await putState({ state: STATE, updatedAt: 1999 }), { stateDb: db });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ enabled: true, state: newer, updatedAt: 2000 });

    const res = await send(await getState(), { stateDb: db });
    expect(await res.json()).toEqual({ enabled: true, state: newer, updatedAt: 2000 });
  });

  it("equal_updated_at_wins_last_writer", async () => {
    const db = new FakeD1();
    await send(await putState({ state: { theme: "light" }, updatedAt: 5 }), { stateDb: db });
    const res = await send(await putState({ state: { theme: "dark" }, updatedAt: 5 }), {
      stateDb: db,
    });
    expect(await res.json()).toEqual({ enabled: true, state: { theme: "dark" }, updatedAt: 5 });
  });

  it("expanded_folders_are_deduplicated_and_unknown_keys_dropped", async () => {
    const db = new FakeD1();
    const res = await send(
      await putState({
        state: { expandedFolders: ["a", "b", "a"], future: 1, lastOpenFileId: null },
        updatedAt: 1,
      }),
      { stateDb: db },
    );
    expect(await res.json()).toEqual({
      enabled: true,
      state: { expandedFolders: ["a", "b"], lastOpenFileId: null },
      updatedAt: 1,
    });
  });

  it("invalid_payloads_are_400_invalid_request_and_write_nothing", async () => {
    const tooManyFolders = Array.from({ length: MAX_EXPANDED_FOLDERS + 1 }, (_, i) => `f${i}`);
    const oversized = JSON.stringify({
      state: { lastOpenFileId: "a".repeat(MAX_STATE_BYTES) },
      updatedAt: 1,
    });
    const cases: Array<[string, unknown]> = [
      ["bad theme", { state: { theme: "neon" }, updatedAt: 1 }],
      ["bad drive id", { state: { lastOpenFileId: "../etc" }, updatedAt: 1 }],
      ["bad folder id", { state: { expandedFolders: ["ok", "not ok"] }, updatedAt: 1 }],
      ["folders not array", { state: { expandedFolders: "a" }, updatedAt: 1 }],
      ["too many folders", { state: { expandedFolders: tooManyFolders }, updatedAt: 1 }],
      ["bad flag", { state: { readOnly: "yes" }, updatedAt: 1 }],
      ["bad root id", { state: { rootFolderId: "../root" }, updatedAt: 1 }],
      ["root id number", { state: { rootFolderId: 1 }, updatedAt: 1 }],
      ["attachments slash", { state: { attachmentsFolder: "a/b" }, updatedAt: 1 }],
      ["attachments dotdot", { state: { attachmentsFolder: ".." }, updatedAt: 1 }],
      ["attachments blank", { state: { attachmentsFolder: "  " }, updatedAt: 1 }],
      ["daily slash", { state: { dailyNotesFolder: "x/y" }, updatedAt: 1 }],
      ["templates empty", { state: { templatesFolder: "" }, updatedAt: 1 }],
      ["templates number", { state: { templatesFolder: 3 }, updatedAt: 1 }],
      ["bad mode", { state: { defaultMode: "split" }, updatedAt: 1 }],
      ["bad link previews", { state: { linkPreviewsEnabled: "on" }, updatedAt: 1 }],
      ["state array", { state: [], updatedAt: 1 }],
      ["state missing", { updatedAt: 1 }],
      ["negative updatedAt", { state: {}, updatedAt: -1 }],
      ["float updatedAt", { state: {}, updatedAt: 1.5 }],
      ["string updatedAt", { state: {}, updatedAt: "1" }],
      ["unsafe updatedAt", { state: {}, updatedAt: Number.MAX_SAFE_INTEGER + 1 }],
      ["body array", [{ state: {}, updatedAt: 1 }]],
      ["malformed json", "{nope"],
      ["empty body", ""],
      ["oversized", oversized],
    ];
    const db = new FakeD1();
    for (const [label, body] of cases) {
      const res = await send(await putState(body), { stateDb: db });
      expect(res.status, label).toBe(400);
      expect(((await res.json()) as { code: string }).code, label).toBe("invalid_request");
    }
    expect(db.rows.size).toBe(0);
  });

  it("oversized_stream_to_put_state_is_cancelled_without_buffering_unbounded_bytes", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(8192).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = request("PUT", "/api/state", {
      cookie: await cookieFor(),
      headers: { "content-type": "application/json" },
      body: stream,
    });
    const db = new FakeD1();
    const res = await send(req, { stateDb: db });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
    expect(cancelled).toBe(true);
    // ReadableStream's default highWaterMark of 1 may pre-pull one chunk ahead of the cancel.
    expect(pulled).toBeLessThanOrEqual(MAX_STATE_BYTES + 2 * chunk.byteLength);
    expect(db.rows.size).toBe(0);
  });

  it("users_are_isolated_by_email", async () => {
    const db = new FakeD1();
    const env = testEnv({ ALLOWED_EMAILS: `${EMAIL},second@example.com` });
    const other = await cookieFor("second@example.com");
    await send(await putState({ state: { theme: "light" }, updatedAt: 1 }), { env, stateDb: db });
    await send(await putState({ state: { theme: "dark" }, updatedAt: 9 }, other), {
      env,
      stateDb: db,
    });

    const mine = await send(await getState(), { env, stateDb: db });
    expect(await mine.json()).toEqual({ enabled: true, state: { theme: "light" }, updatedAt: 1 });
    const theirs = await send(await getState(other), { env, stateDb: db });
    expect(await theirs.json()).toEqual({ enabled: true, state: { theme: "dark" }, updatedAt: 9 });
  });

  it("corrupt_stored_row_reads_as_no_state", async () => {
    const db = new FakeD1();
    db.rows.set(EMAIL, { state_json: '{"theme":"neon"}', updated_at: 3 });
    const res = await send(await getState(), { stateDb: db });
    expect(await res.json()).toEqual({ enabled: true, state: null, updatedAt: null });
  });

  it("database_failure_is_502_and_the_table_check_is_retried", async () => {
    const db = new FakeD1();
    db.failWith = "D1_ERROR: network";
    const res = await send(await getState(), { stateDb: db });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("upstream_error");

    db.failWith = undefined;
    const retry = await send(await getState(), { stateDb: db });
    expect(retry.status).toBe(200);
    expect(db.queries.filter((q) => q.startsWith("CREATE TABLE"))).toHaveLength(2);
  });
});
