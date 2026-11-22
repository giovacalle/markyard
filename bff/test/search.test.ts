// Port of the Rust `core/tests/search.rs` tests (`GET /api/search`), plus tests of the bounded,
// memoized parent-path resolution that replaces Rust's sequential loop (ADR 0003). The fake
// answers by URL, never by call order, so concurrent lookups cannot reorder its answers.

import { describe, expect, it } from "vite-plus/test";

import {
  AT,
  FakeGoogle,
  get,
  json,
  on,
  send,
  setCookies,
  signedInCookie,
  testEnv,
  type Route,
} from "./support/harness.ts";

const ROOT_ID = "root-folder-1";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE = "https://fake.test/drive/v3/files";
const env = testEnv({ ROOT_FOLDER_ID: ROOT_ID });

const searchUrl = (encodedQ: string): string =>
  `${DRIVE}?q=${encodedQ}&pageSize=40&orderBy=modifiedTime+desc&fields=files%28id%2Cname%2CmimeType%2CmodifiedTime%2Ctrashed%2Cparents%29`;

/** The encoded Drive `q` for a query text that needs no escaping beyond URL encoding. */
const encodedQ = (escaped: string): string =>
  `%28name+contains+%27${escaped}%27+or+fullText+contains+%27${escaped}%27%29+and+trashed%3Dfalse+and+mimeType%21%3D%27application%2Fvnd.google-apps.folder%27`;

const folderUrl = (id: string): string =>
  `${DRIVE}/${id}?fields=id,name,mimeType,modifiedTime,trashed,parents`;

const searchRoute = (files: ReadonlyArray<unknown>): Route =>
  on("GET", `${DRIVE}?q=`, json(200, { files }));

const folderRoute = (id: string, name: string, parents: ReadonlyArray<string>): Route =>
  on(
    "GET",
    `${DRIVE}/${id}?`,
    json(200, {
      id,
      name,
      mimeType: FOLDER_MIME,
      modifiedTime: "2026-11-01T00:00:00Z",
      trashed: false,
      parents,
    }),
  );

const markdown = (id: string, parent: string, modifiedTime = "2026-11-20T12:00:00Z") => ({
  id,
  name: `${id}.md`,
  mimeType: "text/markdown",
  modifiedTime,
  trashed: false,
  parents: [parent],
});

const resultOf = (
  id: string,
  path: ReadonlyArray<string>,
  modifiedTime = "2026-11-20T12:00:00Z",
) => ({
  node: { id, name: `${id}.md`, kind: "markdown", modifiedTime },
  path,
});

const searchAs = async (path: string, google: FakeGoogle): Promise<Response> =>
  send(get(path, { cookie: await signedInCookie() }), { google, env });

const sortedUrls = (google: FakeGoogle): Array<string> => google.calls.map((c) => c.url).sort();

describe("search", () => {
  it("search_requires_authentication", async () => {
    const google = new FakeGoogle();
    const res = await send(get("/api/search?q=roadmap"), { google, env });
    expect(res.status).toBe(401);
    expect(google.calls).toEqual([]);
  });

  it("search_returns_empty_for_missing_or_short_queries_without_calling_drive", async () => {
    const google = new FakeGoogle();
    for (const path of ["/api/search", "/api/search?q=", "/api/search?q=%20a%20"]) {
      const res = await searchAs(path, google);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    }
    expect(google.calls).toEqual([]);
  });

  it("search_filters_to_root_folder_markdown_resolves_nested_paths_and_escapes_quotes", async () => {
    const google = new FakeGoogle([
      searchRoute([
        {
          id: "f-root",
          name: "root-note.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-11-20T12:00:00Z",
          trashed: false,
          parents: [ROOT_ID],
        },
        {
          id: "f-nested",
          name: "roadmap.md",
          mimeType: "text/plain",
          modifiedTime: "2026-11-20T11:00:00Z",
          trashed: false,
          parents: ["sub-2"],
        },
        {
          id: "f-outside",
          name: "secret.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-11-20T10:00:00Z",
          trashed: false,
          parents: ["other-root"],
        },
        {
          id: "f-pdf",
          name: "spec.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-11-20T09:00:00Z",
          trashed: false,
          parents: [ROOT_ID],
        },
        {
          id: "f-gdoc",
          name: "fake.md",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-11-20T08:00:00Z",
          trashed: false,
          parents: [ROOT_ID],
        },
      ]),
      folderRoute("sub-2", "2026", ["sub-1"]),
      folderRoute("sub-1", "Work", [ROOT_ID]),
      folderRoute("other-root", "My Drive", []),
    ]);

    const res = await searchAs("/api/search?q=bob%27s", google);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        {
          node: {
            id: "f-root",
            name: "root-note.md",
            kind: "markdown",
            modifiedTime: "2026-11-20T12:00:00Z",
          },
          path: [],
        },
        {
          node: {
            id: "f-nested",
            name: "roadmap.md",
            kind: "markdown",
            modifiedTime: "2026-11-20T11:00:00Z",
          },
          path: ["Work", "2026"],
        },
      ],
    });

    const searchCall = google.calls[0]!;
    expect(searchCall.url).toContain("bob%5C%27s");
    expect(searchCall.url).toBe(searchUrl(encodedQ("bob%5C%27s")));
    expect(google.unexpected).toEqual([]);
    expect(sortedUrls(google)).toEqual(
      [
        searchUrl(encodedQ("bob%5C%27s")),
        folderUrl("sub-2"),
        folderUrl("sub-1"),
        folderUrl("other-root"),
      ].sort(),
    );
    for (const call of google.calls) {
      expect(call.method).toBe("GET");
      expect(call.headers.get("authorization")).toBe(`Bearer ${AT}`);
      expect(call.text).toBe("");
    }
  });

  it("search_propagates_drive_401_and_429", async () => {
    const google401 = new FakeGoogle([
      on("GET", `${DRIVE}?q=`, json(401, { error: { code: 401 } })),
    ]);
    const res401 = await searchAs("/api/search?q=roadmap", google401);
    expect(res401.status).toBe(401);

    const google429 = new FakeGoogle([
      on("GET", `${DRIVE}?q=`, json(429, { error: { code: 429 } })),
    ]);
    const res429 = await searchAs("/api/search?q=roadmap", google429);
    expect(res429.status).toBe(429);
  });
});

/** Holds every folder lookup until `target` are in flight, then answers them in reverse order. */
const gate = (google: FakeGoogle, target: number) => {
  const inner = google.fetch;
  const stats = { inFlight: 0, maxInFlight: 0 };
  const held: Array<() => void> = [];
  const releaseAll = () => {
    for (const release of held.splice(0).reverse()) release();
  };
  const fetch = async (request: Request): Promise<Response> => {
    if (!request.url.startsWith(`${DRIVE}/`)) return inner(request);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const wait = new Promise<void>((resolve) => held.push(resolve));
    if (stats.inFlight >= target) releaseAll();
    // A sequential implementation never reaches `target`; give up instead of hanging the test.
    const timer = setTimeout(releaseAll, 1000);
    await wait;
    clearTimeout(timer);
    stats.inFlight--;
    return inner(request);
  };
  Object.defineProperty(google, "fetch", { value: fetch });
  return stats;
};

describe("search parent-path resolution", () => {
  it("search_resolves_parent_paths_concurrently_and_keeps_drive_order", async () => {
    const folders = ["p1", "p2", "p3", "p4", "p5"];
    const google = new FakeGoogle([
      searchRoute(folders.map((p, i) => markdown(`f-${p}`, p, `2026-11-20T1${i}:00:00Z`))),
      ...folders.map((p) => folderRoute(p, `Folder ${p}`, [ROOT_ID])),
    ]);
    // Five walks, at most four at once (ADR 0003).
    const stats = gate(google, 4);

    const res = await searchAs("/api/search?q=roadmap", google);
    expect(res.status).toBe(200);
    expect(stats.maxInFlight).toBe(4);
    expect(await res.json()).toEqual({
      results: folders.map((p, i) =>
        resultOf(`f-${p}`, [`Folder ${p}`], `2026-11-20T1${i}:00:00Z`),
      ),
    });
    expect(google.unexpected).toEqual([]);
  });

  it("search_fetches_a_parent_shared_by_several_results_once", async () => {
    const google = new FakeGoogle([
      searchRoute([
        markdown("a", "shared"),
        markdown("b", "left"),
        markdown("c", "shared"),
        markdown("d", "right"),
        markdown("e", "shared"),
      ]),
      folderRoute("shared", "Shared", ["top"]),
      folderRoute("left", "Left", ["top"]),
      folderRoute("right", "Right", ["top"]),
      folderRoute("top", "Top", [ROOT_ID]),
    ]);

    const res = await searchAs("/api/search?q=roadmap", google);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        resultOf("a", ["Top", "Shared"]),
        resultOf("b", ["Top", "Left"]),
        resultOf("c", ["Top", "Shared"]),
        resultOf("d", ["Top", "Right"]),
        resultOf("e", ["Top", "Shared"]),
      ],
    });
    for (const id of ["shared", "left", "right", "top"]) {
      expect(google.calls.filter((c) => c.url === folderUrl(id))).toHaveLength(1);
    }
    expect(google.calls).toHaveLength(5);
  });

  it("search_drops_results_whose_parent_is_gone_or_not_a_live_folder", async () => {
    const google = new FakeGoogle([
      searchRoute([markdown("a", "gone"), markdown("b", "note-parent"), markdown("c", ROOT_ID)]),
      on("GET", `${DRIVE}/gone?`, json(404, { error: { code: 404 } })),
      on(
        "GET",
        `${DRIVE}/note-parent?`,
        json(200, {
          id: "note-parent",
          name: "x.md",
          mimeType: "text/markdown",
          modifiedTime: "2026-11-01T00:00:00Z",
          parents: [ROOT_ID],
        }),
      ),
    ]);

    const res = await searchAs("/api/search?q=roadmap", google);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [resultOf("c", [])] });
  });

  it("search_answers_the_failure_of_the_earliest_result_like_the_sequential_loop", async () => {
    const google = new FakeGoogle([
      searchRoute([markdown("a", "ok"), markdown("b", "broken"), markdown("c", "busy")]),
      folderRoute("ok", "Ok", [ROOT_ID]),
      on("GET", `${DRIVE}/broken?`, json(500, { error: { code: 500 } })),
      on("GET", `${DRIVE}/busy?`, json(429, { error: { code: 429 } }, { "retry-after": "30" })),
    ]);
    // Let the later 429 finish before the earlier 500.
    const stats = gate(google, 3);

    const res = await searchAs("/api/search?q=roadmap", google);
    expect(stats.maxInFlight).toBe(3);
    expect(res.status).toBe(502);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(setCookies(res)).toEqual([]);
  });
});
