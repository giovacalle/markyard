// Port of the Rust `core/tests/files.rs` tests (file content read and save, rename, delete),
// plus streamed-upload tests the buffered Rust Worker had no equivalent for.

import { describe, expect, it } from "vite-plus/test";

import {
  AT,
  CLEAR_SESSION,
  FakeGoogle,
  NEW_AT,
  NOW,
  get,
  json,
  on,
  request,
  send,
  setCookies,
  signedInCookie,
  storedSession,
  streamOf,
  unreachable,
  type Answer,
  type Scripted,
} from "./support/harness.ts";
import { CSP, NOSNIFF } from "../src/http/app.ts";

const ETAG = '"MTcwMDAwMDAwMDAwMA"';
const NEW_ETAG = '"MTcwMDAwMDAwMDAwMQ"';

const META_URL = "https://fake.test/drive/v2/files/";
const MEDIA_URL = "https://fake.test/drive/v3/files/";
const UPLOAD_URL = "https://fake.test/upload/drive/v2/files/";

/** A route matched like the Rust `Fake`: same method and the URL contains `fragment`. */
type R = readonly [method: string, fragment: string, answer: Scripted];

/** Rust `Fake::new`. */
const fake = (routes: ReadonlyArray<R> = []): FakeGoogle =>
  new FakeGoogle(routes.map(([m, f, a]) => on(m, f, a, { contains: true })));

const bytesAnswer = (status: number, body: Uint8Array): Answer => ({ status, body });

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const refreshRoute = (): R => [
  "POST",
  "https://fake.test/token",
  json(200, { access_token: NEW_AT, expires_in: 3599, token_type: "Bearer" }),
];

const metaOk = (id: string, size: number, mime: string, trashed: boolean): R => [
  "GET",
  `${META_URL}${id}`,
  json(200, { etag: ETAG, fileSize: String(size), mimeType: mime, labels: { trashed } }),
];

const fresh = (): Promise<string> => signedInCookie();
const expired = (): Promise<string> => signedInCookie(storedSession(NOW + 59));

const getAsSignedIn = async (path: string, google: FakeGoogle): Promise<Response> =>
  send(get(path, { cookie: await fresh() }), { google });

/** Rust `put_req`: a same-origin PUT whose `Content-Length` is set, as any HTTP client sends it. */
const putReq = (
  path: string,
  cookie: string | undefined,
  ifMatch: string | undefined,
  body: Uint8Array,
): Request => {
  const headers: Record<string, string> = { "content-length": String(body.length) };
  if (ifMatch !== undefined) headers["if-match"] = ifMatch;
  return request("PUT", path, { ...(cookie === undefined ? {} : { cookie }), headers, body });
};

const putAsSignedIn = async (
  path: string,
  ifMatch: string | undefined,
  body: Uint8Array,
  google: FakeGoogle,
): Promise<Response> => send(putReq(path, await fresh(), ifMatch, body), { google });

const patchReq = (path: string, cookie: string, body: string): Request =>
  request("PATCH", path, { cookie, headers: { "content-type": "application/json" }, body });

const deleteReq = (path: string, cookie: string): Request => request("DELETE", path, { cookie });

const bodyBytes = async (res: Response): Promise<Uint8Array> =>
  new Uint8Array(await res.arrayBuffer());

const jsonBody = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.clone().json()) as Record<string, unknown>;

const expectSecurityHeaders = (res: Response): void => {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("x-content-type-options")).toBe(NOSNIFF);
};

const fileMeta = (
  id: string,
  name: string,
  mime: string,
  trashed: boolean,
  parents: ReadonlyArray<string>,
) => ({ id, name, mimeType: mime, modifiedTime: "2026-04-20T12:00:00Z", trashed, parents });

const rateCases = (retry: string): ReadonlyArray<readonly [string, Scripted, string]> => [
  ["429", json(429, {}, { "retry-after": retry }), retry],
  [
    "userRateLimitExceeded",
    json(403, { error: { errors: [{ reason: "userRateLimitExceeded" }], code: 403 } }),
    "5",
  ],
  [
    "rateLimitExceeded",
    json(403, { error: { errors: [{ reason: "rateLimitExceeded" }], code: 403 } }),
    "5",
  ],
];

// ---------------------------------------------------------------------------
// GET /api/files/{id}/content
// ---------------------------------------------------------------------------

describe("content", () => {
  it("content_returns_the_bytes_unchanged_with_the_v2_etag_reading_metadata_first", async () => {
    const fixture = new Uint8Array([
      ...bytes("\u{FEFF}---\r\ntitle: Note\r\n---\r\n# Hello\r\n"),
      0xff,
    ]);
    const google = fake([
      [
        "GET",
        `${META_URL}doc-1`,
        json(200, {
          etag: ETAG,
          fileSize: String(fixture.length),
          mimeType: "text/markdown",
          labels: { trashed: false },
        }),
      ],
      ["GET", `${MEDIA_URL}doc-1?alt=media`, { status: 200, body: streamOf(fixture, 7) }],
    ]);
    const res = await getAsSignedIn("/api/files/doc-1/content", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expectSecurityHeaders(res);
    expect(await bodyBytes(res)).toEqual(fixture);

    const calls = google.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.startsWith(`${META_URL}doc-1?fields=`)).toBe(true);
    for (const field of ["etag", "fileSize", "mimeType", "labels/trashed"])
      expect(calls[0]!.url).toContain(field);
    expect(calls[1]!.url).toBe(`${MEDIA_URL}doc-1?alt=media`);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${AT}`);
    expect(calls[1]!.headers.get("authorization")).toBe(`Bearer ${AT}`);
  });

  it("content_of_an_empty_file_is_200_with_etag_and_empty_stream", async () => {
    const google = fake([
      metaOk("doc-1", 0, "text/markdown", false),
      ["GET", `${MEDIA_URL}doc-1?alt=media`, bytesAnswer(200, new Uint8Array(0))],
    ]);
    const res = await getAsSignedIn("/api/files/doc-1/content", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expectSecurityHeaders(res);
    expect(await bodyBytes(res)).toHaveLength(0);
  });

  it("content_allows_exactly_10_mb_and_rejects_above_with_413_too_large_and_no_media_call", async () => {
    const googleOk = fake([
      metaOk("doc-1", 10_000_000, "text/markdown", false),
      ["GET", `${MEDIA_URL}doc-1?alt=media`, bytesAnswer(200, bytes("ok"))],
    ]);
    const resOk = await getAsSignedIn("/api/files/doc-1/content", googleOk);
    expect(resOk.status).toBe(200);
    expect(googleOk.callsContaining("alt=media")).toHaveLength(1);

    const googleLarge = fake([metaOk("doc-1", 10_000_001, "text/markdown", false)]);
    const resLarge = await getAsSignedIn("/api/files/doc-1/content", googleLarge);
    expect(resLarge.status).toBe(413);
    expect((await jsonBody(resLarge))["code"]).toBe("too_large");
    expectSecurityHeaders(resLarge);
    expect(googleLarge.callsContaining("alt=media")).toHaveLength(0);
  });

  it("content_404_on_metadata_or_media_is_not_found", async () => {
    const googleMeta = fake([["GET", `${META_URL}doc-1`, json(404, { error: { code: 404 } })]]);
    const resMeta = await getAsSignedIn("/api/files/doc-1/content", googleMeta);
    expect(resMeta.status).toBe(404);
    expect((await jsonBody(resMeta))["code"]).toBe("not_found");
    expect(googleMeta.callsContaining("alt=media")).toHaveLength(0);

    const googleMedia = fake([
      metaOk("doc-1", 10, "text/markdown", false),
      ["GET", `${MEDIA_URL}doc-1?alt=media`, json(404, { error: { code: 404 } })],
    ]);
    const resMedia = await getAsSignedIn("/api/files/doc-1/content", googleMedia);
    expect(resMedia.status).toBe(404);
    expect((await jsonBody(resMedia))["code"]).toBe("not_found");
    expect(googleMedia.callsContaining("alt=media")).toHaveLength(1);
  });

  it("content_of_folder_google_doc_shortcut_or_trashed_blob_is_not_found_without_media_call", async () => {
    const cases: ReadonlyArray<readonly [string, R]> = [
      ["folder", metaOk("doc-1", 0, "application/vnd.google-apps.folder", false)],
      ["google doc", metaOk("doc-1", 100, "application/vnd.google-apps.document", false)],
      ["shortcut", metaOk("doc-1", 0, "application/vnd.google-apps.shortcut", false)],
      ["trashed blob", metaOk("doc-1", 10, "text/markdown", true)],
    ];
    for (const [label, metaRoute] of cases) {
      const google = fake([metaRoute]);
      const res = await getAsSignedIn("/api/files/doc-1/content", google);
      expect(res.status, label).toBe(404);
      expect((await jsonBody(res))["code"], label).toBe("not_found");
      expect(google.callsContaining("alt=media"), label).toHaveLength(0);
    }
  });

  it("content_invalid_or_empty_id_is_not_found_without_upstream", async () => {
    for (const path of [
      "/api/files/a%27/content",
      "/api/files/../content",
      "/api/files/a.b/content",
      "/api/files//content",
    ]) {
      const google = fake();
      const res = await getAsSignedIn(path, google);
      expect(res.status, path).toBe(404);
      expect((await jsonBody(res))["code"], path).toBe("not_found");
      expect(google.calls, path).toHaveLength(0);
    }
  });

  it("content_without_session_is_401_and_calls_nothing", async () => {
    const google = fake();
    const res = await send(get("/api/files/doc-1/content"), { google });

    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ code: "unauthenticated", message: "Not signed in" });
    expect(google.calls).toHaveLength(0);
  });

  it("content_drive_401_on_metadata_or_media_ends_session_with_only_clear_cookie", async () => {
    const clear = [CLEAR_SESSION];
    const meta401: R = ["GET", `${META_URL}doc-1`, json(401, { error: { code: 401 } })];
    const media401: R = ["GET", `${MEDIA_URL}doc-1?alt=media`, json(401, { error: { code: 401 } })];

    // Metadata 401 (direct)
    let google = fake([meta401]);
    let res = await getAsSignedIn("/api/files/doc-1/content", google);
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["reason"]).toBe("session_ended");
    expect(setCookies(res)).toEqual(clear);
    expect(google.callsContaining("alt=media")).toHaveLength(0);

    // Media 401 (direct)
    google = fake([metaOk("doc-1", 10, "text/markdown", false), media401]);
    res = await getAsSignedIn("/api/files/doc-1/content", google);
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["reason"]).toBe("session_ended");
    expect(setCookies(res)).toEqual(clear);

    // Metadata 401 after refresh -> only clear cookie
    google = fake([refreshRoute(), meta401]);
    res = await send(get("/api/files/doc-1/content", { cookie: await expired() }), { google });
    expect(res.status).toBe(401);
    expect(setCookies(res)).toEqual(clear);

    // Media 401 after refresh -> only clear cookie
    google = fake([refreshRoute(), metaOk("doc-1", 10, "text/markdown", false), media401]);
    res = await send(get("/api/files/doc-1/content", { cookie: await expired() }), { google });
    expect(res.status).toBe(401);
    expect(setCookies(res)).toEqual(clear);
  });

  it("content_rate_limit_on_metadata_or_media_is_429_with_retry_after", async () => {
    for (const [label, scripted, expectedRetry] of rateCases("7")) {
      const googleMeta = fake([["GET", `${META_URL}doc-1`, scripted]]);
      const resMeta = await getAsSignedIn("/api/files/doc-1/content", googleMeta);
      expect(resMeta.status, `meta ${label}`).toBe(429);
      expect((await jsonBody(resMeta))["code"], `meta ${label}`).toBe("rate_limited");
      expect(resMeta.headers.get("retry-after"), `meta ${label}`).toBe(expectedRetry);
      expect(googleMeta.callsContaining("alt=media")).toHaveLength(0);
    }

    for (const [label, scripted, expectedRetry] of rateCases("9")) {
      const googleMedia = fake([
        metaOk("doc-1", 10, "text/markdown", false),
        ["GET", `${MEDIA_URL}doc-1?alt=media`, scripted],
      ]);
      const resMedia = await getAsSignedIn("/api/files/doc-1/content", googleMedia);
      expect(resMedia.status, `media ${label}`).toBe(429);
      expect((await jsonBody(resMedia))["code"], `media ${label}`).toBe("rate_limited");
      expect(resMedia.headers.get("retry-after"), `media ${label}`).toBe(expectedRetry);
    }
  });

  it("content_500_garbage_metadata_missing_size_or_transport_error_is_502", async () => {
    const metaFailures: ReadonlyArray<readonly [string, Scripted]> = [
      ["meta 500", json(500, {})],
      ["meta garbage", json(200, "not an object")],
      [
        "missing fileSize",
        json(200, { etag: ETAG, mimeType: "text/markdown", labels: { trashed: false } }),
      ],
      [
        "unparsable fileSize",
        json(200, {
          etag: ETAG,
          fileSize: "not-a-number",
          mimeType: "text/markdown",
          labels: { trashed: false },
        }),
      ],
      [
        "invalid etag header",
        json(200, {
          etag: "bad\netag",
          fileSize: "5",
          mimeType: "text/markdown",
          labels: { trashed: false },
        }),
      ],
      ["meta transport", unreachable("connection reset")],
    ];
    for (const [label, scripted] of metaFailures) {
      const google = fake([["GET", `${META_URL}doc-1`, scripted]]);
      const res = await getAsSignedIn("/api/files/doc-1/content", google);
      expect(res.status, label).toBe(502);
      expect((await jsonBody(res))["code"], label).toBe("upstream_error");
    }

    for (const [label, scripted] of [
      ["media 500", json(500, {})],
      ["media transport", unreachable("connection reset")],
    ] as const) {
      const google = fake([
        metaOk("doc-1", 10, "text/markdown", false),
        ["GET", `${MEDIA_URL}doc-1?alt=media`, scripted],
      ]);
      const res = await getAsSignedIn("/api/files/doc-1/content", google);
      expect(res.status, label).toBe(502);
      expect((await jsonBody(res))["code"], label).toBe("upstream_error");
    }
  });

  it("content_with_expired_token_refreshes_and_sets_cookie_on_streamed_reply", async () => {
    const google = fake([
      refreshRoute(),
      metaOk("doc-1", 5, "text/markdown", false),
      ["GET", `${MEDIA_URL}doc-1?alt=media`, bytesAnswer(200, bytes("hello"))],
    ]);
    const res = await send(get("/api/files/doc-1/content", { cookie: await expired() }), {
      google,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(ETAG);
    expectSecurityHeaders(res);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.startsWith("__Host-s=")).toBe(true);
    expect(await bodyBytes(res)).toEqual(bytes("hello"));
    const bearer = `Bearer ${NEW_AT}`;
    expect(google.callsContaining("drive/v2")[0]!.headers.get("authorization")).toBe(bearer);
    expect(google.callsContaining("alt=media")[0]!.headers.get("authorization")).toBe(bearer);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/files/{id}/content
// ---------------------------------------------------------------------------

describe("save", () => {
  it("save_with_current_tag_uploads_bytes_unchanged_via_v2_media_and_returns_204_with_new_etag", async () => {
    const fixture = bytes("\u{FEFF}---\r\ntitle: X\r\n---\r\n[[Link]]  \r\nbody\r\n");
    const google = fake([["PUT", `${UPLOAD_URL}doc-1`, json(200, { etag: NEW_ETAG })]]);

    const res = await putAsSignedIn("/api/files/doc-1/content", ETAG, fixture, google);

    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBe(NEW_ETAG);
    expectSecurityHeaders(res);
    expect(await bodyBytes(res)).toHaveLength(0);

    const calls = google.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`${UPLOAD_URL}doc-1?uploadType=media&fields=etag`);
    expect(calls[0]!.url).not.toContain("convert");
    expect(calls[0]!.headers.get("if-match")).toBe(ETAG);
    expect(calls[0]!.headers.get("content-type")).toBe("text/markdown");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${AT}`);
    expect(calls[0]!.body).toEqual(fixture);
  });

  it("save_with_empty_body_uploads_zero_bytes_and_returns_204", async () => {
    const google = fake([["PUT", `${UPLOAD_URL}doc-1`, json(200, { etag: NEW_ETAG })]]);
    const res = await putAsSignedIn("/api/files/doc-1/content", ETAG, new Uint8Array(0), google);

    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBe(NEW_ETAG);
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.body).toHaveLength(0);
  });

  it("save_with_stale_tag_maps_drive_412_to_conflict", async () => {
    const google = fake([
      [
        "PUT",
        `${UPLOAD_URL}doc-1`,
        json(412, { error: { code: 412, errors: [{ reason: "conditionNotMet" }] } }),
      ],
    ]);
    const res = await putAsSignedIn("/api/files/doc-1/content", ETAG, bytes("updated"), google);

    expect(res.status).toBe(412);
    expect((await jsonBody(res))["code"]).toBe("conflict");
    expectSecurityHeaders(res);
    expect(google.calls).toHaveLength(1);
  });

  it("save_with_missing_or_invalid_if_match_is_428_without_calling_drive", async () => {
    const overlong = `"${"a".repeat(201)}"`;
    const cases: ReadonlyArray<readonly [string, string | undefined]> = [
      ["missing", undefined],
      ["empty", ""],
      ["wildcard", "*"],
      ["weak tag", 'W/"x"'],
      ["list", '"a","b"'],
      ["unquoted", "abc"],
      ["empty quotes", '""'],
      ["overlong", overlong],
    ];

    for (const [label, ifMatch] of cases) {
      const google = fake();
      const res = await putAsSignedIn("/api/files/doc-1/content", ifMatch, bytes("hello"), google);
      expect(res.status, label).toBe(428);
      expect((await jsonBody(res))["code"], label).toBe("precondition_required");
      expectSecurityHeaders(res);
      expect(google.calls, label).toHaveLength(0);
    }
  });

  it("save_invalid_or_empty_id_is_404_without_upstream", async () => {
    for (const path of ["/api/files/a.b/content", "/api/files/../content", "/api/files//content"]) {
      const google = fake();
      const res = await putAsSignedIn(path, ETAG, bytes("x"), google);
      expect(res.status, path).toBe(404);
      expect((await jsonBody(res))["code"], path).toBe("not_found");
      expect(google.calls, path).toHaveLength(0);
    }
  });

  it("save_without_session_is_401_and_calls_nothing", async () => {
    const google = fake();
    const res = await send(putReq("/api/files/doc-1/content", undefined, ETAG, bytes("x")), {
      google,
    });

    expect(res.status).toBe(401);
    expect((await jsonBody(res))["code"]).toBe("unauthenticated");
    expect(google.calls).toHaveLength(0);
  });

  it("save_from_foreign_origin_is_403_forbidden_without_upstream", async () => {
    const google = fake();
    const req = request("PUT", "/api/files/doc-1/content", {
      headers: { origin: "https://evil.test", "if-match": ETAG },
      cookie: await fresh(),
      body: bytes("x"),
    });
    const res = await send(req, { google });

    expect(res.status).toBe(403);
    expect((await jsonBody(res))["code"]).toBe("forbidden");
    expectSecurityHeaders(res);
    expect(google.calls).toHaveLength(0);
  });

  it("save_allows_exactly_10_mb_and_rejects_above_with_413_without_upload", async () => {
    const googleOk = fake([["PUT", `${UPLOAD_URL}doc-1`, json(200, { etag: NEW_ETAG })]]);
    const resOk = await putAsSignedIn(
      "/api/files/doc-1/content",
      ETAG,
      new Uint8Array(10_000_000).fill(0x61),
      googleOk,
    );
    expect(resOk.status).toBe(204);
    expect(googleOk.calls).toHaveLength(1);
    expect(googleOk.calls[0]!.body).toHaveLength(10_000_000);

    const googleLarge = fake();
    const resLarge = await putAsSignedIn(
      "/api/files/doc-1/content",
      ETAG,
      new Uint8Array(10_000_001).fill(0x61),
      googleLarge,
    );
    expect(resLarge.status).toBe(413);
    expect((await jsonBody(resLarge))["code"]).toBe("too_large");
    expectSecurityHeaders(resLarge);
    expect(googleLarge.calls).toHaveLength(0);
  });

  it("save_drive_404_is_not_found", async () => {
    const google = fake([["PUT", `${UPLOAD_URL}doc-1`, json(404, { error: { code: 404 } })]]);
    const res = await putAsSignedIn("/api/files/doc-1/content", ETAG, bytes("x"), google);

    expect(res.status).toBe(404);
    expect((await jsonBody(res))["code"]).toBe("not_found");
  });

  it("save_drive_401_ends_session_with_only_clear_cookie", async () => {
    const clear = [CLEAR_SESSION];
    const upload401: R = ["PUT", `${UPLOAD_URL}doc-1`, json(401, { error: { code: 401 } })];

    // Direct 401
    let google = fake([upload401]);
    let res = await putAsSignedIn("/api/files/doc-1/content", ETAG, bytes("x"), google);
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["reason"]).toBe("session_ended");
    expect(setCookies(res)).toEqual(clear);

    // 401 after refresh -> only clear cookie
    google = fake([refreshRoute(), upload401]);
    res = await send(putReq("/api/files/doc-1/content", await expired(), ETAG, bytes("x")), {
      google,
    });
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["reason"]).toBe("session_ended");
    expect(setCookies(res)).toEqual(clear);
  });

  it("save_rate_limit_is_429_with_retry_after", async () => {
    for (const [label, scripted, expectedRetry] of rateCases("7")) {
      const google = fake([["PUT", `${UPLOAD_URL}doc-1`, scripted]]);
      const res = await putAsSignedIn("/api/files/doc-1/content", ETAG, bytes("x"), google);
      expect(res.status, label).toBe(429);
      expect((await jsonBody(res))["code"], label).toBe("rate_limited");
      expect(res.headers.get("retry-after"), label).toBe(expectedRetry);
    }
  });

  it("save_drive_500_transport_or_unusable_etag_is_502", async () => {
    const failures: ReadonlyArray<readonly [string, Scripted]> = [
      ["500", json(500, {})],
      ["transport", unreachable("connection reset")],
      ["garbage body", bytesAnswer(200, bytes("not json"))],
      ["missing etag", json(200, {})],
      ["empty etag", json(200, { etag: "" })],
      ["invalid etag header", json(200, { etag: "bad\netag" })],
    ];

    for (const [label, scripted] of failures) {
      const google = fake([["PUT", `${UPLOAD_URL}doc-1`, scripted]]);
      const res = await putAsSignedIn("/api/files/doc-1/content", ETAG, bytes("x"), google);
      expect(res.status, label).toBe(502);
      expect((await jsonBody(res))["code"], label).toBe("upstream_error");
      expectSecurityHeaders(res);
    }
  });

  it("save_with_expired_token_refreshes_and_sets_cookie", async () => {
    const google = fake([
      refreshRoute(),
      ["PUT", `${UPLOAD_URL}doc-1`, json(200, { etag: NEW_ETAG })],
    ]);
    const res = await send(
      putReq("/api/files/doc-1/content", await expired(), ETAG, bytes("updated")),
      { google },
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBe(NEW_ETAG);
    expectSecurityHeaders(res);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.startsWith("__Host-s=")).toBe(true);
    expect(google.callsContaining("upload/drive/v2")[0]!.headers.get("authorization")).toBe(
      `Bearer ${NEW_AT}`,
    );
  });

  // Not in the Rust suite (its Worker buffered every body): a chunked body with no
  // `Content-Length` is read up to the cap, then uploaded or refused.
  it("save_without_content_length_reads_the_body_up_to_the_cap", async () => {
    const payload = bytes("chunked body");
    const google = fake([["PUT", `${UPLOAD_URL}doc-1`, json(200, { etag: NEW_ETAG })]]);
    const res = await send(
      request("PUT", "/api/files/doc-1/content", {
        cookie: await fresh(),
        headers: { "if-match": ETAG },
        body: streamOf(payload, 3),
      }),
      { google },
    );
    expect(res.status).toBe(204);
    expect(google.calls[0]!.body).toEqual(payload);

    const googleLarge = fake();
    const resLarge = await send(
      request("PUT", "/api/files/doc-1/content", {
        cookie: await fresh(),
        headers: { "if-match": ETAG },
        body: streamOf(new Uint8Array(10_000_001)),
      }),
      { google: googleLarge },
    );
    expect(resLarge.status).toBe(413);
    expect((await jsonBody(resLarge))["code"]).toBe("too_large");
    expect(googleLarge.calls).toHaveLength(0);
  });

  it("save_with_content_length_streams_the_request_body_to_drive", async () => {
    const payload = new Uint8Array(200_000).map((_, i) => i % 251);
    const google = fake([["PUT", `${UPLOAD_URL}doc-1`, json(200, { etag: NEW_ETAG })]]);
    const res = await send(
      request("PUT", "/api/files/doc-1/content", {
        cookie: await fresh(),
        headers: { "if-match": ETAG, "content-length": String(payload.length) },
        body: streamOf(payload, 4096),
      }),
      { google },
    );
    expect(res.status).toBe(204);
    expect(google.calls[0]!.body).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/files/{id}
// ---------------------------------------------------------------------------

describe("rename", () => {
  it("rename_updates_file_name_and_returns_node", async () => {
    const google = fake([
      [
        "GET",
        `${MEDIA_URL}doc-1?fields=`,
        json(200, fileMeta("doc-1", "old.md", "text/markdown", false, ["folder-1"])),
      ],
      [
        "GET",
        "https://fake.test/drive/v3/files?q=",
        json(200, {
          files: [
            fileMeta("doc-1", "old.md", "text/markdown", false, ["folder-1"]),
            fileMeta("doc-2", "other.md", "text/markdown", false, ["folder-1"]),
          ],
        }),
      ],
      [
        "PATCH",
        `${META_URL}doc-1?fields=id,title,mimeType,modifiedDate,etag`,
        json(200, {
          id: "doc-1",
          title: "renamed.md",
          mimeType: "text/markdown",
          modifiedDate: "2026-04-20T12:00:00Z",
          etag: NEW_ETAG,
        }),
      ],
    ]);

    const res = await send(
      patchReq("/api/files/doc-1", await fresh(), JSON.stringify({ name: "  renamed.md  " })),
      { google },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(NEW_ETAG);
    expectSecurityHeaders(res);
    expect(await jsonBody(res)).toEqual({
      id: "doc-1",
      name: "renamed.md",
      kind: "markdown",
      modifiedTime: "2026-04-20T12:00:00Z",
    });
    const patchCall = google.calls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall!.text)).toEqual({ title: "renamed.md" });
  });

  it("rename_same_name_returns_200_without_calling_patch", async () => {
    const google = fake([
      [
        "GET",
        `${MEDIA_URL}doc-1?fields=`,
        json(200, fileMeta("doc-1", "same.md", "text/markdown", false, ["folder-1"])),
      ],
    ]);

    const res = await send(
      patchReq("/api/files/doc-1", await fresh(), JSON.stringify({ name: "same.md" })),
      { google },
    );

    expect(res.status).toBe(200);
    expect((await jsonBody(res))["name"]).toBe("same.md");
    expect(google.calls.every((c) => c.method !== "PATCH")).toBe(true);
  });

  it("rename_rejects_duplicate_sibling_name_with_409", async () => {
    const google = fake([
      [
        "GET",
        `${MEDIA_URL}doc-1?fields=`,
        json(200, fileMeta("doc-1", "old.md", "text/markdown", false, ["folder-1"])),
      ],
      [
        "GET",
        "https://fake.test/drive/v3/files?q=",
        json(200, {
          files: [
            fileMeta("doc-1", "old.md", "text/markdown", false, ["folder-1"]),
            fileMeta("doc-2", "taken.md", "text/markdown", false, ["folder-1"]),
          ],
        }),
      ],
    ]);

    const res = await send(
      patchReq("/api/files/doc-1", await fresh(), JSON.stringify({ name: "taken.md" })),
      { google },
    );

    expect(res.status).toBe(409);
    expect((await jsonBody(res))["code"]).toBe("name_exists");
  });

  it("rename_rejects_invalid_names_and_bad_json_without_calling_drive", async () => {
    const cookie = await fresh();
    for (const [label, body, expectedCode] of [
      ["invalid json", "not json", "invalid_request"],
      ["empty", JSON.stringify({ name: "   " }), "invalid_name"],
      ["slash", JSON.stringify({ name: "a/b.md" }), "invalid_name"],
      ["no md", JSON.stringify({ name: "note.txt" }), "invalid_name"],
      ["just md", JSON.stringify({ name: ".md" }), "invalid_name"],
    ] as const) {
      const google = fake();
      const res = await send(patchReq("/api/files/doc-1", cookie, body), { google });
      expect(res.status, label).toBe(400);
      expect((await jsonBody(res))["code"], label).toBe(expectedCode);
      expect(google.calls, label).toHaveLength(0);
    }
  });

  it("rename_rejects_folder_trashed_or_cross_origin", async () => {
    const cookie = await fresh();
    for (const [label, meta] of [
      ["folder", fileMeta("folder-1", "Work", "application/vnd.google-apps.folder", false, [])],
      ["trashed", fileMeta("doc-1", "old.md", "text/markdown", true, [])],
    ] as const) {
      const google = fake([["GET", MEDIA_URL, json(200, meta)]]);
      const res = await send(
        patchReq("/api/files/doc-1", cookie, JSON.stringify({ name: "new.md" })),
        { google },
      );
      expect(res.status, label).toBe(404);
    }

    const google = fake();
    const crossOrigin = request("PATCH", "/api/files/doc-1", {
      headers: { origin: "https://evil.test" },
      cookie,
      body: JSON.stringify({ name: "new.md" }),
    });
    const res = await send(crossOrigin, { google });
    expect(res.status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/files/{id}
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("delete_moves_file_to_trash_and_returns_204", async () => {
    const google = fake([
      [
        "GET",
        `${MEDIA_URL}doc-1?fields=`,
        json(200, fileMeta("doc-1", "note.md", "text/markdown", false, ["folder-1"])),
      ],
      ["PATCH", `${MEDIA_URL}doc-1`, json(200, {})],
    ]);

    const res = await send(deleteReq("/api/files/doc-1", await fresh()), { google });

    expect(res.status).toBe(204);
    expectSecurityHeaders(res);
    const patchCall = google.calls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall!.text)).toEqual({ trashed: true });
  });

  it("delete_rejects_folder_trashed_invalid_id_or_cross_origin", async () => {
    const cookie = await fresh();
    for (const [label, meta] of [
      ["folder", fileMeta("folder-1", "Work", "application/vnd.google-apps.folder", false, [])],
      ["trashed", fileMeta("doc-1", "old.md", "text/markdown", true, [])],
    ] as const) {
      const google = fake([["GET", MEDIA_URL, json(200, meta)]]);
      const res = await send(deleteReq("/api/files/doc-1", cookie), { google });
      expect(res.status, label).toBe(404);
      expect(google.calls.every((c) => c.method !== "PATCH")).toBe(true);
    }

    const google = fake();
    const badId = await send(deleteReq("/api/files/bad!id", cookie), { google });
    expect(badId.status).toBe(404);
    expect(google.calls).toHaveLength(0);

    const crossOrigin = request("DELETE", "/api/files/doc-1", {
      headers: { origin: "https://evil.test" },
      cookie,
    });
    const res = await send(crossOrigin, { google });
    expect(res.status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });
});
