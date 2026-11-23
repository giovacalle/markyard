// Per-account vaults: each account picks its own Drive vault root (`PUT /api/vault/root`),
// browses its Drive to find one (`GET`/`POST /api/drive/folders`), and every vault route then
// works under that root (stored in the sealed session cookie and optionally synced via D1).

import { describe, expect, it } from "vite-plus/test";

import { FakeD1 } from "./support/fake-d1.ts";
import {
  EMAIL,
  FakeGoogle,
  get,
  json,
  KEYS_1,
  NOW,
  on,
  request,
  send,
  sessionCookieOf,
  signedInCookie,
  storedSession,
  testEnv,
  unsealWith,
  type Route,
} from "./support/harness.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const MODIFIED = "2026-11-20T10:00:00.000Z";
const FILES = "https://fake.test/drive/v3/files";
const OTHER = "second@example.com";

const folder = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  modifiedTime: MODIFIED,
  trashed: false,
  parents: ["root"],
  ...extra,
});
const node = (id: string, name: string) => ({ id, name, kind: "folder", modifiedTime: MODIFIED });

/** `files.get` of one id. */
const getsFile = (id: string, body: unknown, status = 200): Route =>
  on("GET", `${FILES}/${id}?`, json(status, body));
/** `files.list` of the children of one folder. */
const lists = (parent: string, files: ReadonlyArray<unknown>): Route =>
  on("GET", `q=%27${parent}%27+in+parents`, json(200, { files }), { contains: true });

const cookieFor = (rootFolderId?: string, email: string = EMAIL) =>
  signedInCookie({ ...storedSession(NOW + 3600), email, rootFolderId });

const putRoot = async (folderId: unknown, cookie?: string): Promise<Request> =>
  request("PUT", "/api/vault/root", {
    cookie: cookie ?? (await cookieFor()),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderId }),
  });

const postFolder = async (body: unknown): Promise<Request> =>
  request("POST", "/api/drive/folders", {
    cookie: await cookieFor(),
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const sealedOf = async (res: Response) => unsealWith(KEYS_1, sessionCookieOf(res)!.value);

describe("GET /api/session vault setup", () => {
  it("asks_for_vault_setup_without_a_session_root", async () => {
    const res = await send(get("/api/session", { cookie: await cookieFor() }));
    expect(await res.json()).toEqual({ email: EMAIL, needsVaultSetup: true });
  });

  it("ignores_legacy_root_folder_id_env_var", async () => {
    const env = testEnv({ ROOT_FOLDER_ID: "legacy-root" });
    const sessionRes = await send(get("/api/session", { cookie: await cookieFor() }), { env });
    expect(await sessionRes.json()).toEqual({ email: EMAIL, needsVaultSetup: true });

    const rootRes = await send(get("/api/root", { cookie: await cookieFor() }), { env });
    expect(rootRes.status).toBe(400);
    expect(await rootRes.json()).toEqual({
      code: "vault_not_configured",
      message: "No Google Drive vault folder is selected yet.",
    });
  });

  it("an_own_root_needs_no_setup_and_rewrites_no_cookie", async () => {
    const res = await send(get("/api/session", { cookie: await cookieFor("vault-1") }));
    expect(await res.json()).toEqual({ email: EMAIL });
    expect(sessionCookieOf(res)).toBeUndefined();
  });

  it("adopts_the_root_synced_from_another_device", async () => {
    const db = new FakeD1();
    db.rows.set(EMAIL, { state_json: '{"rootFolderId":"vault-2"}', updated_at: 5 });
    const res = await send(get("/api/session", { cookie: await cookieFor() }), {
      stateDb: db,
    });
    expect(await res.json()).toEqual({ email: EMAIL, cloudSync: true });
    expect(await sealedOf(res)).toEqual({
      ...storedSession(NOW + 3600),
      rootFolderId: "vault-2",
    });
  });

  it("keeps_the_cookie_when_the_synced_root_matches_or_is_null", async () => {
    for (const [stored, own] of [
      ["vault-2", "vault-2"],
      [null, "vault-1"],
    ] as const) {
      const db = new FakeD1();
      db.rows.set(EMAIL, { state_json: JSON.stringify({ rootFolderId: stored }), updated_at: 5 });
      const res = await send(get("/api/session", { cookie: await cookieFor(own) }), {
        stateDb: db,
      });
      expect(await res.json()).toEqual({ email: EMAIL, cloudSync: true });
      expect(sessionCookieOf(res)).toBeUndefined();
    }
  });
});

describe("vault routes without a root", () => {
  it("answer_400_vault_not_configured", async () => {
    const google = new FakeGoogle();
    for (const path of [
      "/api/root",
      "/api/vault/index",
      "/api/search?q=hello",
      "/api/attachments",
    ]) {
      const res = await send(get(path, { cookie: await cookieFor() }), { google });
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({
        code: "vault_not_configured",
        message: "No Google Drive vault folder is selected yet.",
      });
    }
    expect(google.calls).toEqual([]);
  });

  it("still_require_a_session_first", async () => {
    const res = await send(get("/api/root"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/drive/folders", () => {
  it("lists_my_drive_folders_sorted_case_insensitively", async () => {
    const google = new FakeGoogle([
      lists("root", [folder("f-b", "beta"), folder("f-a", "Alpha"), folder("f-c", "Gamma")]),
    ]);
    const res = await send(get("/api/drive/folders", { cookie: await cookieFor() }), { google });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      parent: { id: "root", name: "My Drive" },
      folders: [node("f-a", "Alpha"), node("f-b", "beta"), node("f-c", "Gamma")],
    });
    const q = new URL(google.calls[0]!.url).searchParams.get("q");
    expect(q).toBe(`'root' in parents and trashed=false and mimeType='${FOLDER_MIME}'`);
    expect(google.unexpected).toEqual([]);
  });

  it("lists_a_nested_folder", async () => {
    const google = new FakeGoogle([
      getsFile("f-a", folder("f-a", "Alpha")),
      lists("f-a", [folder("f-x", "Notes")]),
    ]);
    const res = await send(get("/api/drive/folders?parentId=f-a", { cookie: await cookieFor() }), {
      google,
    });
    expect(await res.json()).toEqual({
      parent: { id: "f-a", name: "Alpha" },
      folders: [node("f-x", "Notes")],
    });
  });

  it("works_without_any_vault_root", async () => {
    const google = new FakeGoogle([lists("root", [])]);
    const res = await send(get("/api/drive/folders", { cookie: await cookieFor() }), { google });
    expect(res.status).toBe(200);
  });

  it("invalid_missing_trashed_or_non_folder_parent_is_404", async () => {
    const cases: Array<[string, Array<Route>]> = [
      ["a%27b", []],
      ["gone", [getsFile("gone", { error: { code: 404 } }, 404)]],
      ["trashed", [getsFile("trashed", folder("trashed", "T", { trashed: true }))]],
      ["doc", [getsFile("doc", folder("doc", "D", { mimeType: "text/markdown" }))]],
    ];
    for (const [id, routes] of cases) {
      const google = new FakeGoogle(routes);
      const res = await send(
        get(`/api/drive/folders?parentId=${id}`, { cookie: await cookieFor() }),
        { google },
      );
      expect(res.status, id).toBe(404);
      expect(google.unexpected, id).toEqual([]);
    }
  });

  it("is_401_without_a_session", async () => {
    const google = new FakeGoogle();
    const res = await send(get("/api/drive/folders"), { google });
    expect(res.status).toBe(401);
    expect(google.calls).toEqual([]);
  });
});

describe("POST /api/drive/folders", () => {
  const created = (id: string, name: string): Route =>
    on("POST", `${FILES}?`, json(200, folder(id, name)));

  it("creates_in_my_drive_by_default", async () => {
    const google = new FakeGoogle([lists("root", []), created("new-1", "Vault")]);
    const res = await send(await postFolder({ name: "  Vault " }), { google });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(node("new-1", "Vault"));
    const post = google.callsTo("POST", FILES)[0]!;
    expect(JSON.parse(post.text)).toEqual({
      name: "Vault",
      mimeType: FOLDER_MIME,
      parents: ["root"],
    });
  });

  it("creates_in_a_subfolder", async () => {
    const google = new FakeGoogle([
      getsFile("f-a", folder("f-a", "Alpha")),
      lists("f-a", [folder("f-x", "Other")]),
      created("new-2", "Vault"),
    ]);
    const res = await send(await postFolder({ parentId: "f-a", name: "Vault" }), { google });
    expect(res.status).toBe(201);
    expect(JSON.parse(google.callsTo("POST", FILES)[0]!.text).parents).toEqual(["f-a"]);
  });

  it("duplicate_name_is_409", async () => {
    const google = new FakeGoogle([lists("root", [folder("f-v", "Vault")])]);
    const res = await send(await postFolder({ name: "Vault" }), { google });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("name_exists");
    expect(google.callsTo("POST", FILES)).toEqual([]);
  });

  it("bad_name_or_body_is_400_without_drive", async () => {
    for (const body of [
      { name: "" },
      { name: "a/b" },
      { name: ".." },
      { title: "x" },
      "{nope",
      { name: "ok", parentId: 3 },
    ]) {
      const google = new FakeGoogle();
      const res = await send(await postFolder(body), { google });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(google.calls, JSON.stringify(body)).toEqual([]);
    }
  });

  it("invalid_parent_is_404", async () => {
    const res = await send(await postFolder({ parentId: "../x", name: "Vault" }));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/vault/root", () => {
  it("switches_the_root_in_the_cookie_and_the_synced_state", async () => {
    const db = new FakeD1();
    db.rows.set(EMAIL, { state_json: '{"theme":"dark"}', updated_at: NOW * 1000 + 50 });
    const google = new FakeGoogle([getsFile("vault-1", folder("vault-1", "Vault"))]);
    const res = await send(await putRoot("vault-1"), { google, stateDb: db });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ root: node("vault-1", "Vault") });
    expect(await sealedOf(res)).toEqual({ ...storedSession(NOW + 3600), rootFolderId: "vault-1" });
    expect(db.rows.get(EMAIL)).toEqual({
      state_json: '{"theme":"dark","rootFolderId":"vault-1"}',
      updated_at: NOW * 1000 + 51,
    });
  });

  it("uses_the_clock_when_it_is_newer_than_the_stored_state", async () => {
    const db = new FakeD1();
    const google = new FakeGoogle([getsFile("vault-1", folder("vault-1", "Vault"))]);
    await send(await putRoot("vault-1"), { google, stateDb: db });
    expect(db.rows.get(EMAIL)?.updated_at).toBe(NOW * 1000);
  });

  it("then_root_and_vault_index_use_the_chosen_root", async () => {
    const google = new FakeGoogle([getsFile("vault-1", folder("vault-1", "Vault"))]);
    const switched = await send(await putRoot("vault-1"), { google });
    const cookie = `__Host-s=${sessionCookieOf(switched)!.value}`;

    const rootRes = await send(get("/api/root", { cookie }), { google });
    expect(await rootRes.json()).toEqual(node("vault-1", "Vault"));

    const indexGoogle = new FakeGoogle([lists("vault-1", [])]);
    const index = await send(get("/api/vault/index", { cookie }), {
      google: indexGoogle,
    });
    expect(((await index.json()) as { rootId: string }).rootId).toBe("vault-1");
    expect(indexGoogle.unexpected).toEqual([]);
  });

  it("missing_trashed_or_non_folder_is_404_and_changes_nothing", async () => {
    const cases: Array<[string, Route]> = [
      ["gone", getsFile("gone", { error: { code: 404 } }, 404)],
      ["trashed", getsFile("trashed", folder("trashed", "T", { trashed: true }))],
      ["doc", getsFile("doc", folder("doc", "D", { mimeType: "text/markdown" }))],
    ];
    for (const [id, route] of cases) {
      const db = new FakeD1();
      const res = await send(await putRoot(id), { google: new FakeGoogle([route]), stateDb: db });
      expect(res.status, id).toBe(404);
      expect(sessionCookieOf(res), id).toBeUndefined();
      expect(db.rows.size, id).toBe(0);
    }
  });

  it("bad_body_is_400_without_drive", async () => {
    for (const id of ["../x", "", 42, null]) {
      const google = new FakeGoogle();
      const res = await send(await putRoot(id), { google });
      expect(res.status, String(id)).toBe(400);
      expect(google.calls).toEqual([]);
    }
  });

  it("is_401_without_a_session", async () => {
    const res = await send(
      request("PUT", "/api/vault/root", { body: JSON.stringify({ folderId: "vault-1" }) }),
    );
    expect(res.status).toBe(401);
  });
});

describe("account isolation", () => {
  it("two_accounts_with_different_roots_stay_apart", async () => {
    const env = testEnv({ ALLOWED_EMAILS: `${EMAIL},${OTHER}` });
    const mine = await cookieFor("vault-a");
    const theirs = await cookieFor("vault-b", OTHER);
    const google = new FakeGoogle([lists("vault-a", []), lists("vault-b", [])]);

    const a = await send(get("/api/vault/index", { cookie: mine }), { google, env });
    const b = await send(get("/api/vault/index", { cookie: theirs }), { google, env });
    expect(((await a.json()) as { rootId: string }).rootId).toBe("vault-a");
    expect(((await b.json()) as { rootId: string }).rootId).toBe("vault-b");
  });

  it("a_blob_outside_the_accounts_root_is_404", async () => {
    // The image sits in vault-b; the account's root is vault-a.
    const google = new FakeGoogle([
      on(
        "GET",
        `${FILES}/img-1?`,
        json(200, {
          id: "img-1",
          mimeType: "image/png",
          size: "10",
          trashed: false,
          parents: ["vault-b"],
        }),
      ),
      getsFile("vault-b", folder("vault-b", "B", { parents: ["root-real"] })),
      getsFile("root-real", folder("root-real", "My Drive", { parents: [] })),
    ]);
    const res = await send(get("/api/files/img-1/blob", { cookie: await cookieFor("vault-a") }), {
      google,
    });
    expect(res.status).toBe(404);
    expect(google.callsContaining("alt=media")).toEqual([]);
  });

  it("a_synced_root_is_per_account", async () => {
    const db = new FakeD1();
    db.rows.set(EMAIL, { state_json: '{"rootFolderId":"vault-a"}', updated_at: 1 });
    const env = testEnv({ ALLOWED_EMAILS: `${EMAIL},${OTHER}` });
    const res = await send(get("/api/session", { cookie: await cookieFor(undefined, OTHER) }), {
      env,
      stateDb: db,
    });
    expect(await res.json()).toEqual({ email: OTHER, cloudSync: true, needsVaultSetup: true });
    expect(sessionCookieOf(res)).toBeUndefined();
  });
});
