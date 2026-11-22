// Drive version history: `GET /api/files/{id}/revisions` (newest first, paged, decoded) and
// `GET /api/files/{id}/revisions/{revisionId}` (10 MB cap, Drive's body passed through unread).

import { describe, expect, it } from "vite-plus/test";

import { newestFirst, type Revision } from "../src/domain/revisions.ts";
import { CSP, NO_STORE_NO_TRANSFORM, NOSNIFF } from "../src/http/app.ts";
import {
  AT,
  CLEAR_SESSION,
  FakeGoogle,
  get,
  json,
  on,
  send,
  setCookies,
  signedInCookie,
  streamOf,
  unreachable,
  type Scripted,
} from "./support/harness.ts";

const V3 = "https://fake.test/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS =
  "nextPageToken,revisions(id,modifiedTime,size,lastModifyingUser(displayName,emailAddress),keepForever)";

type R = readonly [method: string, fragment: string, answer: Scripted, once?: boolean];

const fake = (routes: ReadonlyArray<R> = []): FakeGoogle =>
  new FakeGoogle(
    routes.map(([m, f, a, once]) => on(m, f, a, { contains: true, once: once === true })),
  );

const fileMeta = (id: string, mimeType = "text/markdown", trashed = false): R => [
  "GET",
  `${V3}/${id}?fields=id,name`,
  json(200, {
    id,
    name: "note.md",
    mimeType,
    modifiedTime: "2026-11-20T10:00:00.000Z",
    trashed,
    parents: ["root-id"],
  }),
];

const LIST = "/revisions?";

const jsonBody = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.clone().json()) as Record<string, unknown>;

const expectSecurityHeaders = (res: Response): void => {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("x-content-type-options")).toBe(NOSNIFF);
};

const getAsSignedIn = async (path: string, google: FakeGoogle): Promise<Response> =>
  send(get(path, { cookie: await signedInCookie() }), { google });

describe("newestFirst", () => {
  it("sorts_by_modified_time_descending_keeping_drive_order_on_ties", () => {
    const r = (id: string, modifiedTime: string): Revision => ({
      id,
      modifiedTime,
      keepForever: false,
    });
    expect(
      newestFirst([
        r("a", "2026-01-01T00:00:00.000Z"),
        r("b", "2026-03-01T00:00:00Z"),
        r("c", "2026-03-01T00:00:00.000Z"),
        r("d", "garbage"),
        r("e", "2026-02-01T00:00:00.000Z"),
      ]).map((x) => x.id),
    ).toEqual(["b", "c", "e", "a", "d"]);
  });
});

describe("GET /api/files/{id}/revisions", () => {
  it("lists_revisions_newest_first_with_size_author_and_keep_forever", async () => {
    const google = fake([
      fileMeta("doc-1"),
      [
        "GET",
        LIST,
        json(200, {
          revisions: [
            {
              id: "rev-1",
              modifiedTime: "2026-11-01T09:00:00.000Z",
              size: "120",
              lastModifyingUser: { displayName: "Giova", emailAddress: "g@example.test" },
              keepForever: true,
            },
            {
              id: "rev-3",
              modifiedTime: "2026-11-20T09:00:00.000Z",
              size: "180",
              lastModifyingUser: { emailAddress: "g@example.test" },
            },
            { id: "rev-2", modifiedTime: "2026-11-10T09:00:00.000Z", keepForever: false },
          ],
        }),
      ],
    ]);
    const res = await getAsSignedIn("/api/files/doc-1/revisions", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe(NO_STORE_NO_TRANSFORM);
    expectSecurityHeaders(res);
    expect(await res.text()).toBe(
      JSON.stringify({
        revisions: [
          {
            id: "rev-3",
            modifiedTime: "2026-11-20T09:00:00.000Z",
            size: 180,
            author: "g@example.test",
            keepForever: false,
          },
          { id: "rev-2", modifiedTime: "2026-11-10T09:00:00.000Z", keepForever: false },
          {
            id: "rev-1",
            modifiedTime: "2026-11-01T09:00:00.000Z",
            size: 120,
            author: "Giova",
            keepForever: true,
          },
        ],
      }),
    );

    const list = google.calls[1]!;
    const url = new URL(list.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${V3}/doc-1/revisions`);
    expect(url.searchParams.get("fields")).toBe(FIELDS);
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect(list.headers.get("authorization")).toBe(`Bearer ${AT}`);
  });

  it("follows_next_page_tokens_and_sorts_across_pages", async () => {
    const google = fake([
      fileMeta("doc-1"),
      [
        "GET",
        `${LIST}fields`,
        json(200, {
          nextPageToken: "page-2",
          revisions: [{ id: "old", modifiedTime: "2026-01-01T00:00:00.000Z" }],
        }),
        true,
      ],
      [
        "GET",
        "pageToken=page-2",
        json(200, { revisions: [{ id: "new", modifiedTime: "2026-06-01T00:00:00.000Z" }] }),
      ],
    ]);
    const res = await getAsSignedIn("/api/files/doc-1/revisions", google);
    expect(res.status).toBe(200);
    expect(((await jsonBody(res))["revisions"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "new",
      "old",
    ]);
    expect(google.callsContaining("/revisions?")).toHaveLength(2);
  });

  it("answers_an_empty_list_when_drive_has_none", async () => {
    const google = fake([fileMeta("doc-1"), ["GET", LIST, json(200, {})]]);
    const res = await getAsSignedIn("/api/files/doc-1/revisions", google);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ revisions: [] });
  });

  it("is_404_for_folders_google_docs_and_trashed_files_without_listing", async () => {
    for (const [label, route] of [
      ["folder", fileMeta("doc-1", FOLDER_MIME)],
      ["google doc", fileMeta("doc-1", "application/vnd.google-apps.document")],
      ["trashed", fileMeta("doc-1", "text/markdown", true)],
    ] as const) {
      const google = fake([route]);
      const res = await getAsSignedIn("/api/files/doc-1/revisions", google);
      expect(res.status, label).toBe(404);
      expect((await jsonBody(res))["code"], label).toBe("not_found");
      expect(google.callsContaining("/revisions"), label).toHaveLength(0);
    }
  });

  it("is_404_for_an_invalid_id_without_any_drive_call", async () => {
    for (const id of ["a%27", "a.b", "a%41"]) {
      const google = fake();
      const res = await getAsSignedIn(`/api/files/${id}/revisions`, google);
      expect(res.status, id).toBe(404);
      expect(google.calls, id).toHaveLength(0);
    }
  });

  it("needs_a_session", async () => {
    const google = fake();
    const res = await send(get("/api/files/doc-1/revisions"), { google });
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["code"]).toBe("unauthenticated");
    expect(google.calls).toHaveLength(0);
  });

  it("maps_drive_failures_of_the_revision_list", async () => {
    const cases: ReadonlyArray<readonly [string, Scripted, number, string]> = [
      ["401", json(401, {}), 401, "unauthenticated"],
      ["404", json(404, {}), 404, "not_found"],
      ["429", json(429, {}, { "retry-after": "9" }), 429, "rate_limited"],
      [
        "403 rate limit",
        json(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }),
        429,
        "rate_limited",
      ],
      [
        "403 other",
        json(403, { error: { errors: [{ reason: "forbidden" }] } }),
        502,
        "upstream_error",
      ],
      ["500", json(500, {}), 502, "upstream_error"],
      ["unreachable", unreachable(), 502, "upstream_error"],
      ["bad json", json(200, { revisions: [{ id: 1 }] }), 502, "upstream_error"],
      [
        "bad size",
        json(200, { revisions: [{ id: "r", modifiedTime: "t", size: 5 }] }),
        502,
        "upstream_error",
      ],
    ];
    for (const [label, answer, status, code] of cases) {
      const google = fake([fileMeta("doc-1"), ["GET", LIST, answer]]);
      const res = await getAsSignedIn("/api/files/doc-1/revisions", google);
      expect(res.status, label).toBe(status);
      expect((await jsonBody(res))["code"], label).toBe(code);
      expectSecurityHeaders(res);
      if (status === 401) expect(setCookies(res), label).toEqual([CLEAR_SESSION]);
      if (label === "429") expect(res.headers.get("retry-after")).toBe("9");
    }
  });
});

describe("GET /api/files/{id}/revisions/{revisionId}", () => {
  const revMeta = (size: number | undefined): R => [
    "GET",
    `${V3}/doc-1/revisions/rev-1?fields=id,size`,
    json(200, { id: "rev-1", ...(size === undefined ? {} : { size: String(size) }) }),
  ];
  const revMedia = (answer: Scripted): R => [
    "GET",
    `${V3}/doc-1/revisions/rev-1?alt=media`,
    answer,
  ];

  it("streams_the_revision_bytes_unread_as_octet_stream", async () => {
    const payload = new Uint8Array(128 * 1024).map((_, i) => i % 253);
    let pulled = 0;
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= payload.length) return controller.close();
        pulled++;
        controller.enqueue(payload.slice(offset, offset + 1024));
        offset += 1024;
      },
    });
    const google = fake([
      fileMeta("doc-1"),
      revMeta(payload.length),
      revMedia({ status: 200, body: source }),
    ]);
    const res = await getAsSignedIn("/api/files/doc-1/revisions/rev-1", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe(NO_STORE_NO_TRANSFORM);
    expectSecurityHeaders(res);
    expect(pulled).toBeLessThan(payload.length / 1024 / 2);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    expect(google.calls.map((c) => c.url)).toEqual([
      `${V3}/doc-1?fields=id,name,mimeType,modifiedTime,trashed,parents`,
      `${V3}/doc-1/revisions/rev-1?fields=id,size`,
      `${V3}/doc-1/revisions/rev-1?alt=media`,
    ]);
  });

  it("allows_exactly_10_mb_and_refuses_more_with_413_without_a_media_call", async () => {
    const ok = fake([
      fileMeta("doc-1"),
      revMeta(10_000_000),
      revMedia({ status: 200, body: streamOf(new Uint8Array(3)) }),
    ]);
    expect((await getAsSignedIn("/api/files/doc-1/revisions/rev-1", ok)).status).toBe(200);

    const large = fake([fileMeta("doc-1"), revMeta(10_000_001)]);
    const res = await getAsSignedIn("/api/files/doc-1/revisions/rev-1", large);
    expect(res.status).toBe(413);
    expect((await jsonBody(res))["code"]).toBe("too_large");
    expect(large.callsContaining("alt=media")).toHaveLength(0);

    const noSize = fake([fileMeta("doc-1"), revMeta(undefined)]);
    expect((await getAsSignedIn("/api/files/doc-1/revisions/rev-1", noSize)).status).toBe(502);
  });

  it("is_404_for_invalid_ids_or_extra_segments_without_any_drive_call", async () => {
    for (const path of [
      "/api/files/doc-1/revisions/a%27",
      "/api/files/doc-1/revisions/a.b",
      "/api/files/a.b/revisions/rev-1",
      "/api/files/a%41/revisions/rev-1",
      "/api/files/doc-1/revisions/rev-1/extra",
    ]) {
      const google = fake();
      const res = await getAsSignedIn(path, google);
      expect(res.status, path).toBe(404);
      expect((await jsonBody(res))["code"], path).toBe("not_found");
      expect(google.calls, path).toHaveLength(0);
    }
  });

  it("is_404_for_a_folder_or_trashed_file_without_a_revision_call", async () => {
    for (const route of [
      fileMeta("doc-1", FOLDER_MIME),
      fileMeta("doc-1", "text/markdown", true),
    ]) {
      const google = fake([route]);
      const res = await getAsSignedIn("/api/files/doc-1/revisions/rev-1", google);
      expect(res.status).toBe(404);
      expect(google.callsContaining("/revisions/")).toHaveLength(0);
    }
  });

  it("needs_a_session", async () => {
    const google = fake();
    const res = await send(get("/api/files/doc-1/revisions/rev-1"), { google });
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it("maps_drive_failures_of_the_revision_metadata_and_media", async () => {
    const meta = `${V3}/doc-1/revisions/rev-1?fields=`;
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<R>, number, string]> = [
      ["meta 401", [["GET", meta, json(401, {})]], 401, "unauthenticated"],
      ["meta 404", [["GET", meta, json(404, {})]], 404, "not_found"],
      ["meta 429", [["GET", meta, json(429, {}, { "retry-after": "4" })]], 429, "rate_limited"],
      ["meta 500", [["GET", meta, json(500, {})]], 502, "upstream_error"],
      ["media 401", [revMeta(3), revMedia(json(401, {}))], 401, "unauthenticated"],
      ["media 404", [revMeta(3), revMedia(json(404, {}))], 404, "not_found"],
      ["media 429", [revMeta(3), revMedia(json(429, {}))], 429, "rate_limited"],
      ["media unreachable", [revMeta(3), revMedia(unreachable())], 502, "upstream_error"],
    ];
    for (const [label, routes, status, code] of cases) {
      const google = fake([fileMeta("doc-1"), ...routes]);
      const res = await getAsSignedIn("/api/files/doc-1/revisions/rev-1", google);
      expect(res.status, label).toBe(status);
      expect((await jsonBody(res))["code"], label).toBe(code);
      if (status === 401) expect(setCookies(res), label).toEqual([CLEAR_SESSION]);
      if (label === "meta 429") expect(res.headers.get("retry-after")).toBe("4");
      if (label === "media 429") expect(res.headers.get("retry-after")).toBe("5");
    }
  });
});
