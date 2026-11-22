// Moving files and folders: `PATCH /api/files/{id}` and `PATCH /api/folders/{id}` with a
// `parentId` (and optionally a `name`). Rename-only bodies keep the behavior of files/folders tests.

import { describe, expect, it } from "vite-plus/test";

import {
  FakeGoogle,
  json,
  on,
  request,
  send,
  signedInCookie,
  type Recorded,
  type Scripted,
} from "./support/harness.ts";

const NEW_ETAG = '"MTcwMDAwMDAwMDAwMQ"';
const V3 = "https://fake.test/drive/v3/files/";
const V2 = "https://fake.test/drive/v2/files/";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const CYCLE = "Cannot move a folder into itself or one of its subfolders.";

type R = readonly [method: string, fragment: string, answer: Scripted];

const fake = (routes: ReadonlyArray<R> = []): FakeGoogle =>
  new FakeGoogle(routes.map(([m, f, a]) => on(m, f, a, { contains: true })));

const meta = (id: string, name: string, mimeType: string, parents: ReadonlyArray<string>) => ({
  id,
  name,
  mimeType,
  modifiedTime: "2026-11-20T10:00:00.000Z",
  trashed: false,
  parents,
});

const folder = (id: string, name: string, parents: ReadonlyArray<string>) =>
  meta(id, name, FOLDER_MIME, parents);

const getMeta = (file: { id: string }): R => ["GET", `${V3}${file.id}?fields=`, json(200, file)];

/** The live children of `folderId`, as `files.list` answers them. */
const children = (folderId: string, files: ReadonlyArray<unknown>): R => [
  "GET",
  `q=%27${folderId}%27+in+parents`,
  json(200, { files }),
];

const patch = async (path: string, payload: unknown, google: FakeGoogle): Promise<Response> =>
  send(
    request("PATCH", path, {
      cookie: await signedInCookie(),
      headers: { "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    { google },
  );

const body = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

const patchCall = (google: FakeGoogle): Recorded | undefined =>
  google.calls.find((c) => c.method === "PATCH");

const v2Answer = (name: string) =>
  json(200, {
    id: "doc-1",
    title: name,
    mimeType: "text/markdown",
    modifiedDate: "2026-11-21T09:00:00.000Z",
    etag: NEW_ETAG,
  });

const doc = meta("doc-1", "note.md", "text/markdown", ["folder-1"]);
const folder2 = folder("folder-2", "Archive", ["root-id"]);

describe("PATCH /api/files/{id} with parentId", () => {
  it("moves_the_file_with_add_and_remove_parents_and_returns_the_new_etag", async () => {
    const google = fake([
      getMeta(doc),
      getMeta(folder2),
      children("folder-2", [meta("doc-9", "other.md", "text/markdown", ["folder-2"])]),
      ["PATCH", `${V2}doc-1?`, v2Answer("note.md")],
    ]);
    const res = await patch("/api/files/doc-1", { parentId: "folder-2" }, google);

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(NEW_ETAG);
    expect(await body(res)).toEqual({
      id: "doc-1",
      name: "note.md",
      kind: "markdown",
      modifiedTime: "2026-11-21T09:00:00.000Z",
    });
    const call = patchCall(google)!;
    const url = new URL(call.url);
    expect(url.searchParams.get("addParents")).toBe("folder-2");
    expect(url.searchParams.get("removeParents")).toBe("folder-1");
    expect(url.searchParams.get("fields")).toBe("id,title,mimeType,modifiedDate,etag");
    expect(JSON.parse(call.text)).toEqual({});
    expect(google.unexpected).toEqual([]);
  });

  it("renames_and_moves_in_one_call", async () => {
    const google = fake([
      getMeta(doc),
      getMeta(folder2),
      children("folder-2", []),
      ["PATCH", `${V2}doc-1?`, v2Answer("moved.md")],
    ]);
    const res = await patch(
      "/api/files/doc-1",
      { name: "  moved.md ", parentId: "folder-2" },
      google,
    );

    expect(res.status).toBe(200);
    expect((await body(res))["name"]).toBe("moved.md");
    expect(JSON.parse(patchCall(google)!.text)).toEqual({ title: "moved.md" });
  });

  it("moves_into_the_root_folder_without_fetching_it", async () => {
    const google = fake([
      getMeta(doc),
      children("root-id", []),
      ["PATCH", `${V2}doc-1?`, v2Answer("note.md")],
    ]);
    const res = await patch("/api/files/doc-1", { parentId: "root-id" }, google);

    expect(res.status).toBe(200);
    expect(new URL(patchCall(google)!.url).searchParams.get("addParents")).toBe("root-id");
    expect(google.callsContaining(`${V3}root-id`)).toEqual([]);
  });

  it("renaming_inside_the_current_parent_keeps_its_parents", async () => {
    const folder1 = folder("folder-1", "Inbox", ["root-id"]);
    const google = fake([
      getMeta(doc),
      getMeta(folder1),
      children("folder-1", [doc]),
      ["PATCH", `${V2}doc-1?`, v2Answer("renamed.md")],
    ]);
    const res = await patch(
      "/api/files/doc-1",
      { parentId: "folder-1", name: "renamed.md" },
      google,
    );

    expect(res.status).toBe(200);
    const url = new URL(patchCall(google)!.url);
    expect(url.searchParams.has("addParents")).toBe(false);
    expect(url.searchParams.has("removeParents")).toBe(false);
  });

  it("same_parent_and_name_is_a_no_op_without_patch", async () => {
    const folder1 = folder("folder-1", "Inbox", ["root-id"]);
    const google = fake([getMeta(doc), getMeta(folder1)]);
    const res = await patch("/api/files/doc-1", { parentId: "folder-1" }, google);

    expect(res.status).toBe(200);
    expect((await body(res))["name"]).toBe("note.md");
    expect(patchCall(google)).toBeUndefined();
  });

  it("a_sibling_with_the_same_name_in_the_destination_is_409", async () => {
    const google = fake([
      getMeta(doc),
      getMeta(folder2),
      children("folder-2", [meta("doc-9", "note.md", "text/markdown", ["folder-2"])]),
    ]);
    const res = await patch("/api/files/doc-1", { parentId: "folder-2" }, google);

    expect(res.status).toBe(409);
    expect((await body(res))["code"]).toBe("name_exists");
    expect(patchCall(google)).toBeUndefined();
  });

  it("a_destination_outside_the_root_is_404", async () => {
    const google = fake([
      getMeta(doc),
      getMeta(folder("outside", "Elsewhere", ["other-root"])),
      getMeta(folder("other-root", "My Drive", [])),
    ]);
    const res = await patch("/api/files/doc-1", { parentId: "outside" }, google);

    expect(res.status).toBe(404);
    expect((await body(res))["code"]).toBe("not_found");
    expect(patchCall(google)).toBeUndefined();
  });

  it("a_destination_that_is_not_a_live_folder_is_404", async () => {
    for (const dest of [
      meta("folder-2", "a.md", "text/markdown", ["root-id"]),
      { ...folder2, trashed: true },
    ]) {
      const google = fake([getMeta(doc), getMeta(dest)]);
      const res = await patch("/api/files/doc-1", { parentId: "folder-2" }, google);
      expect(res.status).toBe(404);
      expect(patchCall(google)).toBeUndefined();
    }
  });

  it("a_badly_shaped_parent_id_is_404_without_calling_drive", async () => {
    const google = fake();
    const res = await patch("/api/files/doc-1", { parentId: "../x" }, google);
    expect(res.status).toBe(404);
    expect(google.calls).toHaveLength(0);
  });

  it("bad_bodies_are_400_without_calling_drive", async () => {
    for (const [label, payload, code] of [
      ["parentId not a string", { parentId: 7 }, "invalid_request"],
      ["name not a string", { parentId: "folder-2", name: 7 }, "invalid_request"],
      ["invalid name", { parentId: "folder-2", name: "a.txt" }, "invalid_name"],
      ["neither", {}, "invalid_request"],
    ] as const) {
      const google = fake();
      const res = await patch("/api/files/doc-1", payload, google);
      expect(res.status, label).toBe(400);
      expect((await body(res))["code"], label).toBe(code);
      expect(google.calls, label).toHaveLength(0);
    }
  });
});

describe("PATCH /api/folders/{id} with parentId", () => {
  const work = folder("folder-1", "Work", ["root-id"]);

  it("moves_the_folder_with_a_v3_patch_and_returns_its_node", async () => {
    const google = fake([
      getMeta(work),
      getMeta(folder2),
      children("folder-2", []),
      ["PATCH", `${V3}folder-1?`, json(200, folder("folder-1", "Work", ["folder-2"]))],
    ]);
    const res = await patch("/api/folders/folder-1", { parentId: "folder-2" }, google);

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      id: "folder-1",
      name: "Work",
      kind: "folder",
      modifiedTime: "2026-11-20T10:00:00.000Z",
    });
    const call = patchCall(google)!;
    const url = new URL(call.url);
    expect(url.searchParams.get("addParents")).toBe("folder-2");
    expect(url.searchParams.get("removeParents")).toBe("root-id");
    expect(url.searchParams.get("fields")).toBe("id,name,mimeType,modifiedTime,trashed,parents");
    expect(JSON.parse(call.text)).toEqual({});
  });

  it("renames_and_moves_a_folder_in_one_call", async () => {
    const google = fake([
      getMeta(work),
      getMeta(folder2),
      children("folder-2", [folder("folder-9", "Work", ["folder-2"])]),
      ["PATCH", `${V3}folder-1?`, json(200, folder("folder-1", "Work 2024", ["folder-2"]))],
    ]);
    const res = await patch(
      "/api/folders/folder-1",
      { parentId: "folder-2", name: "Work 2024" },
      google,
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(patchCall(google)!.text)).toEqual({ name: "Work 2024" });
  });

  it("moving_into_itself_or_a_descendant_is_400_invalid_move", async () => {
    const self = await patch(
      "/api/folders/folder-1",
      { parentId: "folder-1" },
      fake([getMeta(work)]),
    );
    expect(self.status).toBe(400);
    expect(await body(self)).toEqual({ code: "invalid_move", message: CYCLE });

    const google = fake([
      getMeta(work),
      getMeta(folder("folder-3", "Deep", ["folder-4"])),
      getMeta(folder("folder-4", "Sub", ["folder-1"])),
    ]);
    const res = await patch("/api/folders/folder-1", { parentId: "folder-3" }, google);
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ code: "invalid_move", message: CYCLE });
    expect(patchCall(google)).toBeUndefined();
  });

  it("moving_the_root_folder_is_400_invalid_move_without_calling_drive", async () => {
    const google = fake();
    const res = await patch("/api/folders/root-id", { parentId: "folder-2" }, google);
    expect(res.status).toBe(400);
    expect((await body(res))["code"]).toBe("invalid_move");
    expect(google.calls).toHaveLength(0);
  });

  it("a_name_collision_or_a_file_target_is_rejected", async () => {
    const taken = await patch(
      "/api/folders/folder-1",
      { parentId: "folder-2" },
      fake([
        getMeta(work),
        getMeta(folder2),
        children("folder-2", [meta("x", "Work", "text/plain", ["folder-2"])]),
      ]),
    );
    expect(taken.status).toBe(409);

    const notFolder = await patch(
      "/api/folders/doc-1",
      { parentId: "folder-2" },
      fake([getMeta(doc)]),
    );
    expect(notFolder.status).toBe(404);
  });

  it("an_invalid_folder_name_is_400", async () => {
    const google = fake();
    const res = await patch("/api/folders/folder-1", { parentId: "folder-2", name: ".." }, google);
    expect(res.status).toBe(400);
    expect((await body(res))["code"]).toBe("invalid_name");
    expect(google.calls).toHaveLength(0);
  });
});
