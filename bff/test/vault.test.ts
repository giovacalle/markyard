// `GET /api/vault/index`: every live folder and Markdown file under the root folder, listed with
// bounded concurrency, cycle-safe, and capped.

import { describe, expect, it } from "vite-plus/test";

import { FakeGoogle, get, json, on, send, signedInCookie } from "./support/harness.ts";
import { MAX_INDEX_FILES, MAX_INDEX_FOLDERS } from "../src/application/vault.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";

const item = (id: string, name: string, mimeType: string) => ({
  id,
  name,
  mimeType,
  modifiedTime: "2026-11-20T10:00:00.000Z",
});
const dir = (id: string, name: string) => item(id, name, FOLDER_MIME);
const md = (id: string, name: string) => item(id, name, "text/markdown");

/** A fake answering `files.list` for each folder id in `tree`, and failing the test otherwise. */
const tree = (listing: Readonly<Record<string, ReadonlyArray<unknown>>>): FakeGoogle =>
  new FakeGoogle(
    Object.entries(listing).map(([id, files]) =>
      on("GET", `q=%27${id}%27+in+parents`, json(200, { files }), { contains: true }),
    ),
  );

const index = async (google: FakeGoogle): Promise<Response> =>
  send(get("/api/vault/index", { cookie: await signedInCookie() }), { google });

const body = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

describe("GET /api/vault/index", () => {
  it("lists_nested_folders_and_markdown_files_with_their_parents", async () => {
    const google = tree({
      "root-id": [
        dir("f-a", "Areas"),
        md("n-1", "Inbox.md"),
        item("p-1", "a.pdf", "application/pdf"),
      ],
      "f-a": [
        dir("f-b", "Health"),
        md("n-2", "Goals.MD"),
        item("g-1", "Doc.md", "application/vnd.google-apps.document"),
      ],
      "f-b": [md("n-3", "Run.md")],
    });
    const res = await index(google);

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      rootId: "root-id",
      folders: [
        { id: "f-a", name: "Areas", parentId: "root-id", modifiedTime: "2026-11-20T10:00:00.000Z" },
        { id: "f-b", name: "Health", parentId: "f-a", modifiedTime: "2026-11-20T10:00:00.000Z" },
      ],
      files: [
        {
          id: "n-1",
          name: "Inbox.md",
          parentId: "root-id",
          modifiedTime: "2026-11-20T10:00:00.000Z",
        },
        { id: "n-2", name: "Goals.MD", parentId: "f-a", modifiedTime: "2026-11-20T10:00:00.000Z" },
        { id: "n-3", name: "Run.md", parentId: "f-b", modifiedTime: "2026-11-20T10:00:00.000Z" },
      ],
      truncated: false,
    });
    expect(google.unexpected).toEqual([]);
    const q = new URL(google.calls[0]!.url).searchParams.get("q");
    expect(q).toBe("'root-id' in parents and trashed=false");
  });

  it("an_empty_root_is_an_empty_index", async () => {
    const res = await index(tree({ "root-id": [] }));
    expect(await body(res)).toEqual({
      rootId: "root-id",
      folders: [],
      files: [],
      truncated: false,
    });
  });

  it("is_safe_against_folder_cycles", async () => {
    const google = tree({
      "root-id": [dir("f-a", "A")],
      "f-a": [dir("f-b", "B"), dir("root-id", "Root again")],
      "f-b": [dir("f-a", "A again")],
    });
    const res = await index(google);
    const out = await body(res);

    expect(res.status).toBe(200);
    expect((out["folders"] as Array<{ id: string }>).map((f) => f.id)).toEqual(["f-a", "f-b"]);
    expect(google.calls).toHaveLength(3);
  });

  it("caps_folders_and_files_and_sets_truncated", async () => {
    const manyDirs = Array.from({ length: MAX_INDEX_FOLDERS + 3 }, (_, i) =>
      dir(`d-${i}`, `D${i}`),
    );
    const listing: Record<string, ReadonlyArray<unknown>> = { "root-id": manyDirs };
    for (let i = 0; i < MAX_INDEX_FOLDERS; i++) listing[`d-${i}`] = [];
    const folders = await body(await index(tree(listing)));
    expect(folders["folders"]).toHaveLength(MAX_INDEX_FOLDERS);
    expect(folders["truncated"]).toBe(true);

    const manyFiles = Array.from({ length: MAX_INDEX_FILES + 1 }, (_, i) =>
      md(`n-${i}`, `${i}.md`),
    );
    const files = await body(await index(tree({ "root-id": manyFiles })));
    expect(files["files"]).toHaveLength(MAX_INDEX_FILES);
    expect(files["truncated"]).toBe(true);
  });

  it("without_session_is_401_and_a_drive_failure_fails_the_index", async () => {
    const google = new FakeGoogle();
    expect((await send(get("/api/vault/index"), { google })).status).toBe(401);
    expect(google.calls).toHaveLength(0);

    const failing = new FakeGoogle([
      on("GET", "q=%27root-id%27", json(200, { files: [dir("f-a", "A")] }), { contains: true }),
      on("GET", "q=%27f-a%27", json(429, {}, { "retry-after": "3" }), { contains: true }),
    ]);
    const res = await index(failing);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
  });
});
