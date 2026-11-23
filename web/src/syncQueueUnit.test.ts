import { QueryClient } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ApiError } from "./api";
import {
  deleteCachedRemoteFile,
  deleteCachedSubtree,
  readCachedFile,
  readPendingWrite,
  upsertPendingWrite,
  writeCachedFile,
  writeCachedFolder,
} from "./localCache";
import { SyncQueue } from "./syncQueue";
import { childrenKey } from "./treeCache";
import { readTemplates } from "./vaultDocuments";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-23T10:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function contentResponse(body: string, etag: string) {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeQueue() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queue = new SyncQueue(queryClient);
  return { queryClient, queue };
}

describe("SyncQueue unit tests", () => {
  it("does not upgrade baseRevision to an unrelated observed remote revision on enqueueSave", async () => {
    const { queue } = makeQueue();
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push({ ifMatch: request.headers.get("If-Match"), text: await request.text() });
        return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
      }),
      http.get("/api/files/doc-1/content", () => contentResponse("remote edit", '"etag-2"')),
    );

    // Background GET landed with a different remote text before the user's draft flushed.
    queue.observeRemoteRevision("doc-1", '"etag-2"', "remote edit");
    queue.enqueueSave("doc-1", "my edit", '"etag-1"', "old");

    await vi.waitFor(() => {
      const state = queue.getFileState("doc-1");
      expect(state.status).toBe("error");
      if (state.status === "error") {
        expect(state.error).toBeInstanceOf(ApiError);
        expect((state.error as ApiError).status).toBe(412);
      }
    });

    // Must send the caller's original tag, never the unrelated remote tag.
    expect(puts).toEqual([{ ifMatch: '"etag-1"', text: "my edit" }]);
    queue.dispose();
  });

  it("still inherits an observed remote revision when baseText matches (metadata-only bump) and chains own saves", async () => {
    const { queue } = makeQueue();
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push({ ifMatch: request.headers.get("If-Match"), text: await request.text() });
        const nextTag = puts.length === 1 ? '"etag-3"' : '"etag-4"';
        return new HttpResponse(null, { status: 204, headers: { ETag: nextTag } });
      }),
    );

    // Metadata-only remote observation: same text ("old"), newer tag ("etag-2").
    queue.observeRemoteRevision("doc-1", '"etag-2"', "old");
    queue.enqueueSave("doc-1", "v1", '"etag-1"', "old");
    await vi.waitFor(() => expect(queue.getFileState("doc-1").status).toBe("synced"));

    // Rapid follow-up save before caller state updates its fallbackRevision chains on our own "etag-3".
    queue.enqueueSave("doc-1", "v2", '"etag-1"', "old");
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    await vi.waitFor(() => expect(queue.getFileState("doc-1").status).toBe("synced"));

    expect(puts).toEqual([
      { ifMatch: '"etag-2"', text: "v1" },
      { ifMatch: '"etag-3"', text: "v2" },
    ]);
    queue.dispose();
  });

  it("does not overwrite outbox baseRevision on rename/move of a conflicted file, reconciling safely instead", async () => {
    const { queue } = makeQueue();
    let remoteText = "remote edit";
    let remoteTag = '"etag-3"';
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.put("/api/files/doc-1/content", async ({ request }) => {
        const ifMatch = request.headers.get("If-Match");
        const text = await request.text();
        puts.push({ ifMatch, text });
        if (ifMatch !== remoteTag) {
          return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
        }
        remoteTag = '"etag-4"';
        remoteText = text;
        return new HttpResponse(null, { status: 204, headers: { ETag: remoteTag } });
      }),
      http.get("/api/files/doc-1/content", () => contentResponse(remoteText, remoteTag)),
      http.patch("/api/files/doc-1", async ({ request }) => {
        const body = (await request.json()) as { name?: string; parentId?: string };
        return HttpResponse.json(node("doc-1", body.name ?? "a.md", "markdown"), {
          status: 200,
          headers: { ETag: '"etag-3"' },
        });
      }),
    );

    // First save hits a real 412 conflict against remote edit.
    queue.enqueueSave("doc-1", "mine", '"etag-1"', "old");
    await vi.waitFor(() => expect(queue.getFileState("doc-1").status).toBe("error"));

    // Renaming and moving the conflicted file must NOT overwrite outbox.baseRevision with "etag-3".
    await queue.renameFile("doc-1", "renamed.md");
    await queue.moveFile("doc-1", "folder-2");
    expect((await readPendingWrite("doc-1"))?.baseRevision).toBe('"etag-1"');

    // Retrying still surfaces the real 412 conflict instead of clobbering "remote edit".
    await queue.retryFile("doc-1");
    expect(queue.getFileState("doc-1").status).toBe("error");
    expect(puts).toEqual([
      { ifMatch: '"etag-1"', text: "mine" },
      { ifMatch: '"etag-1"', text: "mine" },
    ]);

    // If Drive only had a metadata bump (remote text still equals baseText), reconcile rebases safely.
    remoteText = "old";
    await queue.retryFile("doc-1");
    expect(queue.getFileState("doc-1").status).toBe("synced");
    expect(puts.at(-1)).toEqual({ ifMatch: '"etag-3"', text: "mine" });
    queue.dispose();
  });

  it("updates db.files and React Query revision when renaming a clean file", async () => {
    const { queryClient, queue } = makeQueue();
    await writeCachedFile("doc-1", "clean", '"etag-1"');
    queryClient.setQueryData(["files", "doc-1", "content"], {
      text: "clean",
      revision: '"etag-1"',
    });

    server.use(
      http.patch("/api/files/doc-1", () =>
        HttpResponse.json(node("doc-1", "renamed.md", "markdown"), {
          status: 200,
          headers: { ETag: '"etag-2"' },
        }),
      ),
    );

    await queue.renameFile("doc-1", "renamed.md");
    expect(await readCachedFile("doc-1")).toEqual({ text: "clean", revision: '"etag-2"' });
    expect(queryClient.getQueryData(["files", "doc-1", "content"])).toEqual({
      text: "clean",
      revision: '"etag-2"',
    });
    queue.dispose();
  });

  it("reverts db.files and React Query on discardFile (and deletes when baseText is missing)", async () => {
    const { queryClient, queue } = makeQueue();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

    queue.enqueueSave("doc-1", "unsynced edit", '"etag-1"', "original text");
    await vi.waitFor(async () =>
      expect((await readPendingWrite("doc-1"))?.text).toBe("unsynced edit"),
    );
    expect(await readCachedFile("doc-1")).toEqual({ text: "unsynced edit", revision: '"etag-1"' });

    await queue.discardFile("doc-1");
    expect(await readPendingWrite("doc-1")).toBeUndefined();
    expect(await readCachedFile("doc-1")).toEqual({ text: "original text", revision: '"etag-1"' });
    expect(queryClient.getQueryData(["files", "doc-1", "content"])).toEqual({
      text: "original text",
      revision: '"etag-1"',
    });
    expect(queue.discardVersion("doc-1")).toBe(1);

    // Without baseText, discard removes db.files and clears React Query instead of keeping stale text.
    queue.enqueueSave("doc-2", "orphan edit", '"etag-9"');
    await vi.waitFor(async () =>
      expect((await readPendingWrite("doc-2"))?.text).toBe("orphan edit"),
    );
    await queue.discardFile("doc-2");
    expect(await readPendingWrite("doc-2")).toBeUndefined();
    expect(await readCachedFile("doc-2")).toBeUndefined();
    expect(queryClient.getQueryData(["files", "doc-2", "content"])).toBeUndefined();
    expect(queue.discardVersion("doc-2")).toBe(1);
    queue.dispose();
  });

  it("cancels in-flight PUTs via epochs on cancelDeletedFile, discardFile, and resetAll", async () => {
    const { queryClient, queue } = makeQueue();
    const put1Gate = deferred<Response>();
    const put2Gate = deferred<Response>();
    const put3Gate = deferred<Response>();

    server.use(
      http.put("/api/files/deleted-doc/content", () => put1Gate.promise),
      http.put("/api/files/discarded-doc/content", () => put2Gate.promise),
      http.put("/api/files/reset-doc/content", () => put3Gate.promise),
    );

    // 1. In-flight PUT resolves AFTER cancelDeletedFile: must not resurrect cache, query, or state.
    queue.enqueueSave("deleted-doc", "draft", '"etag-1"', "old");
    await vi.waitFor(() => expect(queue.getFileState("deleted-doc").status).toBe("syncing"));
    await queue.cancelDeletedFile("deleted-doc");
    queryClient.removeQueries({ queryKey: ["files", "deleted-doc", "content"] });
    put1Gate.resolve(new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.getFileState("deleted-doc").status).toBe("idle");
    expect(await readPendingWrite("deleted-doc")).toBeUndefined();
    expect(queryClient.getQueryData(["files", "deleted-doc", "content"])).toBeUndefined();
    // Stale unmount enqueueSave for deleted file is suppressed.
    queue.enqueueSave("deleted-doc", "resurrected", '"etag-1"', "old");
    await new Promise((r) => setTimeout(r, 20));
    expect(await readPendingWrite("deleted-doc")).toBeUndefined();

    // 2. In-flight PUT fails AFTER discardFile: must not record error or schedule retry.
    queue.enqueueSave("discarded-doc", "draft", '"etag-1"', "old");
    await vi.waitFor(() => expect(queue.getFileState("discarded-doc").status).toBe("syncing"));
    await queue.discardFile("discarded-doc");
    put2Gate.resolve(
      HttpResponse.json({ code: "upstream_error", message: "Fail" }, { status: 502 }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.getFileState("discarded-doc").status).toBe("idle");

    // 3. In-flight PUT resolves AFTER resetAll: must not write back to cache or state.
    queue.enqueueSave("reset-doc", "draft", '"etag-1"', "old");
    await vi.waitFor(() => expect(queue.getFileState("reset-doc").status).toBe("syncing"));
    const epochBefore = queue.sessionEpoch;
    queue.resetAll();
    expect(queue.sessionEpoch).toBe(epochBefore + 1);
    queryClient.clear();
    put3Gate.resolve(new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.getFileState("reset-doc").status).toBe("idle");
    expect(queryClient.getQueryData(["files", "reset-doc", "content"])).toBeUndefined();
    queue.dispose();
  });

  it("scopes reconcile() per entry.seq so chained edits can each rebase metadata-only 412s", async () => {
    const { queue } = makeQueue();
    const put1RetryGate = deferred<void>();
    let putCount = 0;
    let getCount = 0;
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.put("/api/files/doc-1/content", async ({ request }) => {
        putCount += 1;
        const ifMatch = request.headers.get("If-Match");
        const text = await request.text();
        puts.push({ ifMatch, text });
        if (putCount === 1) {
          // Seq 1 first attempt hits metadata-only 412.
          return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
        }
        if (putCount === 2) {
          // Hold seq 1 rebased retry so seq 2 can arrive mid-flight.
          await put1RetryGate.promise;
          return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
        }
        if (putCount === 3) {
          // Seq 2 first attempt ALSO hits a metadata-only 412.
          return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
        }
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-3"' } });
      }),
      http.get("/api/files/doc-1/content", () => {
        getCount += 1;
        return getCount === 1
          ? contentResponse("v0", '"etag-1b"')
          : contentResponse("v1", '"etag-2b"');
      }),
    );

    queue.enqueueSave("doc-1", "v1", '"etag-1"', "v0");
    await vi.waitFor(() => expect(putCount).toBe(2));

    // Queue seq 2 while seq 1's rebased PUT is in flight.
    queue.enqueueSave("doc-1", "v2", '"etag-1"', "v0");
    await vi.waitFor(async () => expect((await readPendingWrite("doc-1"))?.text).toBe("v2"));
    put1RetryGate.resolve();

    await vi.waitFor(() => expect(queue.getFileState("doc-1").status).toBe("synced"));
    expect(puts).toEqual([
      { ifMatch: '"etag-1"', text: "v1" },
      { ifMatch: '"etag-1b"', text: "v1" },
      { ifMatch: '"etag-2"', text: "v2" },
      { ifMatch: '"etag-2b"', text: "v2" },
    ]);
    queue.dispose();
  });

  it("propagates 401 and transient errors from reconcile() after 412 instead of masking them as 412", async () => {
    const { queryClient, queue } = makeQueue();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    // Case 1: 412 followed by 401 on reconcile GET -> must surface 401 and invalidate ["session"].
    server.use(
      http.put("/api/files/doc-401/content", () =>
        HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 }),
      ),
      http.get("/api/files/doc-401/content", () =>
        HttpResponse.json({ code: "unauthenticated", message: "Ended" }, { status: 401 }),
      ),
    );
    queue.enqueueSave("doc-401", "edited", '"etag-1"', "start");
    await vi.waitFor(() => {
      const state = queue.getFileState("doc-401");
      expect(state.status).toBe("error");
      if (state.status === "error") {
        expect(state.error).toBeInstanceOf(ApiError);
        expect((state.error as ApiError).status).toBe(401);
      }
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session"] });

    // Case 2: 412 followed by transient 502 on reconcile GET -> must surface 502 with auto-retry.
    server.use(
      http.put("/api/files/doc-502/content", () =>
        HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 }),
      ),
      http.get("/api/files/doc-502/content", () =>
        HttpResponse.json({ code: "upstream_error", message: "Down" }, { status: 502 }),
      ),
    );
    queue.enqueueSave("doc-502", "edited", '"etag-1"', "start");
    await vi.waitFor(() => {
      const state = queue.getFileState("doc-502");
      expect(state.status).toBe("error");
      if (state.status === "error") {
        expect((state.error as ApiError).status).toBe(502);
        expect(state.retry).toBeDefined();
      }
    });
    queue.dispose();
  });

  it("deleteCachedRemoteFile preserves pending outbox edits while deleting clean files", async () => {
    await writeCachedFile("clean-1", "clean text", '"e-1"');
    expect(await deleteCachedRemoteFile("clean-1")).toBeUndefined();
    expect(await readCachedFile("clean-1")).toBeUndefined();

    await upsertPendingWrite("dirty-1", "unsynced text", '"e-1"', "base");
    const kept = await deleteCachedRemoteFile("dirty-1");
    expect(kept).toMatchObject({ fileId: "dirty-1", text: "unsynced text" });
    expect(await readPendingWrite("dirty-1")).toMatchObject({ text: "unsynced text" });
    expect(await readCachedFile("dirty-1")).toEqual({ text: "unsynced text", revision: '"e-1"' });
  });

  it("deleteCachedSubtree removes nested descendants stored only in IndexedDB", async () => {
    await writeCachedFolder("parent-dir", [node("sub-dir", "Sub", "folder")]);
    await writeCachedFolder("sub-dir", [node("deep-note", "deep.md", "markdown")]);
    await upsertPendingWrite("deep-note", "offline edit", '"e-1"', "base");

    const removed = await deleteCachedSubtree("parent-dir");
    expect(removed.folderIds).toEqual(expect.arrayContaining(["parent-dir", "sub-dir"]));
    expect(removed.fileIds).toEqual(["deep-note"]);
    expect(await readPendingWrite("deep-note")).toBeUndefined();
    expect(await readCachedFile("deep-note")).toBeUndefined();
  });

  it("readTemplates caches fetched templates in IndexedDB so subsequent offline reads succeed", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["root"], node("root-id", "Notes", "folder"));
    queryClient.setQueryData(childrenKey("root-id"), [node("tpl-dir", "Templates", "folder")]);
    queryClient.setQueryData(childrenKey("tpl-dir"), [node("tpl-1", "Daily.md", "markdown")]);

    let fetches = 0;
    server.use(
      http.get("/api/files/tpl-1/content", () => {
        fetches += 1;
        return contentResponse("# {{date}}\n", '"etag-tpl-1"');
      }),
    );

    const first = await readTemplates(queryClient);
    expect(first).toEqual([{ id: "tpl-1", name: "Daily.md", text: "# {{date}}\n" }]);
    expect(fetches).toBe(1);

    await vi.waitFor(async () => {
      expect(await readCachedFile("tpl-1")).toEqual({
        text: "# {{date}}\n",
        revision: '"etag-tpl-1"',
      });
    });

    // Go offline: second read uses IndexedDB cache without hitting the network.
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const second = await readTemplates(queryClient);
    expect(second).toEqual([{ id: "tpl-1", name: "Daily.md", text: "# {{date}}\n" }]);
    expect(fetches).toBe(1);
  });
});
