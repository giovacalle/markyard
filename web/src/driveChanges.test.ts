import { QueryClient } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { DriveNode } from "./api";
import { DriveChanges, MAX_RECENT_CHANGES } from "./driveChanges";
import {
  readChangesState,
  updateChangesState,
  upsertPendingWrite,
  writeCachedSession,
} from "./localCache";
import { clearSelfWrites, markSelfWrite } from "./selfWrites";
import { childrenKey } from "./treeCache";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  clearSelfWrites();
});
afterAll(() => server.close());
// Changes state is scoped to the signed-in account.
beforeEach(() => writeCachedSession("owner@example.com"));

const T0 = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: DriveNode["kind"] = "markdown"): DriveNode {
  return { id, name, kind, modifiedTime: T0 };
}

function change(fileId: string, parentIds: string[], extra: Record<string, unknown> = {}) {
  return {
    fileId,
    removed: false,
    time: new Date().toISOString(),
    node: node(fileId, `${fileId}.md`),
    parentIds,
    ...extra,
  };
}

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["root"], node("root", "Notes", "folder"));
  client.setQueryData(childrenKey("root"), [node("a", "a.md"), node("sub", "Sub", "folder")]);
  client.setQueryData(childrenKey("sub"), [node("b", "b.md")]);
  client.setQueryData(childrenKey("other"), [node("c", "c.md")]);
  return client;
}

function isInvalidated(client: QueryClient, folderId: string): boolean {
  return client.getQueryState(childrenKey(folderId))?.isInvalidated ?? false;
}

describe("DriveChanges", () => {
  it("runs one follow-up poll for triggers that arrive while a poll is running", async () => {
    await updateChangesState({ startPageToken: "t1" });
    let changesCalls = 0;
    server.use(
      http.get("/api/changes", () => {
        changesCalls += 1;
        return HttpResponse.json({ nextPageToken: "t1", hasMore: false, changes: [] });
      }),
    );
    const changes = new DriveChanges(seededClient());
    const first = changes.poll();
    const second = changes.poll();
    const third = changes.poll();
    expect(third).toBe(second);
    await Promise.all([first, second, third]);
    expect(changesCalls).toBe(2);
  });

  it("initializes the page token from start-token when none is stored", async () => {
    let changesCalls = 0;
    server.use(
      http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "t1" })),
      http.get("/api/changes", () => {
        changesCalls += 1;
        return HttpResponse.json({ nextPageToken: "t1", hasMore: false, changes: [] });
      }),
    );
    const changes = new DriveChanges(seededClient());
    await changes.poll();
    expect((await readChangesState())?.startPageToken).toBe("t1");
    expect(changesCalls).toBe(0);
  });

  it("invalidates only the folders a change touches and records the note as recent", async () => {
    await updateChangesState({ startPageToken: "t1" });
    const seen: string[] = [];
    server.use(
      http.get("/api/changes", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("pageToken") ?? "");
        return HttpResponse.json({
          nextPageToken: "t2",
          hasMore: false,
          changes: [change("b", ["sub"]), change("outside", ["elsewhere"])],
        });
      }),
    );
    const client = seededClient();
    const changes = new DriveChanges(client);
    await changes.poll();

    expect(seen).toEqual(["t1"]);
    expect(isInvalidated(client, "sub")).toBe(true);
    expect(isInvalidated(client, "root")).toBe(false);
    expect(isInvalidated(client, "other")).toBe(false);
    expect(changes.getSnapshot().recent.map((entry) => entry.id)).toEqual(["b"]);
    expect((await readChangesState())?.startPageToken).toBe("t2");
  });

  it("invalidates both the old and the new folder when a note moves", async () => {
    await updateChangesState({ startPageToken: "t1" });
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({ nextPageToken: "t2", hasMore: false, changes: [change("a", ["sub"])] }),
      ),
    );
    const client = seededClient();
    await new DriveChanges(client).poll();
    expect(isInvalidated(client, "root")).toBe(true);
    expect(isInvalidated(client, "sub")).toBe(true);
    expect(isInvalidated(client, "other")).toBe(false);
  });

  it("skips our own writes", async () => {
    await updateChangesState({ startPageToken: "t1" });
    markSelfWrite("b");
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({ nextPageToken: "t2", hasMore: false, changes: [change("b", ["sub"])] }),
      ),
    );
    const client = seededClient();
    const changes = new DriveChanges(client);
    await changes.poll();
    expect(isInvalidated(client, "sub")).toBe(false);
    expect(changes.getSnapshot().recent).toEqual([]);
  });

  it("caps the recent list", async () => {
    await updateChangesState({ startPageToken: "t1" });
    const many = Array.from({ length: MAX_RECENT_CHANGES + 5 }, (_, i) =>
      change(`n${i}`, ["root"]),
    );
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({ nextPageToken: "t2", hasMore: false, changes: many }),
      ),
    );
    const changes = new DriveChanges(seededClient());
    await changes.poll();
    expect(changes.getSnapshot().recent).toHaveLength(MAX_RECENT_CHANGES);
  });

  it("re-initializes on 410 token_expired and refreshes the cached folders", async () => {
    await updateChangesState({ startPageToken: "old" });
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({ code: "token_expired", message: "Expired" }, { status: 410 }),
      ),
      http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "fresh" })),
    );
    const client = seededClient();
    await new DriveChanges(client).poll();
    expect((await readChangesState())?.startPageToken).toBe("fresh");
    expect(isInvalidated(client, "root")).toBe(true);
    expect(isInvalidated(client, "sub")).toBe(true);
  });

  it("reports the open note when Drive's text differs from ours", async () => {
    await updateChangesState({ startPageToken: "t1" });
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({
          nextPageToken: "t2",
          hasMore: false,
          changes: [change("a", ["root"])],
        }),
      ),
      http.get(
        "/api/files/a/content",
        () => new HttpResponse("theirs", { headers: { ETag: '"r2"' } }),
      ),
    );
    const client = seededClient();
    client.setQueryData(["files", "a", "content"], { text: "mine", revision: '"r1"' });
    const changes = new DriveChanges(client);
    changes.setOpenFileId("a");
    await changes.poll();
    expect(changes.getSnapshot().external?.fileId).toBe("a");

    changes.dismissExternal("a");
    expect(changes.getSnapshot().external).toBeNull();
  });

  it("does not report the open note when only our own upload changed it", async () => {
    await updateChangesState({ startPageToken: "t1" });
    markSelfWrite("a");
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({
          nextPageToken: "t2",
          hasMore: false,
          changes: [change("a", ["root"])],
        }),
      ),
      http.get(
        "/api/files/a/content",
        () => new HttpResponse("same", { headers: { ETag: '"r2"' } }),
      ),
    );
    const client = seededClient();
    client.setQueryData(["files", "a", "content"], { text: "same", revision: '"r2"' });
    const changes = new DriveChanges(client);
    changes.setOpenFileId("a");
    await changes.poll();
    expect(changes.getSnapshot().external).toBeNull();
  });

  it("reports the open note against a queued edit's base, not the edit itself", async () => {
    await updateChangesState({ startPageToken: "t1" });
    await upsertPendingWrite("a", "local edit", '"r1"', "base");
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({
          nextPageToken: "t2",
          hasMore: false,
          changes: [change("a", ["root"])],
        }),
      ),
      http.get(
        "/api/files/a/content",
        () => new HttpResponse("someone else", { headers: { ETag: '"r9"' } }),
      ),
    );
    const changes = new DriveChanges(seededClient());
    changes.setOpenFileId("a");
    await changes.poll();
    expect(changes.getSnapshot().external?.fileId).toBe("a");
  });

  it("forgets the account on reset", async () => {
    await updateChangesState({ startPageToken: "t1" });
    server.use(
      http.get("/api/changes", () =>
        HttpResponse.json({
          nextPageToken: "t2",
          hasMore: false,
          changes: [change("a", ["root"])],
        }),
      ),
    );
    const changes = new DriveChanges(seededClient());
    await changes.poll();
    expect(changes.getSnapshot().recent).toHaveLength(1);
    changes.reset();
    expect(changes.getSnapshot().recent).toEqual([]);
  });
});
