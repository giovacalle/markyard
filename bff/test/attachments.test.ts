// Image attachments: `POST /api/attachments` (strict image allowlist, 10 MiB cap, the
// `_attachments` folder found or created under the root, a multipart upload streamed to Drive)
// and `GET /api/files/{id}/blob` (subtree isolation, allowlist, cap, Drive's body unread).

import { describe, expect, it } from "vite-plus/test";

import { attachmentName, imageMimeOf, MAX_ATTACHMENT_BYTES } from "../src/domain/attachments.ts";
import { CSP, NO_STORE_NO_TRANSFORM, NOSNIFF } from "../src/http/app.ts";
import {
  AT,
  CLEAR_SESSION,
  FakeGoogle,
  NOW,
  get,
  json,
  on,
  request,
  send,
  setCookies,
  signedInCookie,
  streamOf,
  text,
  unreachable,
  type Answer,
  type Recorded,
  type Scripted,
} from "./support/harness.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const V3 = "https://fake.test/drive/v3/files";
const UPLOAD = "https://fake.test/upload/drive/v3/files?uploadType=multipart";
const FIND = "orderBy=createdTime";
const MULTIPART_PREFIX = "multipart/related; boundary=";

type R = readonly [method: string, fragment: string, answer: Scripted];

const fake = (routes: ReadonlyArray<R> = []): FakeGoogle =>
  new FakeGoogle(routes.map(([m, f, a]) => on(m, f, a, { contains: true })));

/** A fake whose `fetch` first runs `before` (to look at the world when Drive is called). */
const spying = (google: FakeGoogle, before: () => void): FakeGoogle =>
  ({
    fetch: (req: Request) => {
      before();
      return google.fetch(req);
    },
  }) as unknown as FakeGoogle;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const folder = (id: string, name: string, parents: ReadonlyArray<string>, trashed = false) => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  modifiedTime: "2026-11-20T10:00:00.000Z",
  trashed,
  parents,
});

const ATT_FOLDER = folder("att-folder", "_attachments", ["root-id"]);

const findAnswer = (files: ReadonlyArray<unknown>): R => ["GET", FIND, json(200, { files })];

const uploaded = (id: string, name: string, mimeType: string, size: number): R => [
  "POST",
  UPLOAD,
  json(200, { id, name, mimeType, size: String(size) }),
];

/** A same-origin upload; `Content-Length` is set unless the body is a stream. */
const postImage = async (
  body: Uint8Array | ReadableStream<Uint8Array> | undefined,
  headers: Record<string, string>,
  options: { cookie?: string | null; origin?: string } = {},
): Promise<Request> => {
  const all: Record<string, string> = { ...headers };
  if (body instanceof Uint8Array && all["content-length"] === undefined)
    all["content-length"] = String(body.length);
  if (options.origin !== undefined) all["origin"] = options.origin;
  const cookie = options.cookie === undefined ? await signedInCookie() : options.cookie;
  return request("POST", "/api/attachments", {
    headers: all,
    ...(cookie === null ? {} : { cookie }),
    ...(body === undefined ? {} : { body }),
  });
};

const jsonBody = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.clone().json()) as Record<string, unknown>;

const expectSecurityHeaders = (res: Response): void => {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("x-content-type-options")).toBe(NOSNIFF);
};

const uploadCall = (google: FakeGoogle): Recorded => {
  const call = google.calls.find((c) => c.method === "POST" && c.url.startsWith(UPLOAD));
  expect(call).toBeDefined();
  return call!;
};

const boundaryOf = (call: Recorded): string => {
  const ct = call.headers.get("content-type");
  expect(ct?.startsWith(MULTIPART_PREFIX)).toBe(true);
  return ct!.slice(MULTIPART_PREFIX.length);
};

/** The exact multipart body Drive must receive for `metadata` and `content`. */
const multipart = (boundary: string, metadata: unknown, mime: string, content: Uint8Array) => {
  const head = bytes(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = bytes(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + content.length + tail.length);
  out.set(head, 0);
  out.set(content, head.length);
  out.set(tail, head.length + content.length);
  return out;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("image allowlist", () => {
  it("accepts_only_png_jpeg_webp_gif_with_parameters_and_case_normalized", () => {
    expect(imageMimeOf("image/png")).toBe("image/png");
    expect(imageMimeOf("IMAGE/JPEG; charset=binary")).toBe("image/jpeg");
    expect(imageMimeOf("  image/webp ;q=1")).toBe("image/webp");
    expect(imageMimeOf("image/gif")).toBe("image/gif");
    for (const bad of [
      null,
      undefined,
      "",
      "image/svg+xml",
      "image/svg+xml; charset=utf-8",
      "text/html",
      "image/jpg",
      "image/png+xml",
      "image/pngx",
      "application/octet-stream",
      "image/*",
      "image/bmp",
    ])
      expect(imageMimeOf(bad), String(bad)).toBeUndefined();
  });
});

describe("attachmentName", () => {
  const stamp = "image-20270115-080000";

  it("keeps_a_safe_name_and_forces_a_matching_extension", () => {
    expect(attachmentName("diagram.png", "image/png", NOW)).toBe("diagram.png");
    expect(attachmentName("Photo.JPEG", "image/jpeg", NOW)).toBe("Photo.jpeg");
    expect(attachmentName("photo.JPG", "image/jpeg", NOW)).toBe("photo.jpg");
    expect(attachmentName("photo.png", "image/jpeg", NOW)).toBe("photo.jpg");
    expect(attachmentName("evil.svg", "image/png", NOW)).toBe("evil.png");
    expect(attachmentName("page.html", "image/gif", NOW)).toBe("page.html.gif");
    expect(attachmentName("report.final", "image/webp", NOW)).toBe("report.final.webp");
    expect(attachmentName("noext", "image/webp", NOW)).toBe("noext.webp");
  });

  it("strips_paths_unsafe_characters_bidi_controls_and_leading_dots", () => {
    expect(attachmentName("../../etc/passwd", "image/png", NOW)).toBe("passwd.png");
    expect(attachmentName("C:\\Users\\me\\shot.png", "image/png", NOW)).toBe("shot.png");
    expect(attachmentName("<script>alert(1)</script>.png", "image/png", NOW)).toBe("script.png");
    expect(attachmentName('<img src=x onerror="a">|?*:.png', "image/png", NOW)).toBe(
      "img src=x onerror=a.png",
    );
    expect(attachmentName("a\u202Egnp.exe", "image/png", NOW)).toBe("agnp.exe.png");
    expect(attachmentName("tab\there\nnew.gif", "image/gif", NOW)).toBe("tabherenew.gif");
    expect(attachmentName(".hidden.png", "image/png", NOW)).toBe("hidden.png");
    expect(attachmentName("  spaced   out  .png", "image/png", NOW)).toBe("spaced out.png");
  });

  it("decodes_percent_encoded_utf8_and_caps_the_stem_at_100_code_points", () => {
    expect(attachmentName("%E6%97%A5%E6%9C%AC.png", "image/png", NOW)).toBe("日本.png");
    expect(attachmentName("100%.png", "image/png", NOW)).toBe("100%.png");
    expect(attachmentName(`${"é".repeat(300)}.png`, "image/png", NOW)).toBe(
      `${"é".repeat(100)}.png`,
    );
  });

  it("falls_back_to_a_utc_stamp_when_nothing_usable_is_left", () => {
    expect(attachmentName(null, "image/png", NOW)).toBe(`${stamp}.png`);
    expect(attachmentName("", "image/jpeg", NOW)).toBe(`${stamp}.jpg`);
    expect(attachmentName("   ", "image/gif", NOW)).toBe(`${stamp}.gif`);
    expect(attachmentName(".png", "image/png", NOW)).toBe(`${stamp}.png`);
    expect(attachmentName("dir/", "image/webp", NOW)).toBe(`${stamp}.webp`);
    expect(attachmentName("***", "image/png", NOW)).toBe(`${stamp}.png`);
  });
});

// ---------------------------------------------------------------------------
// POST /api/attachments
// ---------------------------------------------------------------------------

describe("POST /api/attachments", () => {
  it("uploads_into_the_existing_attachments_folder_and_answers_201", async () => {
    const google = fake([
      findAnswer([ATT_FOLDER]),
      uploaded("img-1", "diagram.png", "image/png", PNG.length),
    ]);
    const res = await send(
      await postImage(PNG, { "content-type": "image/png", "x-filename": "diagram.png" }),
      { google },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe(NO_STORE_NO_TRANSFORM);
    expectSecurityHeaders(res);
    expect(await res.text()).toBe(
      JSON.stringify({
        id: "img-1",
        name: "diagram.png",
        mimeType: "image/png",
        size: PNG.length,
        url: "/api/files/img-1/blob",
      }),
    );

    expect(google.calls).toHaveLength(2);
    const find = google.calls[0]!;
    const q = new URL(find.url).searchParams.get("q");
    expect(q).toBe(
      `'root-id' in parents and name='_attachments' and mimeType='${FOLDER_MIME}' and trashed=false`,
    );
    expect(find.headers.get("authorization")).toBe(`Bearer ${AT}`);

    const upload = uploadCall(google);
    expect(upload.url).toBe(`${UPLOAD}&fields=id,name,mimeType,size`);
    expect(upload.headers.get("authorization")).toBe(`Bearer ${AT}`);
    const boundary = boundaryOf(upload);
    expect(upload.body).toEqual(
      multipart(
        boundary,
        { name: "diagram.png", mimeType: "image/png", parents: ["att-folder"] },
        "image/png",
        PNG,
      ),
    );
    expect(google.unexpected).toEqual([]);
  });

  it("creates_the_attachments_folder_under_the_root_when_missing", async () => {
    const google = fake([
      findAnswer([]),
      [
        "POST",
        `${V3}?fields=`,
        json(200, { ...folder("new-folder", "_attachments", ["root-id"]) }),
      ],
      uploaded("img-2", "shot.webp", "image/webp", 4),
    ]);
    const content = bytes("RIFF");
    const res = await send(
      await postImage(content, { "content-type": "image/webp", "x-filename": "shot.webp" }),
      { google },
    );

    expect(res.status).toBe(201);
    expect((await jsonBody(res))["id"]).toBe("img-2");
    const create = google.calls.find((c) => c.method === "POST" && c.url.startsWith(`${V3}?`));
    expect(JSON.parse(create!.text)).toEqual({
      name: "_attachments",
      mimeType: FOLDER_MIME,
      parents: ["root-id"],
    });
    expect(uploadCall(google).text).toContain('"parents":["new-folder"]');
  });

  it("ignores_a_trashed_or_differently_named_folder_from_the_search_and_creates_one", async () => {
    const google = fake([
      findAnswer([
        folder("trashed", "_attachments", ["root-id"], true),
        folder("other", "_Attachments", ["root-id"]),
      ]),
      ["POST", `${V3}?fields=`, json(200, folder("fresh", "_attachments", ["root-id"]))],
      uploaded("img-3", "a.gif", "image/gif", 3),
    ]);
    const res = await send(
      await postImage(bytes("GIF"), { "content-type": "image/gif", "x-filename": "a.gif" }),
      { google },
    );
    expect(res.status).toBe(201);
    expect(uploadCall(google).text).toContain('"parents":["fresh"]');
  });

  it("reuses_the_oldest_live_attachments_folder_when_there_are_several", async () => {
    const google = fake([
      findAnswer([ATT_FOLDER, folder("newer", "_attachments", ["root-id"])]),
      uploaded("img-4", "x.png", "image/png", PNG.length),
    ]);
    const res = await send(await postImage(PNG, { "content-type": "image/png" }), { google });
    expect(res.status).toBe(201);
    expect(uploadCall(google).text).toContain('"parents":["att-folder"]');
    expect(google.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("normalizes_the_content_type_and_names_an_unnamed_upload_from_the_clock", async () => {
    // Drive echoes no name or size: the BFF answers with what it sent.
    const google = fake([findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(200, { id: "img-5" })]]);
    const res = await send(await postImage(PNG, { "content-type": "Image/PNG; charset=binary" }), {
      google,
    });

    expect(res.status).toBe(201);
    expect(await jsonBody(res)).toEqual({
      id: "img-5",
      name: "image-20270115-080000.png",
      mimeType: "image/png",
      size: PNG.length,
      url: "/api/files/img-5/blob",
    });
    const upload = uploadCall(google);
    expect(upload.text).toContain("\r\nContent-Type: image/png\r\n\r\n");
    expect(upload.text).toContain('"mimeType":"image/png"');
  });

  it("rejects_svg_html_and_any_non_allowlisted_type_with_400_and_no_drive_call", async () => {
    for (const contentType of [
      "image/svg+xml",
      "image/svg+xml; charset=utf-8",
      "text/html",
      "text/html; charset=utf-8",
      "application/octet-stream",
      "image/jpg",
      "application/json",
    ]) {
      const google = fake();
      const res = await send(
        await postImage(bytes("<svg onload=alert(1)>"), { "content-type": contentType }),
        { google },
      );
      expect(res.status, contentType).toBe(400);
      expect((await jsonBody(res))["code"], contentType).toBe("invalid_request");
      expectSecurityHeaders(res);
      expect(google.calls, contentType).toHaveLength(0);
    }

    const google = fake();
    const res = await send(await postImage(PNG, {}), { google });
    expect(res.status).toBe(400);
    expect(google.calls).toHaveLength(0);
  });

  it("rejects_an_empty_image_with_400", async () => {
    const google = fake();
    const res = await send(await postImage(new Uint8Array(0), { "content-type": "image/png" }), {
      google,
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res))["code"]).toBe("invalid_request");
    expect(google.calls).toHaveLength(0);
  });

  it("allows_exactly_10_mib_and_refuses_one_byte_more_with_413_before_reading", async () => {
    const exact = new Uint8Array(MAX_ATTACHMENT_BYTES);
    const google = fake([
      findAnswer([ATT_FOLDER]),
      uploaded("big", "big.png", "image/png", MAX_ATTACHMENT_BYTES),
    ]);
    const ok = await send(await postImage(exact, { "content-type": "image/png" }), { google });
    expect(ok.status).toBe(201);
    expect((await jsonBody(ok))["size"]).toBe(MAX_ATTACHMENT_BYTES);

    let pulled = 0;
    const lying = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const googleLarge = fake();
    const tooLarge = await send(
      await postImage(lying, {
        "content-type": "image/png",
        "content-length": String(MAX_ATTACHMENT_BYTES + 1),
      }),
      { google: googleLarge },
    );
    expect(tooLarge.status).toBe(413);
    expect((await jsonBody(tooLarge))["code"]).toBe("too_large");
    expectSecurityHeaders(tooLarge);
    expect(googleLarge.calls).toHaveLength(0);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("reads_a_body_without_content_length_up_to_the_cap_then_uploads_or_refuses", async () => {
    const google = fake([findAnswer([ATT_FOLDER]), uploaded("img-6", "c.gif", "image/gif", 9)]);
    const payload = bytes("GIF89a...");
    const res = await send(
      await postImage(streamOf(payload, 2), { "content-type": "image/gif", "x-filename": "c" }),
      { google },
    );
    expect(res.status).toBe(201);
    const upload = uploadCall(google);
    expect(upload.body).toEqual(
      multipart(
        boundaryOf(upload),
        { name: "c.gif", mimeType: "image/gif", parents: ["att-folder"] },
        "image/gif",
        payload,
      ),
    );

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const googleLarge = fake();
    const large = await send(await postImage(endless, { "content-type": "image/gif" }), {
      google: googleLarge,
    });
    expect(large.status).toBe(413);
    expect(googleLarge.calls).toHaveLength(0);
    // Reading stopped right after the cap: 10 MiB / 64 KiB = 160 chunks, plus the one over it.
    expect(pulled).toBeLessThanOrEqual(162);
  });

  it("streams_a_body_with_content_length_to_drive_without_reading_it_first", async () => {
    const payload = new Uint8Array(512 * 1024).map((_, i) => i % 251);
    const chunk = 4096;
    let pulled = 0;
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= payload.length) return controller.close();
        pulled++;
        controller.enqueue(payload.slice(offset, offset + chunk));
        offset += chunk;
      },
    });
    const inner = fake([findAnswer([ATT_FOLDER]), uploaded("img-7", "s.png", "image/png", 0)]);
    const pulledAtUpload: Array<number> = [];
    const google = spying(inner, () => pulledAtUpload.push(pulled));
    const res = await send(
      await postImage(source, {
        "content-type": "image/png",
        "content-length": String(payload.length),
      }),
      { google },
    );

    expect(res.status).toBe(201);
    // When Drive is asked (find, then upload), the body has barely been touched.
    expect(pulledAtUpload).toHaveLength(2);
    expect(pulledAtUpload[1]!).toBeLessThan(payload.length / chunk / 2);
    const upload = uploadCall(inner);
    const boundary = boundaryOf(upload);
    expect(boundary).toMatch(/^markyard-7f3c9a1e5b2d4086-[0-9a-f]{32}$/);
    expect(upload.body).toEqual(
      multipart(
        boundary,
        { name: "image-20270115-080000.png", mimeType: "image/png", parents: ["att-folder"] },
        "image/png",
        payload,
      ),
    );
  });

  it("needs_a_session_and_the_same_origin", async () => {
    const google = fake();
    const res = await send(
      await postImage(PNG, { "content-type": "image/png" }, { cookie: null }),
      {
        google,
      },
    );
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["code"]).toBe("unauthenticated");

    const cross = await send(
      await postImage(PNG, { "content-type": "image/png" }, { origin: "https://evil.test" }),
      { google },
    );
    expect(cross.status).toBe(403);
    expect((await jsonBody(cross))["code"]).toBe("forbidden");
    expect(google.calls).toHaveLength(0);
  });

  it("maps_drive_failures_of_the_folder_search_and_the_upload", async () => {
    const cases: ReadonlyArray<
      readonly [label: string, routes: ReadonlyArray<R>, status: number, code: string]
    > = [
      ["search 401", [["GET", FIND, json(401, {})]], 401, "unauthenticated"],
      ["search 429", [["GET", FIND, json(429, {}, { "retry-after": "7" })]], 429, "rate_limited"],
      ["search 500", [["GET", FIND, json(500, {})]], 502, "upstream_error"],
      ["search unreachable", [["GET", FIND, unreachable()]], 502, "upstream_error"],
      [
        "create 403",
        [findAnswer([]), ["POST", `${V3}?fields=`, json(403, { error: { errors: [] } })]],
        502,
        "upstream_error",
      ],
      [
        "upload 401",
        [findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(401, {})]],
        401,
        "unauthenticated",
      ],
      ["upload 404", [findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(404, {})]], 404, "not_found"],
      [
        "upload 413",
        [findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(413, {})]],
        502,
        "upstream_error",
      ],
      [
        "upload rate limit",
        [
          findAnswer([ATT_FOLDER]),
          ["POST", UPLOAD, json(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } })],
        ],
        429,
        "rate_limited",
      ],
      [
        "upload 503",
        [findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(503, {})]],
        502,
        "upstream_error",
      ],
      [
        "upload bad json",
        [findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(200, { name: "x" })]],
        502,
        "upstream_error",
      ],
      [
        "upload odd id",
        [findAnswer([ATT_FOLDER]), ["POST", UPLOAD, json(200, { id: "../x" })]],
        502,
        "upstream_error",
      ],
    ];
    for (const [label, routes, status, code] of cases) {
      const google = fake(routes);
      const res = await send(await postImage(PNG, { "content-type": "image/png" }), { google });
      expect(res.status, label).toBe(status);
      expect((await jsonBody(res))["code"], label).toBe(code);
      expectSecurityHeaders(res);
      if (status === 401) expect(setCookies(res), label).toEqual([CLEAR_SESSION]);
      if (label === "search 429") expect(res.headers.get("retry-after")).toBe("7");
      if (label === "upload rate limit") expect(res.headers.get("retry-after")).toBe("5");
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/files/{id}/blob
// ---------------------------------------------------------------------------

const blobMeta = (
  id: string,
  mimeType: string,
  size: number | undefined,
  parents: ReadonlyArray<string>,
  trashed = false,
): R => [
  "GET",
  `${V3}/${id}?fields=id,mimeType,size`,
  json(200, {
    id,
    mimeType,
    ...(size === undefined ? {} : { size: String(size) }),
    trashed,
    parents,
  }),
];

const folderMeta = (f: ReturnType<typeof folder>): R => [
  "GET",
  `${V3}/${f.id}?fields=id,name`,
  json(200, f),
];

const media = (id: string, answer: Scripted): R => ["GET", `${V3}/${id}?alt=media`, answer];

const getBlob = async (id: string, google: FakeGoogle): Promise<Response> =>
  send(get(`/api/files/${id}/blob`, { cookie: await signedInCookie() }), { google });

describe("GET /api/files/{id}/blob", () => {
  it("streams_an_image_in_the_subtree_inline_with_private_caching", async () => {
    const google = fake([
      blobMeta("img-1", "image/png", PNG.length, ["att-folder"]),
      folderMeta(ATT_FOLDER),
      media("img-1", { status: 200, body: streamOf(PNG, 3) }),
    ]);
    const res = await getBlob("img-1", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600, no-transform");
    expectSecurityHeaders(res);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    expect(google.calls.map((c) => c.url)).toEqual([
      `${V3}/img-1?fields=id,mimeType,size,trashed,parents`,
      `${V3}/att-folder?fields=id,name,mimeType,modifiedTime,trashed,parents`,
      `${V3}/img-1?alt=media`,
    ]);
    for (const call of google.calls) expect(call.headers.get("authorization")).toBe(`Bearer ${AT}`);
  });

  it("answers_before_drives_body_is_read_and_passes_it_through_untouched", async () => {
    const payload = new Uint8Array(256 * 1024).map((_, i) => (i * 7) % 256);
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
      blobMeta("img-1", "image/jpeg", payload.length, ["root-id"]),
      media("img-1", { status: 200, body: source }),
    ]);
    const res = await getBlob("img-1", google);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(pulled).toBeLessThan(payload.length / 1024 / 2);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    // A file directly under the root needs no ancestor lookup.
    expect(google.calls).toHaveLength(2);
  });

  it("is_404_outside_the_root_subtree_without_a_media_call", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
      [
        "foreign folder",
        [
          blobMeta("img-1", "image/png", 3, ["elsewhere"]),
          folderMeta(folder("elsewhere", "x", [])),
        ],
      ],
      [
        "under a trashed folder",
        [
          blobMeta("img-1", "image/png", 3, ["att-folder"]),
          folderMeta(folder("att-folder", "_attachments", ["root-id"], true)),
        ],
      ],
      ["no parents", [blobMeta("img-1", "image/png", 3, [])]],
      [
        "parent is not a folder",
        [
          blobMeta("img-1", "image/png", 3, ["doc-1"]),
          [
            "GET",
            `${V3}/doc-1?fields=id,name`,
            json(200, { ...folder("doc-1", "n.md", ["root-id"]), mimeType: "text/markdown" }),
          ],
        ],
      ],
    ];
    for (const [label, routes] of cases) {
      const google = fake(routes);
      const res = await getBlob("img-1", google);
      expect(res.status, label).toBe(404);
      expect((await jsonBody(res))["code"], label).toBe("not_found");
      expect(google.callsContaining("alt=media"), label).toHaveLength(0);
      expect(google.unexpected, label).toEqual([]);
    }
  });

  it("is_404_for_trashed_folders_and_google_files_without_a_media_call", async () => {
    for (const [label, route] of [
      ["trashed", blobMeta("img-1", "image/png", 3, ["root-id"], true)],
      ["folder", blobMeta("img-1", FOLDER_MIME, undefined, ["root-id"])],
      [
        "google doc",
        blobMeta("img-1", "application/vnd.google-apps.document", undefined, ["root-id"]),
      ],
      [
        "shortcut",
        blobMeta("img-1", "application/vnd.google-apps.shortcut", undefined, ["root-id"]),
      ],
    ] as const) {
      const google = fake([route]);
      const res = await getBlob("img-1", google);
      expect(res.status, label).toBe(404);
      expect(google.calls, label).toHaveLength(1);
    }
  });

  it("is_400_for_a_non_allowlisted_type_inside_the_subtree", async () => {
    for (const mime of ["image/svg+xml", "text/html", "application/pdf", "text/markdown"]) {
      const google = fake([blobMeta("img-1", mime, 3, ["root-id"])]);
      const res = await getBlob("img-1", google);
      expect(res.status, mime).toBe(400);
      expect((await jsonBody(res))["code"], mime).toBe("invalid_request");
      expect(google.callsContaining("alt=media"), mime).toHaveLength(0);
    }
  });

  it("allows_exactly_10_mib_and_refuses_more_with_413_a_missing_size_is_502", async () => {
    const ok = fake([
      blobMeta("img-1", "image/gif", MAX_ATTACHMENT_BYTES, ["root-id"]),
      media("img-1", { status: 200, body: bytes("GIF") }),
    ]);
    expect((await getBlob("img-1", ok)).status).toBe(200);

    const large = fake([blobMeta("img-1", "image/gif", MAX_ATTACHMENT_BYTES + 1, ["root-id"])]);
    const res = await getBlob("img-1", large);
    expect(res.status).toBe(413);
    expect((await jsonBody(res))["code"]).toBe("too_large");
    expect(large.callsContaining("alt=media")).toHaveLength(0);

    const noSize = fake([blobMeta("img-1", "image/gif", undefined, ["root-id"])]);
    expect((await getBlob("img-1", noSize)).status).toBe(502);
  });

  it("is_404_for_an_invalid_id_without_any_drive_call", async () => {
    for (const id of ["a%27", "a.b", "a%41", ".."]) {
      const google = fake();
      const res = await getBlob(id, google);
      expect(res.status, id).toBe(404);
      expect(google.calls, id).toHaveLength(0);
    }
  });

  it("needs_a_session", async () => {
    const google = fake();
    const res = await send(get("/api/files/img-1/blob"), { google });
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it("maps_drive_failures_of_the_metadata_and_media_calls", async () => {
    const meta = `${V3}/img-1?fields=`;
    const okMeta = blobMeta("img-1", "image/png", 3, ["root-id"]);
    const cases: ReadonlyArray<
      readonly [label: string, routes: ReadonlyArray<R>, status: number, code: string]
    > = [
      ["meta 401", [["GET", meta, json(401, {})]], 401, "unauthenticated"],
      ["meta 404", [["GET", meta, json(404, {})]], 404, "not_found"],
      ["meta 429", [["GET", meta, json(429, {}, { "retry-after": "3" })]], 429, "rate_limited"],
      ["meta 500", [["GET", meta, json(500, {})]], 502, "upstream_error"],
      ["meta garbage", [["GET", meta, json(200, { id: 1 })]], 502, "upstream_error"],
      ["media 401", [okMeta, media("img-1", json(401, {}))], 401, "unauthenticated"],
      ["media 404", [okMeta, media("img-1", json(404, {}))], 404, "not_found"],
      ["media 429", [okMeta, media("img-1", json(429, {}))], 429, "rate_limited"],
      ["media unreachable", [okMeta, media("img-1", unreachable())], 502, "upstream_error"],
    ];
    for (const [label, routes, status, code] of cases) {
      const google = fake(routes);
      const res = await getBlob("img-1", google);
      expect(res.status, label).toBe(status);
      expect((await jsonBody(res))["code"], label).toBe(code);
      expect(res.headers.get("cache-control"), label).toBe(NO_STORE_NO_TRANSFORM);
      if (status === 401) expect(setCookies(res), label).toEqual([CLEAR_SESSION]);
      if (label === "meta 429") expect(res.headers.get("retry-after")).toBe("3");
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/attachments
// ---------------------------------------------------------------------------

describe("GET /api/attachments", () => {
  const LIST = "trashed%3Dfalse&pageSize=1000";
  const listAnswer = (files: ReadonlyArray<unknown>, nextPageToken?: string): Answer =>
    json(200, nextPageToken === undefined ? { files } : { files, nextPageToken });
  const file = (
    id: string,
    name: string,
    mimeType: string,
    modifiedTime: string,
    size?: unknown,
  ) => ({ id, name, mimeType, modifiedTime, ...(size === undefined ? {} : { size }) });
  const list = async (google: FakeGoogle, cookie?: string | null): Promise<Response> =>
    send(
      get(
        "/api/attachments",
        cookie === null ? {} : { cookie: cookie ?? (await signedInCookie()) },
      ),
      { google },
    );

  it("answers_an_empty_list_without_creating_the_folder_when_there_is_none", async () => {
    const google = fake([findAnswer([folder("gone", "_attachments", ["root-id"], true)])]);
    const res = await list(google);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe(NO_STORE_NO_TRANSFORM);
    expect(await res.json()).toEqual({ folderId: null, attachments: [] });
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.method).toBe("GET");
    const q = new URL(google.calls[0]!.url).searchParams.get("q");
    expect(q).toBe(
      `'root-id' in parents and name='_attachments' and mimeType='${FOLDER_MIME}' and trashed=false`,
    );
  });

  it("lists_only_allowlisted_images_newest_first_across_pages", async () => {
    const google = fake([
      findAnswer([ATT_FOLDER]),
      [
        "GET",
        "pageToken=p2",
        listAnswer([
          file("b-old", "old.gif", "image/gif", "2026-11-01T00:00:00.000Z", "7"),
          file("same-b", "b.png", "image/png", "2026-11-21T00:00:00.000Z", "1"),
        ]),
      ],
      [
        "GET",
        LIST,
        listAnswer(
          [
            file("a-new", "new.png", "image/png", "2026-11-22T00:00:00.000Z", "12345"),
            file("svg", "logo.svg", "image/svg+xml", "2026-11-23T00:00:00.000Z", "10"),
            file("html", "page.html", "text/html", "2026-11-23T00:00:00.000Z", "10"),
            file("md", "note.md", "text/markdown", "2026-11-23T00:00:00.000Z", "10"),
            file("same-a", "a.jpg", "image/jpeg", "2026-11-21T00:00:00.000Z"),
            file("weird", "w.webp", "image/webp", "2026-11-20T00:00:00.000Z", "-1"),
          ],
          "p2",
        ),
      ],
    ]);
    const res = await list(google);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folderId: "att-folder",
      attachments: [
        {
          id: "a-new",
          name: "new.png",
          mimeType: "image/png",
          size: 12345,
          modifiedTime: "2026-11-22T00:00:00.000Z",
          url: "/api/files/a-new/blob",
        },
        {
          id: "same-a",
          name: "a.jpg",
          mimeType: "image/jpeg",
          modifiedTime: "2026-11-21T00:00:00.000Z",
          url: "/api/files/same-a/blob",
        },
        {
          id: "same-b",
          name: "b.png",
          mimeType: "image/png",
          size: 1,
          modifiedTime: "2026-11-21T00:00:00.000Z",
          url: "/api/files/same-b/blob",
        },
        {
          id: "weird",
          name: "w.webp",
          mimeType: "image/webp",
          modifiedTime: "2026-11-20T00:00:00.000Z",
          url: "/api/files/weird/blob",
        },
        {
          id: "b-old",
          name: "old.gif",
          mimeType: "image/gif",
          size: 7,
          modifiedTime: "2026-11-01T00:00:00.000Z",
          url: "/api/files/b-old/blob",
        },
      ],
    });
    const listCalls = google.calls.filter((c) => c.url.includes("pageSize=1000"));
    expect(listCalls).toHaveLength(2);
    const params = new URL(listCalls[0]!.url).searchParams;
    expect(params.get("q")).toBe("'att-folder' in parents and trashed=false");
    expect(params.get("fields")).toBe(
      "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size,trashed,appProperties)",
    );
    expect(listCalls[0]!.headers.get("authorization")).toBe(`Bearer ${AT}`);
    expect(google.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("filters_by_upload_time_in_the_drive_query_and_answers_created_time", async () => {
    const google = fake([
      findAnswer([ATT_FOLDER]),
      [
        "GET",
        "pageSize=1000",
        listAnswer([
          {
            ...file("a", "a.png", "image/png", "2026-11-02T09:00:00.000Z", "3"),
            createdTime: "2026-11-01T08:00:00.000Z",
          },
        ]),
      ],
    ]);
    const res = await send(
      get(
        "/api/attachments?uploadedFrom=2026-11-01T00:00:00.000Z&uploadedBefore=2026-11-02T00:00:00Z",
        { cookie: await signedInCookie() },
      ),
      { google },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folderId: "att-folder",
      attachments: [
        {
          id: "a",
          name: "a.png",
          mimeType: "image/png",
          size: 3,
          modifiedTime: "2026-11-02T09:00:00.000Z",
          createdTime: "2026-11-01T08:00:00.000Z",
          url: "/api/files/a/blob",
        },
      ],
    });
    const listCall = google.calls.find((c) => c.url.includes("pageSize=1000"))!;
    expect(new URL(listCall.url).searchParams.get("q")).toBe(
      "'att-folder' in parents and trashed=false and createdTime >= '2026-11-01T00:00:00.000Z' and createdTime < '2026-11-02T00:00:00.000Z'",
    );
  });

  it("rejects_a_malformed_upload_bound_with_400_and_no_drive_call", async () => {
    for (const bad of [
      "uploadedFrom=2026-11-01",
      "uploadedBefore=2026-11-01T00:00:00Z'%20or%20name%20contains%20'x",
      "uploadedFrom=2026-13-40T00:00:00Z",
      "uploadedFrom=",
    ]) {
      const google = fake();
      const res = await send(get(`/api/attachments?${bad}`, { cookie: await signedInCookie() }), {
        google,
      });
      expect(res.status, bad).toBe(400);
      expect((await jsonBody(res))["code"], bad).toBe("invalid_request");
      expect(google.calls, bad).toHaveLength(0);
    }
  });

  it("needs_a_session", async () => {
    const google = fake();
    const res = await list(google, null);
    expect(res.status).toBe(401);
    expect((await jsonBody(res))["code"]).toBe("unauthenticated");
    expect(google.calls).toHaveLength(0);
  });

  it("maps_drive_failures_of_the_folder_search_and_the_listing", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<R>, number, string]> = [
      ["find 401", [["GET", FIND, json(401, {})]], 401, "unauthenticated"],
      ["find 429", [["GET", FIND, json(429, {}, { "retry-after": "4" })]], 429, "rate_limited"],
      ["find unreachable", [["GET", FIND, unreachable()]], 502, "upstream_error"],
      ["list 500", [findAnswer([ATT_FOLDER]), ["GET", LIST, json(500, {})]], 502, "upstream_error"],
      [
        "list garbage",
        [findAnswer([ATT_FOLDER]), ["GET", LIST, json(200, { files: [{ id: 1 }] })]],
        502,
        "upstream_error",
      ],
    ];
    for (const [label, routes, status, code] of cases) {
      const res = await list(fake(routes));
      expect(res.status, label).toBe(status);
      expect((await jsonBody(res))["code"], label).toBe(code);
    }
  });

  it("deletes_an_attachment_through_delete_api_files_id_by_trashing_it", async () => {
    const google = fake([
      [
        "GET",
        `${V3}/a-new?fields=`,
        json(200, {
          id: "a-new",
          name: "new.png",
          mimeType: "image/png",
          modifiedTime: "2026-11-22T00:00:00.000Z",
          trashed: false,
          parents: ["att-folder"],
        }),
      ],
      ["PATCH", `${V3}/a-new`, json(200, {})],
    ]);
    const res = await send(
      request("DELETE", "/api/files/a-new", { cookie: await signedInCookie() }),
      { google },
    );
    expect(res.status).toBe(204);
    const patch = google.calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch!.text)).toEqual({ trashed: true });
  });
});

// ---------------------------------------------------------------------------
// GET /api/files/{id}/thumb
// ---------------------------------------------------------------------------

const THUMB_LINK = "https://lh3.googleusercontent.com/drive-storage/AJQWtBabc=s220";
const THUMB_FETCH = "https://lh3.googleusercontent.com/drive-storage/AJQWtBabc=s";

const thumbMeta = (
  id: string,
  mimeType: string,
  size: number,
  parents: ReadonlyArray<string>,
  thumbnailLink?: string,
): R => [
  "GET",
  `${V3}/${id}?fields=id,mimeType,size,trashed,parents,thumbnailLink`,
  json(200, {
    id,
    mimeType,
    size: String(size),
    trashed: false,
    parents,
    ...(thumbnailLink === undefined ? {} : { thumbnailLink }),
  }),
];

const JPEG_THUMB = new Uint8Array([0xff, 0xd8, 0xff, 9, 9]);

const getThumb = async (id: string, google: FakeGoogle, query = ""): Promise<Response> =>
  send(get(`/api/files/${id}/thumb${query}`, { cookie: await signedInCookie() }), { google });

describe("GET /api/files/{id}/thumb", () => {
  it("streams_drives_thumbnail_resized_with_the_users_token_and_private_caching", async () => {
    const google = fake([
      thumbMeta("img-1", "image/png", PNG.length, ["att-folder"], THUMB_LINK),
      folderMeta(ATT_FOLDER),
      [
        "GET",
        THUMB_FETCH,
        { status: 200, headers: { "content-type": "image/jpeg" }, body: JPEG_THUMB },
      ],
    ]);
    const res = await getThumb("img-1", google, "?size=800");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600, no-transform");
    expect(res.headers.get("x-thumbnail-source")).toBe("thumbnail");
    expectSecurityHeaders(res);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_THUMB);
    expect(google.calls.map((c) => c.url)).toEqual([
      `${V3}/img-1?fields=id,mimeType,size,trashed,parents,thumbnailLink`,
      `${V3}/att-folder?fields=id,name,mimeType,modifiedTime,trashed,parents`,
      "https://lh3.googleusercontent.com/drive-storage/AJQWtBabc=s800",
    ]);
    for (const call of google.calls) expect(call.headers.get("authorization")).toBe(`Bearer ${AT}`);
  });

  it("defaults_to_400_px_and_clamps_the_size", async () => {
    for (const [query, expected] of [
      ["", "=s400"],
      ["?size=5", "=s32"],
      ["?size=99999", "=s1600"],
    ] as const) {
      const google = fake([
        thumbMeta("img-1", "image/png", 3, ["root-id"], THUMB_LINK),
        ["GET", THUMB_FETCH, { status: 200, headers: { "content-type": "image/png" }, body: PNG }],
      ]);
      expect((await getThumb("img-1", google, query)).status, query).toBe(200);
      expect(google.calls.at(-1)?.url.endsWith(expected), query).toBe(true);
    }
  });

  it("is_400_for_a_size_that_is_not_a_whole_number_without_any_drive_call", async () => {
    for (const query of ["?size=", "?size=1.5", "?size=-4", "?size=abc"]) {
      const google = fake();
      const res = await getThumb("img-1", google, query);
      expect(res.status, query).toBe(400);
      expect(google.calls, query).toHaveLength(0);
    }
  });

  it("serves_the_original_while_drive_has_no_usable_thumbnail", async () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
      ["no link yet", []],
      ["foreign host", []],
      ["thumb 403", [["GET", THUMB_FETCH, json(403, {})]]],
      ["thumb html", [["GET", THUMB_FETCH, text(200, "<html>", { "content-type": "text/html" })]]],
      ["thumb unreachable", [["GET", THUMB_FETCH, unreachable()]]],
    ];
    for (const [label, extra] of cases) {
      const link =
        label === "no link yet"
          ? undefined
          : label === "foreign host"
            ? "https://evil.test/drive-storage/x=s220"
            : THUMB_LINK;
      const google = fake([
        thumbMeta("img-1", "image/png", PNG.length, ["root-id"], link),
        ...extra,
        media("img-1", { status: 200, body: streamOf(PNG) }),
      ]);
      const res = await getThumb("img-1", google);
      expect(res.status, label).toBe(200);
      expect(res.headers.get("content-type"), label).toBe("image/png");
      expect(res.headers.get("x-thumbnail-source"), label).toBe("original");
      expect(new Uint8Array(await res.arrayBuffer()), label).toEqual(PNG);
      expect(google.callsContaining("evil.test"), label).toHaveLength(0);
    }
  });

  it("keeps_the_blob_routes_subtree_and_type_checks", async () => {
    const outside = fake([
      thumbMeta("img-1", "image/png", 3, ["elsewhere"], THUMB_LINK),
      ["GET", `${V3}/elsewhere?fields=id,name`, json(200, folder("elsewhere", "x", []))],
    ]);
    expect((await getThumb("img-1", outside)).status).toBe(404);
    expect(outside.callsContaining("googleusercontent")).toHaveLength(0);

    const svg = fake([thumbMeta("img-1", "image/svg+xml", 3, ["root-id"], THUMB_LINK)]);
    expect((await getThumb("img-1", svg)).status).toBe(400);
    expect(svg.callsContaining("googleusercontent")).toHaveLength(0);
  });

  it("needs_a_session", async () => {
    const google = fake();
    expect((await send(get("/api/files/img-1/thumb"), { google })).status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attachment tags (`appProperties`): GET /api/attachments, GET /:id, PATCH /:id/tags
// ---------------------------------------------------------------------------

const ATT_FIELDS = "id,name,mimeType,modifiedTime,createdTime,size,trashed,parents,appProperties";

const attachmentMetaRoute = (id: string, overrides: Record<string, unknown> = {}): R => [
  "GET",
  `${V3}/${id}?fields=${ATT_FIELDS}`,
  json(200, {
    id,
    name: "y2k.png",
    mimeType: "image/png",
    modifiedTime: "2026-11-20T10:00:00.000Z",
    createdTime: "2026-11-19T10:00:00.000Z",
    size: "420",
    trashed: false,
    parents: ["att-folder"],
    ...overrides,
  }),
];

describe("attachment tags via Drive appProperties", () => {
  it("decodes_sorted_tag_appProperties_in_list_attachments_and_ignores_unrelated_keys", async () => {
    const google = fake([
      findAnswer([ATT_FOLDER]),
      [
        "GET",
        "pageSize=1000",
        json(200, {
          files: [
            {
              id: "img-1",
              name: "hero.png",
              mimeType: "image/png",
              modifiedTime: "2026-11-20T10:00:00.000Z",
              createdTime: "2026-11-19T10:00:00.000Z",
              size: "123",
              trashed: false,
              appProperties: {
                "tag_y2k%20aesthetic": "Y2K aesthetic",
                tag_cybercore: "Cybercore",
                otherKey: "ignored",
              },
            },
            {
              id: "img-2",
              name: "plain.png",
              mimeType: "image/png",
              modifiedTime: "2026-11-18T10:00:00.000Z",
              trashed: false,
              appProperties: { otherKey: "still-ignored" },
            },
          ],
        }),
      ],
    ]);

    const res = await send(get("/api/attachments", { cookie: await signedInCookie() }), { google });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folderId: "att-folder",
      attachments: [
        {
          id: "img-1",
          name: "hero.png",
          mimeType: "image/png",
          size: 123,
          modifiedTime: "2026-11-20T10:00:00.000Z",
          createdTime: "2026-11-19T10:00:00.000Z",
          url: "/api/files/img-1/blob",
          tags: ["Cybercore", "Y2K aesthetic"],
        },
        {
          id: "img-2",
          name: "plain.png",
          mimeType: "image/png",
          modifiedTime: "2026-11-18T10:00:00.000Z",
          url: "/api/files/img-2/blob",
        },
      ],
    });
  });

  it("gets_one_attachment_with_tags_and_enforces_vault_subtree_isolation", async () => {
    const google = fake([
      attachmentMetaRoute("img-1", {
        appProperties: { "tag_wabi-sabi": "Wabi-sabi", unrelated: "keep" },
      }),
      folderMeta(ATT_FOLDER),
    ]);
    const res = await send(get("/api/attachments/img-1", { cookie: await signedInCookie() }), {
      google,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "img-1",
      name: "y2k.png",
      mimeType: "image/png",
      size: 420,
      modifiedTime: "2026-11-20T10:00:00.000Z",
      createdTime: "2026-11-19T10:00:00.000Z",
      url: "/api/files/img-1/blob",
      tags: ["Wabi-sabi"],
    });

    const outside = fake([
      attachmentMetaRoute("img-2", { parents: ["elsewhere"] }),
      ["GET", `${V3}/elsewhere?fields=id,name`, json(200, folder("elsewhere", "x", []))],
    ]);
    expect(
      (
        await send(get("/api/attachments/img-2", { cookie: await signedInCookie() }), {
          google: outside,
        })
      ).status,
    ).toBe(404);
  });

  it("patches_tag_appProperties_diffing_removed_keys_as_null_without_touching_other_keys", async () => {
    const google = fake([
      attachmentMetaRoute("img-1", {
        appProperties: {
          tag_old: "old",
          tag_keep: "keep",
          customKey: "preserve-me",
        },
      }),
      folderMeta(ATT_FOLDER),
      [
        "PATCH",
        `${V3}/img-1?fields=${ATT_FIELDS}`,
        json(200, {
          id: "img-1",
          name: "y2k.png",
          mimeType: "image/png",
          modifiedTime: "2026-11-21T10:00:00.000Z",
          createdTime: "2026-11-19T10:00:00.000Z",
          size: "420",
          trashed: false,
          parents: ["att-folder"],
          appProperties: {
            tag_keep: "keep",
            "tag_neo-brutalism": "Neo-brutalism",
            "tag_y2k%20aesthetic": "Y2K aesthetic",
            customKey: "preserve-me",
          },
        }),
      ],
    ]);

    const res = await send(
      request("PATCH", "/api/attachments/img-1/tags", {
        cookie: await signedInCookie(),
        headers: { "content-type": "application/json" },
        body: bytes(
          JSON.stringify({ tags: [" #Neo-brutalism ", "Y2K aesthetic", "keep", "KEEP"] }),
        ),
      }),
      { google },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "img-1",
      name: "y2k.png",
      mimeType: "image/png",
      size: 420,
      modifiedTime: "2026-11-21T10:00:00.000Z",
      createdTime: "2026-11-19T10:00:00.000Z",
      url: "/api/files/img-1/blob",
      tags: ["keep", "Neo-brutalism", "Y2K aesthetic"],
    });

    const patch = google.calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.text)).toEqual({
      appProperties: {
        tag_old: null,
        "tag_neo-brutalism": "Neo-brutalism",
        "tag_y2k%20aesthetic": "Y2K aesthetic",
      },
    });
  });

  it("skips_the_drive_patch_when_tags_are_already_identical", async () => {
    const google = fake([
      attachmentMetaRoute("img-1", {
        appProperties: { tag_design: "design" },
      }),
      folderMeta(ATT_FOLDER),
    ]);
    const res = await send(
      request("PATCH", "/api/attachments/img-1/tags", {
        cookie: await signedInCookie(),
        headers: { "content-type": "application/json" },
        body: bytes(JSON.stringify({ tags: ["#design"] })),
      }),
      { google },
    );
    expect(res.status).toBe(200);
    expect(google.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("rejects_bad_tag_bodies_limits_and_cross_origin_requests", async () => {
    const tooMany = Array.from({ length: 31 }, (_, i) => `t${i}`);
    const tooLong = "a".repeat(65);
    for (const [label, body] of [
      ["bad json", "{"],
      ["not array", JSON.stringify({ tags: "one" })],
      ["non string", JSON.stringify({ tags: [123] })],
      ["control char", JSON.stringify({ tags: ["line\nbreak"] })],
      ["too many", JSON.stringify({ tags: tooMany })],
      ["too long", JSON.stringify({ tags: [tooLong] })],
    ] as const) {
      const google = fake();
      const res = await send(
        request("PATCH", "/api/attachments/img-1/tags", {
          cookie: await signedInCookie(),
          headers: { "content-type": "application/json" },
          body: bytes(body),
        }),
        { google },
      );
      expect(res.status, label).toBe(400);
      expect((await jsonBody(res))["code"], label).toBe("invalid_request");
      expect(google.calls, label).toHaveLength(0);
    }

    const crossOrigin = await send(
      request("PATCH", "/api/attachments/img-1/tags", {
        cookie: await signedInCookie(),
        headers: { "content-type": "application/json", origin: "https://evil.test" },
        body: bytes(JSON.stringify({ tags: ["ok"] })),
      }),
      { google: fake() },
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("normalizes_nested_hashes_idempotently_rejects_format_chars_and_checks_exact_124_byte_multibyte_cap", async () => {
    const exact124 = "é".repeat(15); // "tag_" (4) + 15*"%C3%A9" (90) + 15*2 (30) = 124 bytes
    const exact124Key = `tag_${"%C3%A9".repeat(15)}`;
    const over124 = "é".repeat(16);

    // Format / zero-width / bidi characters and 125+ byte multibyte tags fail with 400.
    for (const bad of ["zero\u200Bwidth", "bidi\u202Eoverride", over124]) {
      const google = fake();
      const res = await send(
        request("PATCH", "/api/attachments/img-1/tags", {
          cookie: await signedInCookie(),
          headers: { "content-type": "application/json" },
          body: bytes(JSON.stringify({ tags: [bad] })),
        }),
        { google },
      );
      expect(res.status, bad).toBe(400);
      expect(google.calls, bad).toHaveLength(0);
    }

    // Exact 124-byte multibyte tag and `# #nested` normalize cleanly and succeed.
    const google = fake([
      attachmentMetaRoute("img-1", { appProperties: {} }),
      folderMeta(ATT_FOLDER),
      [
        "PATCH",
        `${V3}/img-1?fields=${ATT_FIELDS}`,
        json(200, {
          id: "img-1",
          name: "y2k.png",
          mimeType: "image/png",
          modifiedTime: "2026-11-21T10:00:00.000Z",
          trashed: false,
          parents: ["att-folder"],
          appProperties: {
            [exact124Key]: exact124,
            tag_nested: "nested",
          },
        }),
      ],
    ]);
    const res = await send(
      request("PATCH", "/api/attachments/img-1/tags", {
        cookie: await signedInCookie(),
        headers: { "content-type": "application/json" },
        body: bytes(JSON.stringify({ tags: ["# #nested", exact124] })),
      }),
      { google },
    );
    expect(res.status).toBe(200);
    const patch = google.calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.text)).toEqual({
      appProperties: {
        tag_nested: "nested",
        [exact124Key]: exact124,
      },
    });
  });

  it("accounts_for_existing_non_tag_appProperties_in_the_30_key_cap", async () => {
    const google = fake([
      attachmentMetaRoute("img-1", {
        appProperties: { customA: "1", customB: "2" },
      }),
      folderMeta(ATT_FOLDER),
    ]);
    const twentyNine = Array.from({ length: 29 }, (_, i) => `t${i}`);
    const res = await send(
      request("PATCH", "/api/attachments/img-1/tags", {
        cookie: await signedInCookie(),
        headers: { "content-type": "application/json" },
        body: bytes(JSON.stringify({ tags: twentyNine })),
      }),
      { google },
    );
    expect(res.status).toBe(400);
    expect((await jsonBody(res))["code"]).toBe("invalid_request");
    expect(google.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("enforces_subtree_trashed_and_image_type_on_patch_and_maps_drive_400_403", async () => {
    const outside = fake([
      attachmentMetaRoute("img-out", { parents: ["elsewhere"] }),
      ["GET", `${V3}/elsewhere?fields=id,name`, json(200, folder("elsewhere", "x", []))],
    ]);
    expect(
      (
        await send(
          request("PATCH", "/api/attachments/img-out/tags", {
            cookie: await signedInCookie(),
            headers: { "content-type": "application/json" },
            body: bytes(JSON.stringify({ tags: ["ok"] })),
          }),
          { google: outside },
        )
      ).status,
    ).toBe(404);

    const trashed = fake([attachmentMetaRoute("img-del", { trashed: true })]);
    expect(
      (
        await send(
          request("PATCH", "/api/attachments/img-del/tags", {
            cookie: await signedInCookie(),
            headers: { "content-type": "application/json" },
            body: bytes(JSON.stringify({ tags: ["ok"] })),
          }),
          { google: trashed },
        )
      ).status,
    ).toBe(404);

    const svg = fake([
      attachmentMetaRoute("img-svg", { mimeType: "image/svg+xml" }),
      folderMeta(ATT_FOLDER),
    ]);
    expect(
      (
        await send(
          request("PATCH", "/api/attachments/img-svg/tags", {
            cookie: await signedInCookie(),
            headers: { "content-type": "application/json" },
            body: bytes(JSON.stringify({ tags: ["ok"] })),
          }),
          { google: svg },
        )
      ).status,
    ).toBe(400);

    for (const [driveStatus, expectedStatus, expectedCode] of [
      [400, 400, "invalid_request"],
      [403, 403, "forbidden"],
    ] as const) {
      const google = fake([
        attachmentMetaRoute("img-1", { appProperties: {} }),
        folderMeta(ATT_FOLDER),
        ["PATCH", `${V3}/img-1?fields=${ATT_FIELDS}`, json(driveStatus, {})],
      ]);
      const res = await send(
        request("PATCH", "/api/attachments/img-1/tags", {
          cookie: await signedInCookie(),
          headers: { "content-type": "application/json" },
          body: bytes(JSON.stringify({ tags: ["ok"] })),
        }),
        { google },
      );
      expect(res.status, String(driveStatus)).toBe(expectedStatus);
      expect((await jsonBody(res))["code"], String(driveStatus)).toBe(expectedCode);
    }
  });
});
