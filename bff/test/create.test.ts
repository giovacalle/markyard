// Port of the Rust `core/tests/create.rs` tests (`POST /api/folders/{id}/files`).

import { describe, expect, it } from "vite-plus/test";

import {
  AT,
  CLEAR_SESSION,
  FakeGoogle,
  json,
  NEW_AT,
  NOW,
  on,
  request,
  send,
  setCookies,
  signedInCookie,
  storedSession,
  type Recorded,
  type Route,
  type Scripted,
} from "./support/harness.ts";

const ETAG = '"MTcwMDAwMDAwMDAwMA"';
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_V3_FILES = "https://fake.test/drive/v3/files";
const UPLOAD_V2_FILES = "https://fake.test/upload/drive/v2/files";
const TOKEN_URL = "https://fake.test/token";
const MULTIPART_PREFIX = "multipart/related; boundary=";

/** Rust `Fake` routes: the first whose method matches and whose fragment the URL contains. */
const fake = (routes: ReadonlyArray<[string, string, Scripted]>): FakeGoogle =>
  new FakeGoogle(
    routes.map(([method, fragment, answer]): Route =>
      on(method, fragment, answer, { contains: true }),
    ),
  );

/** Rust `post(path, cookie, origin, body)` with `content-type: application/json`. */
const post = (
  path: string,
  cookie: string | undefined,
  origin: string | undefined,
  body: string,
): Request =>
  request("POST", path, {
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : { origin }),
    },
    ...(cookie === undefined ? {} : { cookie }),
    sameOrigin: false,
    body,
  });

const ORIGIN = "https://notes.test";

const expiredCookie = () => signedInCookie({ ...storedSession(NOW - 10), rootFolderId: "root-id" });

const liveFolder = (id: string): Scripted =>
  json(200, {
    id,
    name: "Notes",
    mimeType: FOLDER_MIME,
    modifiedTime: "2026-11-01T10:00:00.000Z",
    trashed: false,
  });

const emptyListing = (): Scripted => json(200, { files: [] });

const insertedFile = (id: string, title: string, etag: string): Scripted =>
  json(200, {
    id,
    title,
    mimeType: "text/markdown",
    modifiedDate: "2026-11-20T12:00:00.000Z",
    etag,
  });

/** The folder check, an empty listing, and the insert answering `inserted`. */
const happyRoutes = (inserted: Scripted): Array<[string, string, Scripted]> => [
  ["GET", `${DRIVE_V3_FILES}/folder-1?`, liveFolder("folder-1")],
  ["GET", `${DRIVE_V3_FILES}?`, emptyListing()],
  ["POST", UPLOAD_V2_FILES, inserted],
];

const boundaryOf = (call: Recorded): string => {
  const ct = call.headers.get("content-type");
  expect(ct?.startsWith(MULTIPART_PREFIX)).toBe(true);
  return ct!.slice(MULTIPART_PREFIX.length);
};

const uploadCall = (google: FakeGoogle): Recorded => {
  const upload = google.calls.find((c) => c.method === "POST" && c.url.includes(UPLOAD_V2_FILES));
  expect(upload).toBeDefined();
  return upload!;
};

describe("create", () => {
  it("create_uploads_multipart_markdown_and_returns_201_node_and_etag", async () => {
    const google = fake(happyRoutes(insertedFile("new-1", "ideas.md", ETAG)));
    const body = JSON.stringify({
      name: "  ideas.md  ",
      content: "---\r\ntitle: Ideas\r\n---\r\n# Hello\r\n",
    });

    const res = await send(
      post("/api/folders/folder-1/files", await signedInCookie(), ORIGIN, body),
      { google },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(await res.json()).toEqual({
      id: "new-1",
      name: "ideas.md",
      kind: "markdown",
      modifiedTime: "2026-11-20T12:00:00.000Z",
    });

    const upload = uploadCall(google);
    expect(upload.headers.get("authorization")).toBe(`Bearer ${AT}`);
    expect(upload.url).toContain("uploadType=multipart");
    expect(upload.url).toContain("fields=id,title,mimeType,modifiedDate,etag");

    const boundary = boundaryOf(upload);
    const raw = upload.text;
    expect(
      raw.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    ).toBe(true);
    expect(raw).toContain('"title":"ideas.md"');
    expect(raw).toContain('"mimeType":"text/markdown"');
    expect(raw).toContain('"parents":[{"id":"folder-1"}]');
    expect(raw).toContain(
      `\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n---\r\ntitle: Ideas\r\n---\r\n# Hello\r\n\r\n--${boundary}--\r\n`,
    );
  });

  it("create_omitting_content_uploads_empty_markdown_file", async () => {
    const google = fake(happyRoutes(insertedFile("new-2", "blank.md", ETAG)));

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await signedInCookie(),
        ORIGIN,
        JSON.stringify({ name: "blank.md" }),
      ),
      { google },
    );

    expect(res.status).toBe(201);
    const upload = google.calls.find((c) => c.method === "POST")!;
    const boundary = boundaryOf(upload);
    expect(
      upload.text.endsWith(
        `\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n\r\n--${boundary}--\r\n`,
      ),
    ).toBe(true);
  });

  it("create_picks_boundary_not_present_in_content", async () => {
    const google = fake(happyRoutes(insertedFile("new-3", "tricky.md", ETAG)));
    const content = "contains markyard-7f3c9a1e5b2d4086-0 inside body";

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await signedInCookie(),
        ORIGIN,
        JSON.stringify({ name: "tricky.md", content }),
      ),
      { google },
    );

    expect(res.status).toBe(201);
    const boundary = boundaryOf(google.calls.find((c) => c.method === "POST")!);
    expect(boundary).not.toBe("markyard-7f3c9a1e5b2d4086-0");
    expect(content.includes(boundary)).toBe(false);
  });

  it("create_from_foreign_origin_is_403_without_upstream", async () => {
    const google = new FakeGoogle();

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await signedInCookie(),
        "https://evil.test",
        JSON.stringify({ name: "a.md" }),
      ),
      { google },
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("forbidden");
    expect(google.calls).toEqual([]);
  });

  it("create_without_session_is_401_without_upstream", async () => {
    const google = new FakeGoogle();

    const res = await send(
      post("/api/folders/folder-1/files", undefined, ORIGIN, JSON.stringify({ name: "a.md" })),
      { google },
    );

    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("unauthenticated");
    expect(google.calls).toEqual([]);
  });

  it("create_rejects_invalid_folder_id_and_bad_body_and_invalid_names_without_upstream", async () => {
    const cookie = await signedInCookie();

    for (const badPath of [
      "/api/folders//files",
      "/api/folders/bad'id/files",
      "/api/folders/a%20b/files",
    ]) {
      const google = new FakeGoogle();
      const res = await send(post(badPath, cookie, ORIGIN, JSON.stringify({ name: "a.md" })), {
        google,
      });
      expect(res.status, `path ${badPath}`).toBe(404);
      expect(google.calls).toEqual([]);
    }

    {
      const google = new FakeGoogle();
      const res = await send(post("/api/folders/folder-1/files", cookie, ORIGIN, "not json"), {
        google,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("invalid_request");
      expect(google.calls).toEqual([]);
    }

    const tooLong = `${"a".repeat(253)}.md`;
    for (const badName of ["", "   ", ".md", "  .MD  ", "sub/note.md", "plain.txt", tooLong]) {
      const google = new FakeGoogle();
      const res = await send(
        post("/api/folders/folder-1/files", cookie, ORIGIN, JSON.stringify({ name: badName })),
        { google },
      );
      expect(res.status, `name ${JSON.stringify(badName)}`).toBe(400);
      expect(
        ((await res.json()) as Record<string, unknown>)["code"],
        `name ${JSON.stringify(badName)}`,
      ).toBe("invalid_name");
      expect(google.calls).toEqual([]);
    }
  });

  it("create_rejects_content_over_10_mb_without_upstream", async () => {
    const google = new FakeGoogle();
    const oversized = "x".repeat(10_000_001);

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await signedInCookie(),
        ORIGIN,
        JSON.stringify({ name: "big.md", content: oversized }),
      ),
      { google },
    );

    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("too_large");
    expect(google.calls).toEqual([]);
  });

  it("create_rejects_oversized_json_stream_before_buffering_unbounded_bytes", async () => {
    const google = new FakeGoogle();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(0x78));
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = request("POST", "/api/folders/folder-1/files", {
      cookie: await signedInCookie(),
      headers: {
        "content-type": "application/json",
        "content-length": String(50_000_000),
      },
      body: stream,
    });
    const res = await send(req, { google });
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("too_large");
    expect(cancelled).toBe(true);
    expect(google.calls).toEqual([]);
  });

  it("create_in_missing_non_folder_or_trashed_folder_is_404", async () => {
    const cookie = await signedInCookie();
    const cases: Array<Scripted> = [
      json(404, { error: { code: 404 } }),
      json(200, {
        id: "file-1",
        name: "doc.md",
        mimeType: "text/markdown",
        modifiedTime: "2026-11-01T10:00:00.000Z",
        trashed: false,
      }),
      json(200, {
        id: "trash-1",
        name: "Old",
        mimeType: FOLDER_MIME,
        modifiedTime: "2026-11-01T10:00:00.000Z",
        trashed: true,
      }),
    ];

    for (const answer of cases) {
      const google = fake([["GET", `${DRIVE_V3_FILES}/target?`, answer]]);
      const res = await send(
        post("/api/folders/target/files", cookie, ORIGIN, JSON.stringify({ name: "note.md" })),
        { google },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("not_found");
      expect(google.calls).toHaveLength(1);
    }
  });

  it("create_rejects_existing_name_across_paginated_listing_with_409_name_exists", async () => {
    const google = fake([
      ["GET", `${DRIVE_V3_FILES}/folder-1?`, liveFolder("folder-1")],
      [
        "GET",
        "pageToken=page-2",
        json(200, {
          files: [
            {
              id: "existing-2",
              name: "taken.md",
              mimeType: "text/markdown",
              modifiedTime: "2026-11-01T10:00:00.000Z",
            },
          ],
        }),
      ],
      [
        "GET",
        `${DRIVE_V3_FILES}?`,
        json(200, {
          nextPageToken: "page-2",
          files: [
            {
              id: "existing-1",
              name: "other.md",
              mimeType: "text/markdown",
              modifiedTime: "2026-11-01T10:00:00.000Z",
            },
          ],
        }),
      ],
    ]);

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await signedInCookie(),
        ORIGIN,
        JSON.stringify({ name: "taken.md" }),
      ),
      { google },
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("name_exists");
    expect(google.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("create_refreshes_expired_token_and_sets_cookie_on_201", async () => {
    const google = fake([
      ["POST", TOKEN_URL, json(200, { access_token: NEW_AT, expires_in: 3600 })],
      ...happyRoutes(insertedFile("new-4", "fresh.md", ETAG)),
    ]);

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await expiredCookie(),
        ORIGIN,
        JSON.stringify({ name: "fresh.md" }),
      ),
      { google },
    );

    expect(res.status).toBe(201);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.startsWith("__Host-s=")).toBe(true);
    expect(cookies[0]).not.toBe(CLEAR_SESSION);

    const upload = google.calls.find((c) => c.url.includes(UPLOAD_V2_FILES))!;
    expect(upload.headers.get("authorization")).toBe(`Bearer ${NEW_AT}`);
  });

  it("create_drive_401_after_refresh_ends_session_with_only_clear_cookie", async () => {
    const google = fake([
      ["POST", TOKEN_URL, json(200, { access_token: NEW_AT, expires_in: 3600 })],
      ...happyRoutes(json(401, {})),
    ]);

    const res = await send(
      post(
        "/api/folders/folder-1/files",
        await expiredCookie(),
        ORIGIN,
        JSON.stringify({ name: "a.md" }),
      ),
      { google },
    );

    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>)["reason"]).toBe("session_ended");
    expect(setCookies(res)).toEqual([CLEAR_SESSION]);
  });

  it("create_maps_rate_limit_and_upstream_errors", async () => {
    const cookie = await signedInCookie();

    const upRl = fake(happyRoutes(json(429, {}, { "Retry-After": "9" })));
    let res = await send(
      post("/api/folders/folder-1/files", cookie, ORIGIN, JSON.stringify({ name: "a.md" })),
      { google: upRl },
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBe("9");

    const upEmptyEtag = fake(happyRoutes(insertedFile("new-5", "a.md", "")));
    res = await send(
      post("/api/folders/folder-1/files", cookie, ORIGIN, JSON.stringify({ name: "a.md" })),
      { google: upEmptyEtag },
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("upstream_error");
  });
});
