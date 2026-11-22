// Port of the Rust `core/tests/folders.rs` tests: folder routes at the HTTP seam, with Drive
// replaced by a scripted fake that matches on method and URL fragment.

import { describe, expect, it } from "vite-plus/test";

import {
  AT,
  CLEAR_SESSION,
  FakeGoogle,
  get,
  NEW_AT,
  NOW,
  ORIGIN,
  on,
  request,
  send,
  sessionCookie,
  setCookies,
  storedSession,
  text,
  unreachable,
  type Route,
  type Scripted,
} from "./support/harness.ts";

const FILE_URL = "https://fake.test/drive/v3/files/";
const LIST_URL = "https://fake.test/drive/v3/files?";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Rust `answer` / `answer_with`: a JSON body with only the given headers. */
const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Scripted =>
  text(status, JSON.stringify(body), headers);

/** Rust `Fake::new`: the first route whose method matches and whose URL contains the fragment. */
const fake = (routes: ReadonlyArray<readonly [string, string, Scripted]>): FakeGoogle =>
  new FakeGoogle(routes.map(([m, url, a]): Route => on(m, url, a, { contains: true })));

const silent = (): FakeGoogle => new FakeGoogle();

const callsContaining = (google: FakeGoogle, fragment: string) =>
  google.callsContaining(fragment).map((c) => [c.url, c.headers.get("authorization")] as const);

/** Rust `api_req(path, cookie)`: a GET with `theme=dark; __Host-s=<cookie>` when given. */
const apiReq = (path: string, cookie?: string): Request =>
  get(path, cookie === undefined ? {} : { cookie: `theme=dark; __Host-s=${cookie}` });

const sealed = (exp?: number): Promise<string> => sessionCookie(storedSession(exp));

const getAsSignedIn = async (path: string, google: FakeGoogle): Promise<Response> =>
  send(apiReq(path, await sealed(NOW + 3600)), { google });

const folderJson = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  modifiedTime: "2026-11-01T10:00:00.000Z",
  trashed: false,
});

const rootOk = (): readonly [string, string, Scripted] => [
  "GET",
  `${FILE_URL}root-id`,
  answer(200, folderJson("root-id", "Notes")),
];

const refreshOk = (): readonly [string, string, Scripted] => [
  "POST",
  "https://fake.test/token",
  answer(200, { access_token: NEW_AT, expires_in: 3599, token_type: "Bearer" }),
];

// ---------------------------------------------------------------------------
// GET /api/root
// ---------------------------------------------------------------------------

describe("GET /api/root", () => {
  it("root_returns_the_configured_folder_as_a_node", async () => {
    const google = fake([rootOk()]);
    const res = await getAsSignedIn("/api/root", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      id: "root-id",
      name: "Notes",
      kind: "folder",
      modifiedTime: "2026-11-01T10:00:00.000Z",
    });
    const calls = callsContaining(google, "/drive/v3/files/root-id");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain("fields=id,name,mimeType,modifiedTime,trashed");
    expect(calls[0]![1]).toBe(`Bearer ${AT}`);
    expect(setCookies(res)).toEqual([]);
  });

  it("root_without_session_is_401_and_calls_nothing", async () => {
    const google = silent();
    const res = await send(apiReq("/api/root"), { google });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthenticated", message: "Not signed in" });
    expect(google.calls).toEqual([]);
  });

  it("root_with_expired_token_refreshes_and_sets_cookie", async () => {
    const google = fake([refreshOk(), rootOk()]);
    const res = await send(apiReq("/api/root", await sealed(NOW + 59)), { google });

    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.startsWith("__Host-s=")).toBe(true);
    const calls = callsContaining(google, "/drive/v3/files/root-id");
    expect(calls[0]![1]).toBe(`Bearer ${NEW_AT}`);
  });

  it("root_with_a_failed_refresh_is_502_and_calls_no_drive", async () => {
    const google = fake([["POST", "https://fake.test/token", answer(500, {})]]);
    const res = await send(apiReq("/api/root", await sealed(NOW + 59)), { google });

    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("upstream_error");
    expect(callsContaining(google, "/drive/v3/")).toEqual([]);
  });

  it("root_drive_404_is_not_found", async () => {
    const google = fake([["GET", `${FILE_URL}root-id`, answer(404, { error: { code: 404 } })]]);
    const res = await getAsSignedIn("/api/root", google);

    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("not_found");
  });

  it("root_drive_500_or_transport_error_is_upstream_error", async () => {
    const cases: Array<[string, Scripted]> = [
      ["500", answer(500, { error: { code: 500 } })],
      ["garbage body", answer(200, "not a file")],
      ["transport", unreachable("connection reset")],
    ];
    for (const [label, scripted] of cases) {
      const google = fake([["GET", `${FILE_URL}root-id`, scripted]]);
      const res = await getAsSignedIn("/api/root", google);

      expect(res.status, label).toBe(502);
      expect(((await res.json()) as Record<string, unknown>)["code"], label).toBe("upstream_error");
    }
  });

  it("root_drive_429_is_rate_limited_with_retry_after", async () => {
    const google = fake([["GET", `${FILE_URL}root-id`, answer(429, {}, { "retry-after": "7" })]]);
    const res = await getAsSignedIn("/api/root", google);

    expect(res.status).toBe(429);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("root_that_is_a_file_or_trashed_is_returned_as_is", async () => {
    // The root route reports what ROOT_FOLDER_ID points at; the children call rejects a non-folder.
    const google = fake([
      [
        "GET",
        `${FILE_URL}root-id`,
        answer(200, {
          id: "root-id",
          name: "Notes.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-11-01T10:00:00.000Z",
          trashed: true,
        }),
      ],
    ]);
    const res = await getAsSignedIn("/api/root", google);

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["kind"]).toBe("markdown");
  });
});

// ---------------------------------------------------------------------------
// GET /api/folders/{id}/children
// ---------------------------------------------------------------------------

const fileJson = (id: string, name: string, mime: string): Record<string, unknown> => ({
  id,
  name,
  mimeType: mime,
  modifiedTime: "2026-11-02T08:30:00.000Z",
});

const nodeJson = (id: string, name: string, kind: string): Record<string, unknown> => ({
  id,
  name,
  kind,
  modifiedTime: "2026-11-02T08:30:00.000Z",
});

const folder1Ok = (): readonly [string, string, Scripted] => [
  "GET",
  `${FILE_URL}folder-1`,
  answer(200, folderJson("folder-1", "Projects")),
];

const listAnswering = (scripted: Scripted): readonly [string, string, Scripted] => [
  "GET",
  LIST_URL,
  scripted,
];

/** Rust `query_of`: the decoded `key=value` pairs of a URL's query, in order. */
const queryOf = (url: string): Array<[string, string]> => {
  const q = url.indexOf("?");
  expect(q, "url has a query").toBeGreaterThanOrEqual(0);
  return [...new URLSearchParams(url.slice(q + 1))];
};

const param = (query: ReadonlyArray<[string, string]>, name: string): string | undefined =>
  query.find(([k]) => k === name)?.[1];

const codeOf = async (res: Response): Promise<unknown> =>
  ((await res.json()) as Record<string, unknown>)["code"];

describe("GET /api/folders/{id}/children", () => {
  it("children_follow_pagination_and_return_every_child", async () => {
    const google = fake([
      folder1Ok(),
      ["GET", "pageToken=p2", answer(200, { files: [fileJson("c", "Sub", FOLDER_MIME)] })],
      listAnswering(
        answer(200, {
          files: [
            fileJson("a", "A.md", "text/markdown"),
            fileJson("b", "b.pdf", "application/pdf"),
          ],
          nextPageToken: "p2",
        }),
      ),
    ]);
    const res = await getAsSignedIn("/api/folders/folder-1/children", google);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      nodes: [
        nodeJson("a", "A.md", "markdown"),
        nodeJson("b", "b.pdf", "other"),
        nodeJson("c", "Sub", "folder"),
      ],
    });

    const lists = callsContaining(google, LIST_URL);
    expect(lists).toHaveLength(2);
    const first = queryOf(lists[0]![0]);
    expect(param(first, "q")).toBe("'folder-1' in parents and trashed=false");
    expect(param(first, "pageSize")).toBe("1000");
    expect(param(first, "fields")).toBe("nextPageToken,files(id,name,mimeType,modifiedTime)");
    expect(param(first, "pageToken")).toBeUndefined();
    expect(param(first, "supportsAllDrives")).toBeUndefined();
    expect(param(first, "includeItemsFromAllDrives")).toBeUndefined();
    const second = queryOf(lists[1]![0]);
    expect(param(second, "pageToken")).toBe("p2");
    expect(param(second, "q")).toBe(param(first, "q"));
    const bearer = `Bearer ${AT}`;
    expect(
      [...lists, ...callsContaining(google, "/drive/v3/files/folder-1")].every(
        ([, auth]) => auth === bearer,
      ),
    ).toBe(true);
  });

  it("kind_rules", async () => {
    const google = fake([
      folder1Ok(),
      listAnswering(
        answer(200, {
          files: [
            fileJson("1", "Note.MD", "text/markdown"),
            fileJson("2", "readme.md", "application/vnd.google-apps.document"),
            fileJson("3", "a.txt", "text/plain"),
            fileJson("4", "link", "application/vnd.google-apps.shortcut"),
            fileJson("5", "Docs", FOLDER_MIME),
            fileJson("6", "plain.md", "application/octet-stream"),
            fileJson("7", "md", "text/markdown"),
          ],
        }),
      ),
    ]);
    const res = await getAsSignedIn("/api/folders/folder-1/children", google);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ kind: string }> };
    expect(body.nodes.map((n) => n.kind)).toEqual([
      "markdown",
      "other",
      "other",
      "other",
      "folder",
      "markdown",
      "other",
    ]);
  });

  it("children_of_an_empty_folder_is_an_empty_list", async () => {
    const google = fake([folder1Ok(), listAnswering(answer(200, { files: [] }))]);
    const res = await getAsSignedIn("/api/folders/folder-1/children", google);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodes: [] });
  });

  it("children_rate_limit_403_user_rate_limit_exceeded_and_429_are_rate_limited_with_retry_after", async () => {
    const cases: Array<[string, Scripted, string]> = [
      [
        "userRateLimitExceeded",
        answer(403, { error: { errors: [{ reason: "userRateLimitExceeded" }], code: 403 } }),
        "5",
      ],
      [
        "rateLimitExceeded",
        answer(403, { error: { errors: [{ reason: "rateLimitExceeded" }], code: 403 } }),
        "5",
      ],
      ["429 with Retry-After", answer(429, {}, { "retry-after": "7" }), "7"],
      ["429 with an unusable Retry-After", answer(429, {}, { "retry-after": "soon" }), "5"],
    ];
    for (const [label, scripted, expected] of cases) {
      const google = fake([folder1Ok(), listAnswering(scripted)]);
      const res = await getAsSignedIn("/api/folders/folder-1/children", google);

      expect(res.status, label).toBe(429);
      expect(await codeOf(res), label).toBe("rate_limited");
      expect(res.headers.get("retry-after"), label).toBe(expected);
    }
  });

  it("children_rate_limit_on_the_folder_check_is_rate_limited_too", async () => {
    const google = fake([["GET", `${FILE_URL}folder-1`, answer(429, {}, { "retry-after": "3" })]]);
    const res = await getAsSignedIn("/api/folders/folder-1/children", google);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
    expect(callsContaining(google, LIST_URL)).toEqual([]);
  });

  it("children_other_403_or_5xx_is_upstream_error_502", async () => {
    const cases: Array<[string, Scripted]> = [
      ["403 forbidden", answer(403, { error: { errors: [{ reason: "forbidden" }], code: 403 } })],
      ["403 without a body", answer(403, null)],
      ["500", answer(500, { error: { code: 500 } })],
      ["garbage body", answer(200, [1, 2])],
      ["transport", unreachable("connection reset")],
    ];
    for (const [label, scripted] of cases) {
      const google = fake([folder1Ok(), listAnswering(scripted)]);
      const res = await getAsSignedIn("/api/folders/folder-1/children", google);

      expect(res.status, label).toBe(502);
      expect(await codeOf(res), label).toBe("upstream_error");
      expect(res.headers.get("retry-after"), label).toBeNull();
    }
  });

  it("children_drive_401_ends_the_session_and_clears_the_cookie", async () => {
    const google = fake([folder1Ok(), listAnswering(answer(401, { error: { code: 401 } }))]);
    const res = await getAsSignedIn("/api/folders/folder-1/children", google);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "unauthenticated",
      message: "Your session has ended. Sign in again.",
      reason: "session_ended",
    });
    expect(setCookies(res)).toEqual([CLEAR_SESSION]);
  });

  it("children_unknown_folder_is_not_found", async () => {
    const google = fake([["GET", `${FILE_URL}folder-1`, answer(404, { error: { code: 404 } })]]);
    const res = await getAsSignedIn("/api/folders/folder-1/children", google);

    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("not_found");
    expect(callsContaining(google, LIST_URL)).toEqual([]);
  });

  it("children_of_a_file_or_trashed_folder_is_not_found", async () => {
    const trashed = { ...folderJson("folder-1", "Old"), trashed: true };
    const cases: Array<[string, unknown]> = [
      ["a file", fileJson("folder-1", "A.md", "text/markdown")],
      ["a trashed folder", trashed],
    ];
    for (const [label, file] of cases) {
      const google = fake([
        ["GET", `${FILE_URL}folder-1`, answer(200, file)],
        listAnswering(answer(200, { files: [] })),
      ]);
      const res = await getAsSignedIn("/api/folders/folder-1/children", google);

      expect(res.status, label).toBe(404);
      expect(await codeOf(res), label).toBe("not_found");
      expect(callsContaining(google, LIST_URL), label).toEqual([]);
    }
  });

  it("children_invalid_id_is_not_found_without_upstream", async () => {
    for (const id of ["a'%20or%20'x", "a%27", "a%2Fb", "a%20b", "..", "a.b", "%E3%81%82"]) {
      const google = silent();
      const res = await getAsSignedIn(`/api/folders/${id}/children`, google);

      expect(res.status, id).toBe(404);
      expect(await codeOf(res), id).toBe("not_found");
      expect(google.calls, id).toEqual([]);
    }
  });

  it("children_empty_id_is_not_found_without_upstream", async () => {
    const google = silent();
    const res = await getAsSignedIn("/api/folders//children", google);

    expect(res.status).toBe(404);
    expect(google.calls).toEqual([]);
  });

  it("children_without_session_is_401_and_calls_nothing", async () => {
    for (const path of ["/api/folders/folder-1/children", "/api/folders/a'%20or%20'x/children"]) {
      const google = silent();
      const res = await send(apiReq(path), { google });

      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual({
        code: "unauthenticated",
        message: "Not signed in",
      });
      expect(google.calls, path).toEqual([]);
    }
  });

  it("children_with_expired_token_refreshes_and_sets_cookie_even_on_failure", async () => {
    const cookie = await sealed(NOW + 59);

    let google = fake([refreshOk(), folder1Ok(), listAnswering(answer(200, { files: [] }))]);
    let res = await send(apiReq("/api/folders/folder-1/children", cookie), { google });
    expect(res.status).toBe(200);
    expect(setCookies(res)).toHaveLength(1);
    expect(setCookies(res)[0]!.startsWith("__Host-s=")).toBe(true);
    const bearer = `Bearer ${NEW_AT}`;
    expect(callsContaining(google, "/drive/v3/files").every(([, auth]) => auth === bearer)).toBe(
      true,
    );

    google = fake([refreshOk(), ["GET", `${FILE_URL}folder-1`, answer(404, {})]]);
    res = await send(apiReq("/api/folders/folder-1/children", cookie), { google });
    expect(res.status).toBe(404);
    expect(setCookies(res)).toHaveLength(1);
    expect(setCookies(res)[0]!.startsWith("__Host-s=")).toBe(true);
  });

  it("a_refresh_followed_by_a_drive_401_sends_only_the_clear_cookie", async () => {
    const clear = [CLEAR_SESSION];
    const cookie = await sealed(NOW + 59);

    let google = fake([
      refreshOk(),
      folder1Ok(),
      listAnswering(answer(401, { error: { code: 401 } })),
    ]);
    let res = await send(apiReq("/api/folders/folder-1/children", cookie), { google });
    expect(res.status).toBe(401);
    expect(setCookies(res), "children").toEqual(clear);

    google = fake([
      refreshOk(),
      ["GET", `${FILE_URL}root-id`, answer(401, { error: { code: 401 } })],
    ]);
    res = await send(apiReq("/api/root", cookie), { google });
    expect(res.status).toBe(401);
    expect(setCookies(res), "root").toEqual(clear);
  });
});

// ---------------------------------------------------------------------------
// POST /api/folders/{id}/folders, PATCH /api/folders/{id}, DELETE /api/folders/{id}
// ---------------------------------------------------------------------------

/** Rust `mutate_req`: signed in, `Sec-Fetch-Site: same-origin`, a JSON body when given. */
const mutateReq = async (
  method: string,
  path: string,
  body: unknown,
  origin: string | undefined,
): Promise<Request> => {
  const headers: Record<string, string> = { "sec-fetch-site": "same-origin" };
  if (origin !== undefined) headers["origin"] = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return request(method, path, {
    cookie: `__Host-s=${await sealed(NOW + 3600)}`,
    headers,
    sameOrigin: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const sentJson = (google: FakeGoogle, method: string): unknown => {
  const call = google.calls.find((c) => c.method === method);
  expect(call, `${method} call`).toBeDefined();
  return JSON.parse(call!.text) as unknown;
};

describe("folder mutations", () => {
  it("create_folder_succeeds_and_posts_drive_folder_metadata", async () => {
    const google = fake([
      rootOk(),
      listAnswering(answer(200, { files: [folderJson("existing", "Work")] })),
      ["POST", "https://fake.test/drive/v3/files?", answer(200, folderJson("new-dir", "Projects"))],
    ]);

    const res = await send(
      await mutateReq("POST", "/api/folders/root-id/folders", { name: "  Projects  " }, ORIGIN),
      { google },
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "new-dir",
      name: "Projects",
      kind: "folder",
      modifiedTime: "2026-11-01T10:00:00.000Z",
    });
    expect(sentJson(google, "POST")).toEqual({
      name: "Projects",
      mimeType: FOLDER_MIME,
      parents: ["root-id"],
    });
  });

  it("create_folder_rejects_duplicate_name_with_409", async () => {
    const google = fake([
      rootOk(),
      listAnswering(answer(200, { files: [folderJson("existing", "Projects")] })),
    ]);

    const res = await send(
      await mutateReq("POST", "/api/folders/root-id/folders", { name: "Projects" }, ORIGIN),
      { google },
    );

    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("name_exists");
  });

  it("create_folder_rejects_invalid_names_and_cross_origin", async () => {
    const google = silent();

    for (const bad of ["", "   ", ".", "..", "a/b"]) {
      const res = await send(
        await mutateReq("POST", "/api/folders/root-id/folders", { name: bad }, ORIGIN),
        { google },
      );
      expect(res.status, `bad name ${JSON.stringify(bad)}`).toBe(400);
      expect(await codeOf(res)).toBe("invalid_name");
    }

    const cross = await send(
      await mutateReq(
        "POST",
        "/api/folders/root-id/folders",
        { name: "Projects" },
        "https://evil.test",
      ),
      { google },
    );
    expect(cross.status).toBe(403);
  });

  it("rename_folder_updates_name_and_rejects_root_or_duplicates", async () => {
    const folderWithParent = { ...folderJson("folder-1", "Old"), parents: ["root-id"] };

    const google = fake([
      ["GET", `${FILE_URL}folder-1`, answer(200, folderWithParent)],
      listAnswering(
        answer(200, { files: [folderJson("folder-1", "Old"), folderJson("folder-2", "Taken")] }),
      ),
      ["PATCH", `${FILE_URL}folder-1`, answer(200, folderJson("folder-1", "Renamed"))],
    ]);

    const ok = await send(
      await mutateReq("PATCH", "/api/folders/folder-1", { name: "Renamed" }, ORIGIN),
      { google },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Record<string, unknown>)["name"]).toBe("Renamed");

    // Duplicate sibling returns 409
    const dup = await send(
      await mutateReq("PATCH", "/api/folders/folder-1", { name: "Taken" }, ORIGIN),
      { google },
    );
    expect(dup.status).toBe(409);
    expect(await codeOf(dup)).toBe("name_exists");

    // Same name is a no-op returning 200 without PATCH
    const noopGoogle = fake([["GET", `${FILE_URL}folder-1`, answer(200, folderWithParent)]]);
    const noop = await send(
      await mutateReq("PATCH", "/api/folders/folder-1", { name: "Old" }, ORIGIN),
      { google: noopGoogle },
    );
    expect(noop.status).toBe(200);
    expect(noopGoogle.calls).toHaveLength(1);

    // Root folder cannot be renamed
    const rootRes = await send(
      await mutateReq("PATCH", "/api/folders/root-id", { name: "Hacked" }, ORIGIN),
      { google: silent() },
    );
    expect(rootRes.status).toBe(400);
  });

  it("delete_folder_trashes_folder_and_rejects_root_or_non_folder", async () => {
    const google = fake([folder1Ok(), ["PATCH", `${FILE_URL}folder-1`, answer(200, {})]]);

    const ok = await send(await mutateReq("DELETE", "/api/folders/folder-1", undefined, ORIGIN), {
      google,
    });
    expect(ok.status).toBe(204);
    expect(sentJson(google, "PATCH")).toEqual({ trashed: true });

    // Root folder cannot be deleted
    const rootRes = await send(
      await mutateReq("DELETE", "/api/folders/root-id", undefined, ORIGIN),
      { google: silent() },
    );
    expect(rootRes.status).toBe(400);

    // Markdown file returns 404 on folder delete route
    const fileGoogle = fake([
      [
        "GET",
        `${FILE_URL}file-1`,
        answer(200, {
          id: "file-1",
          name: "note.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-11-01T10:00:00.000Z",
          trashed: false,
        }),
      ],
    ]);
    const nonFolder = await send(
      await mutateReq("DELETE", "/api/folders/file-1", undefined, ORIGIN),
      { google: fileGoogle },
    );
    expect(nonFolder.status).toBe(404);
  });
});
