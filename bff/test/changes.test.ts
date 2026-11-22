// `GET /api/changes/start-token` and `GET /api/changes?pageToken=`: the Drive Changes API behind
// the session check, with bounded pagination and the expired-token answer the web app resets on.

import { describe, expect, it } from "vite-plus/test";

import {
  AT,
  FakeGoogle,
  get,
  json,
  on,
  send,
  signedInCookie,
  type Scripted,
} from "./support/harness.ts";

const START_URL = "https://fake.test/drive/v3/changes/startPageToken";
const CHANGES_URL = "https://fake.test/drive/v3/changes?";
const FOLDER_MIME = "application/vnd.google-apps.folder";

type R = readonly [method: string, fragment: string, answer: Scripted];

const fake = (routes: ReadonlyArray<R> = []): FakeGoogle =>
  new FakeGoogle(routes.map(([m, f, a]) => on(m, f, a, { contains: true })));

const getAsSignedIn = async (path: string, google: FakeGoogle): Promise<Response> =>
  send(get(path, { cookie: await signedInCookie() }), { google });

const body = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

const driveFile = (id: string, name: string, mimeType: string, trashed = false) => ({
  id,
  name,
  mimeType,
  modifiedTime: "2026-11-20T10:00:00.000Z",
  trashed,
  parents: ["folder-1"],
});

const change = (fileId: string, file?: unknown, removed = false) => ({
  fileId,
  removed,
  time: "2026-11-20T10:00:01.000Z",
  ...(file === undefined ? {} : { file }),
});

/** A changes page answered for `pageToken=<token>&`. */
const page = (token: string, answer: Record<string, unknown>): R => [
  "GET",
  `changes?pageToken=${token}&`,
  json(200, answer),
];

describe("GET /api/changes/start-token", () => {
  it("returns_drive_start_page_token", async () => {
    const google = fake([["GET", START_URL, json(200, { startPageToken: "4242" })]]);
    const res = await getAsSignedIn("/api/changes/start-token", google);

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ startPageToken: "4242" });
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.headers.get("authorization")).toBe(`Bearer ${AT}`);
  });

  it("without_session_is_401_and_calls_nothing", async () => {
    const google = fake();
    const res = await send(get("/api/changes/start-token"), { google });
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it("garbage_drive_answer_is_502", async () => {
    const google = fake([["GET", START_URL, json(200, { nope: 1 })]]);
    const res = await getAsSignedIn("/api/changes/start-token", google);
    expect(res.status).toBe(502);
    expect((await body(res))["code"]).toBe("upstream_error");
  });
});

describe("GET /api/changes", () => {
  it("maps_one_page_of_changes_and_returns_new_start_token", async () => {
    const google = fake([
      page("100", {
        newStartPageToken: "101",
        changes: [
          change("doc-1", driveFile("doc-1", "note.md", "text/markdown")),
          change("dir-1", driveFile("dir-1", "Work", FOLDER_MIME)),
          change("gone-1", undefined, true),
          change("trash-1", driveFile("trash-1", "old.md", "text/markdown", true)),
          change("pdf-1", driveFile("pdf-1", "a.pdf", "application/pdf")),
        ],
      }),
    ]);
    const res = await getAsSignedIn("/api/changes?pageToken=100", google);

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      nextPageToken: "101",
      hasMore: false,
      changes: [
        {
          fileId: "doc-1",
          removed: false,
          time: "2026-11-20T10:00:01.000Z",
          node: {
            id: "doc-1",
            name: "note.md",
            kind: "markdown",
            modifiedTime: "2026-11-20T10:00:00.000Z",
          },
          parentIds: ["folder-1"],
        },
        {
          fileId: "dir-1",
          removed: false,
          time: "2026-11-20T10:00:01.000Z",
          node: {
            id: "dir-1",
            name: "Work",
            kind: "folder",
            modifiedTime: "2026-11-20T10:00:00.000Z",
          },
          parentIds: ["folder-1"],
        },
        { fileId: "gone-1", removed: true, time: "2026-11-20T10:00:01.000Z", parentIds: [] },
        {
          fileId: "trash-1",
          removed: true,
          time: "2026-11-20T10:00:01.000Z",
          parentIds: ["folder-1"],
        },
        {
          fileId: "pdf-1",
          removed: false,
          time: "2026-11-20T10:00:01.000Z",
          node: {
            id: "pdf-1",
            name: "a.pdf",
            kind: "other",
            modifiedTime: "2026-11-20T10:00:00.000Z",
          },
          parentIds: ["folder-1"],
        },
      ],
    });
    const url = new URL(google.calls[0]!.url);
    expect(url.searchParams.get("pageToken")).toBe("100");
    expect(url.searchParams.get("includeRemoved")).toBe("true");
    expect(url.searchParams.get("spaces")).toBe("drive");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(url.searchParams.get("fields")).toBe(
      "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,trashed,parents))",
    );
  });

  it("follows_next_page_tokens_until_the_end", async () => {
    const google = fake([
      page("1", { nextPageToken: "2", changes: [change("a", undefined, true)] }),
      page("2", { nextPageToken: "3", changes: [change("b", undefined, true)] }),
      page("3", { newStartPageToken: "9", changes: [change("c", undefined, true)] }),
    ]);
    const res = await getAsSignedIn("/api/changes?pageToken=1", google);
    const out = await body(res);

    expect(res.status).toBe(200);
    expect(out["nextPageToken"]).toBe("9");
    expect(out["hasMore"]).toBe(false);
    expect((out["changes"] as Array<{ fileId: string }>).map((c) => c.fileId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("stops_after_five_pages_with_has_more", async () => {
    const routes = [1, 2, 3, 4, 5, 6].map((n) =>
      page(String(n), {
        nextPageToken: String(n + 1),
        changes: [change(`f${n}`, undefined, true)],
      }),
    );
    const google = fake(routes);
    const res = await getAsSignedIn("/api/changes?pageToken=1", google);
    const out = await body(res);

    expect(res.status).toBe(200);
    expect(out["hasMore"]).toBe(true);
    expect(out["nextPageToken"]).toBe("6");
    expect(out["changes"]).toHaveLength(5);
    expect(google.calls).toHaveLength(5);
  });

  it("skips_changes_without_a_file_id", async () => {
    const google = fake([
      page("7", {
        newStartPageToken: "8",
        changes: [
          { removed: false, time: "2026-11-20T10:00:01.000Z" },
          change("x", undefined, true),
        ],
      }),
    ]);
    const out = await body(await getAsSignedIn("/api/changes?pageToken=7", google));
    expect((out["changes"] as Array<{ fileId: string }>).map((c) => c.fileId)).toEqual(["x"]);
  });

  it("missing_or_unsafe_page_token_is_400_without_calling_drive", async () => {
    for (const path of [
      "/api/changes",
      "/api/changes?pageToken=",
      "/api/changes?pageToken=a%26b",
      "/api/changes?pageToken=a%20b",
      `/api/changes?pageToken=${"9".repeat(600)}`,
    ]) {
      const google = fake();
      const res = await getAsSignedIn(path, google);
      expect(res.status, path).toBe(400);
      expect((await body(res))["code"], path).toBe("invalid_request");
      expect(google.calls, path).toHaveLength(0);
    }
  });

  it("drive_410_or_400_is_410_token_expired", async () => {
    for (const status of [410, 400]) {
      const google = fake([["GET", CHANGES_URL, json(status, { error: { code: status } })]]);
      const res = await getAsSignedIn("/api/changes?pageToken=5", google);
      expect(res.status, String(status)).toBe(410);
      expect(await body(res), String(status)).toEqual({
        code: "token_expired",
        message: "The change token expired. Reload the folder tree.",
      });
    }
  });

  it("drive_rate_limit_is_429_with_retry_after", async () => {
    const google = fake([["GET", CHANGES_URL, json(429, {}, { "retry-after": "11" })]]);
    const res = await getAsSignedIn("/api/changes?pageToken=5", google);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("11");
    expect((await body(res))["code"]).toBe("rate_limited");
  });

  it("drive_401_is_session_ended_and_5xx_or_garbage_is_502", async () => {
    const ended = await getAsSignedIn(
      "/api/changes?pageToken=5",
      fake([["GET", CHANGES_URL, json(401, {})]]),
    );
    expect(ended.status).toBe(401);
    expect((await body(ended))["reason"]).toBe("session_ended");

    for (const answer of [
      json(503, {}),
      json(200, { changes: "nope" }),
      json(200, { changes: [] }),
    ]) {
      const res = await getAsSignedIn(
        "/api/changes?pageToken=5",
        fake([["GET", CHANGES_URL, answer]]),
      );
      expect(res.status).toBe(502);
      expect((await body(res))["code"]).toBe("upstream_error");
    }
  });
});
