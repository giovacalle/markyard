import { QueryClient } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, type DriveNode, type VaultIndex } from "./api";
import { readLocalCloudState } from "./cloudState";
import { getRecentFileIds, recordRecentFile } from "./commandSearch";
import { DriveChanges } from "./driveChanges";
import {
  clearLocalCache,
  clearVaultCache,
  enqueueOrCoalesceOp,
  hasPersistedPendingWork,
  readAllCachedFolders,
  readAllPendingOps,
  readCachedFile,
  readPendingWrite,
  upsertPendingWrite,
  writeCachedFile,
  writeCachedFolder,
  writeCachedSession,
  type PendingOp,
} from "./localCache";
import { isLocalId, makeLocalId, makeOpId } from "./localIds";
import { getOpenFileId, readLastOpenFile, rememberLastOpenFile } from "./openDocument";
import { countTotalPendingSync, OpsQueue, type IdRemapEvent } from "./opsQueue";
import { SyncQueue } from "./syncQueue";
import { childrenKey, findNode, VAULT_INDEX_KEY } from "./treeCache";
import {
  readExpandedFolders,
  subscribeExpandedFolders,
  writeExpandedFolders,
} from "./treeExpanded";
import { readTemplates } from "./vaultDocuments";
import { VaultSync } from "./vaultSync";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-23T10:00:00.000Z";

function makeNode(id: string, name: string, kind: "folder" | "markdown" | "other"): DriveNode {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(callbacks?: {
  onNetworkError?: () => void;
  onNetworkSuccess?: () => void;
  onIdRemapped?: (event: IdRemapEvent) => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const syncQueue = new SyncQueue(queryClient);
  const opsQueue = new OpsQueue(queryClient, syncQueue, callbacks);
  syncQueue.setOnLocalFileFlush(() => {
    void opsQueue.flushAll();
  });
  return { queryClient, syncQueue, opsQueue };
}

describe("Dexie v3 ops store & hasPersistedPendingWork", () => {
  it("tracks persisted ops and outbox and clears db.ops on vault/local/account reset", async () => {
    expect(await hasPersistedPendingWork()).toBe(false);

    await writeCachedSession("alice@example.com");
    const now = Date.now();
    await enqueueOrCoalesceOp({
      opId: makeOpId(),
      kind: "create_file",
      targetId: makeLocalId(),
      targetName: "Note.md",
      parentId: "root",
      name: "Note.md",
      initialContent: "# Hello",
      createdAt: now,
      updatedAt: now,
    });
    expect(await hasPersistedPendingWork()).toBe(true);
    expect((await readAllPendingOps()).length).toBe(1);

    // Same account preserves ops.
    await writeCachedSession("alice@example.com", "Alice");
    expect((await readAllPendingOps()).length).toBe(1);

    // Account switch wipes ops.
    await writeCachedSession("bob@example.com");
    expect(await readAllPendingOps()).toEqual([]);
    expect(await hasPersistedPendingWork()).toBe(false);

    // clearVaultCache clears ops.
    await enqueueOrCoalesceOp({
      opId: makeOpId(),
      kind: "rename_file",
      targetId: "f-1",
      targetName: "New.md",
      name: "New.md",
      previousName: "Old.md",
      createdAt: now,
      updatedAt: now,
    });
    expect(await hasPersistedPendingWork()).toBe(true);
    await clearVaultCache();
    expect(await readAllPendingOps()).toEqual([]);
    expect(await hasPersistedPendingWork()).toBe(false);

    // clearLocalCache clears ops and outbox.
    await upsertPendingWrite("f-2", "draft", '"etag-1"', "orig");
    expect(await hasPersistedPendingWork()).toBe(true);
    await clearLocalCache();
    expect(await hasPersistedPendingWork()).toBe(false);
  });
});

describe("OpsQueue coalescing & simplification rules", () => {
  it("folds rename and move into un-flushed create_file and re-orders when moved into a later local folder", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const fileRes = await opsQueue.createFile({
      parentId: "root",
      initialContent: "hello",
    });
    expect(fileRes.status).toBe("queued");
    expect(isLocalId(fileRes.node.id)).toBe(true);

    // Rename folds into create_file and disables autoSuffixOnConflict.
    await opsQueue.renameFile(fileRes.node.id, "Renamed.md", fileRes.node.name);
    let ops = await readAllPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("create_file");
    if (ops[0].kind === "create_file") {
      expect(ops[0].name).toBe("Renamed.md");
      expect(ops[0].autoSuffixOnConflict).toBe(false);
    }

    // Create a folder AFTER the file, then move the file into that folder:
    // create_file must be re-inserted at tail so create_folder runs first.
    const folderRes = await opsQueue.createFolder({ parentId: "root", name: "Projects" });
    await opsQueue.moveFile(fileRes.node.id, folderRes.node.id, "root");

    ops = await readAllPendingOps();
    expect(ops).toHaveLength(2);
    expect(ops[0].kind).toBe("create_folder");
    expect(ops[0].targetId).toBe(folderRes.node.id);
    expect(ops[1].kind).toBe("create_file");
    expect(ops[1].targetId).toBe(fileRes.node.id);
    if (ops[1].kind === "create_file") {
      expect(ops[1].parentId).toBe(folderRes.node.id);
    }

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("appends move_folder instead of reordering when moving a local folder that already has child ops into a later folder", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const folderA = await opsQueue.createFolder({ parentId: "root", name: "A" });
    const childFile = await opsQueue.createFile({ parentId: folderA.node.id, name: "child.md" });
    const folderB = await opsQueue.createFolder({ parentId: "root", name: "B" });

    // Moving folderA (which has childFile under it) into folderB (created later) appends move_folder.
    await opsQueue.moveFolder(folderA.node.id, folderB.node.id, "root");
    const ops = await readAllPendingOps();
    expect(ops.map((o) => o.kind)).toEqual([
      "create_folder",
      "create_file",
      "create_folder",
      "move_folder",
    ]);
    expect(ops[0].targetId).toBe(folderA.node.id);
    expect(ops[1].targetId).toBe(childFile.node.id);
    expect(ops[2].targetId).toBe(folderB.node.id);
    expect(ops[3].targetId).toBe(folderA.node.id);

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("cancels un-flushed create_file on delete with 0 network calls and wipes outbox/files", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const created = await opsQueue.createFile({
      parentId: "root",
      name: "Temp.md",
      initialContent: "v1",
    });
    syncQueue.enqueueSave(created.node.id, "v2", "", "v1");
    await vi.waitFor(async () => {
      expect((await readPendingWrite(created.node.id))?.text).toBe("v2");
    });

    const del = await opsQueue.deleteFile(created.node.id, "root");
    expect(del.status).toBe("cancelled");
    expect(await readAllPendingOps()).toEqual([]);
    expect(await readPendingWrite(created.node.id)).toBeUndefined();
    expect(await readCachedFile(created.node.id)).toBeUndefined();
    expect(queryClient.getQueryData<DriveNode[]>(childrenKey("root"))).toEqual([]);
    expect(syncQueue.getSnapshot().pendingCount).toBe(0);

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("deletes un-flushed local folder with 0 calls for local descendants, while emitting delete_file for a real file moved into it", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    const realFile = makeNode("real-1", "KeepOrTrash.md", "markdown");
    queryClient.setQueryData(childrenKey("root"), [realFile]);
    await writeCachedFolder("root", [realFile]);
    await writeCachedFile("real-1", "real body", '"etag-1"');

    // Create local folder + local subfolder + local note.
    const localDir = await opsQueue.createFolder({ parentId: "root", name: "Scratch" });
    const localSub = await opsQueue.createFolder({ parentId: localDir.node.id, name: "Sub" });
    const localNote = await opsQueue.createFile({
      parentId: localSub.node.id,
      name: "Local.md",
      initialContent: "temp",
    });

    // Move real-1 into localDir and rename it offline.
    await opsQueue.moveFile("real-1", localDir.node.id, "root");
    await opsQueue.renameFile("real-1", "RenamedBeforeTrash.md", "KeepOrTrash.md");

    // Delete localDir: all local ops cancel, real-1's move+rename become delete_file(real-1)!
    const res = await opsQueue.deleteFolder(localDir.node.id, "root");
    expect(res.status).toBe("queued");

    const ops = await readAllPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("delete_file");
    expect(ops[0].targetId).toBe("real-1");
    if (ops[0].kind === "delete_file") {
      expect(ops[0].previousParentId).toBe("root");
      expect(ops[0].previousNode?.name).toBe("KeepOrTrash.md");
    }
    expect(await readCachedFile(localNote.node.id)).toBeUndefined();
    expect(await readCachedFile("real-1")).toBeUndefined();

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("coalesces multiple renames and moves on a real id and cancels no-op round trips", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    const doc = makeNode("doc-1", "Alpha.md", "markdown");
    const dirA = makeNode("dir-a", "A", "folder");
    const dirB = makeNode("dir-b", "B", "folder");
    queryClient.setQueryData(childrenKey("root"), [doc, dirA, dirB]);
    queryClient.setQueryData(childrenKey("dir-a"), []);
    queryClient.setQueryData(childrenKey("dir-b"), []);
    await writeCachedFolder("root", [doc, dirA, dirB]);
    await writeCachedFolder("dir-a", []);
    await writeCachedFolder("dir-b", []);

    // Rename Alpha -> Beta -> Gamma keeps previousName "Alpha.md".
    await opsQueue.renameFile("doc-1", "Beta.md", "Alpha.md");
    await opsQueue.renameFile("doc-1", "Gamma.md", "Beta.md");
    let ops = await readAllPendingOps();
    expect(ops).toHaveLength(1);
    if (ops[0].kind === "rename_file") {
      expect(ops[0].previousName).toBe("Alpha.md");
      expect(ops[0].name).toBe("Gamma.md");
    }

    // Renaming back to Alpha.md cancels the rename op (0 calls).
    await opsQueue.renameFile("doc-1", "Alpha.md", "Gamma.md");
    expect(await readAllPendingOps()).toEqual([]);

    // Move root -> dir-a -> dir-b keeps previousParentId "root".
    await opsQueue.moveFile("doc-1", "dir-a", "root");
    await opsQueue.moveFile("doc-1", "dir-b", "dir-a");
    ops = await readAllPendingOps();
    expect(ops).toHaveLength(1);
    if (ops[0].kind === "move_file") {
      expect(ops[0].previousParentId).toBe("root");
      expect(ops[0].parentId).toBe("dir-b");
    }

    // Moving back to root cancels the move op (0 calls).
    await opsQueue.moveFile("doc-1", "root", "dir-b");
    expect(await readAllPendingOps()).toEqual([]);

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("preserves a preceding move_file when a real file is moved OUT of a real folder before deleting that folder", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    const folder = makeNode("dir-1", "Archive", "folder");
    const saved = makeNode("f-save", "SaveMe.md", "markdown");
    const doomed = makeNode("f-doom", "Doomed.md", "markdown");
    queryClient.setQueryData(childrenKey("root"), [folder]);
    queryClient.setQueryData(childrenKey("dir-1"), [saved, doomed]);
    await writeCachedFolder("root", [folder]);
    await writeCachedFolder("dir-1", [saved, doomed]);
    await writeCachedFile("f-save", "keep", '"e1"');
    await writeCachedFile("f-doom", "bye", '"e2"');
    await upsertPendingWrite("f-doom", "bye edited", '"e2"', "bye");

    // Move f-save OUT of dir-1 into root, then delete dir-1.
    await opsQueue.moveFile("f-save", "root", "dir-1");
    await opsQueue.deleteFolder("dir-1", "root");

    const ops = await readAllPendingOps();
    expect(ops.map((o) => [o.kind, o.targetId])).toEqual([
      ["move_file", "f-save"],
      ["delete_folder", "dir-1"],
    ]);
    // f-doom's outbox was discarded, f-save stayed intact.
    expect(await readPendingWrite("f-doom")).toBeUndefined();
    expect((await readCachedFile("f-save"))?.text).toBe("keep");

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("never mutates an in-flight create_file op; follow-up rename runs on the remapped real id", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const created = await opsQueue.createFile({
      parentId: "root",
      name: "Initial.md",
      initialContent: "hello",
    });

    const postGate = deferred<void>();
    const requests: string[] = [];
    server.use(
      http.post("/api/folders/root/files", async ({ request }) => {
        const body = (await request.json()) as { name: string; content: string };
        requests.push(`POST:${body.name}`);
        await postGate.promise;
        return HttpResponse.json(makeNode("real-99", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-1"' },
        });
      }),
      http.patch("/api/files/real-99", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        requests.push(`PATCH:${body.name}`);
        return HttpResponse.json(makeNode("real-99", body.name, "markdown"), {
          status: 200,
          headers: { ETag: '"etag-2"' },
        });
      }),
    );

    setOnline(true);
    const flushPromise = opsQueue.flushAll();
    await vi.waitFor(() => {
      expect(requests).toEqual(["POST:Initial.md"]);
    });

    // User renames the file WHILE create_file POST is in flight!
    await opsQueue.renameFile(created.node.id, "AfterInFlight.md", "Initial.md");

    // In-flight create_file was NOT mutated; a rename_file op was appended after it.
    const midOps = await readAllPendingOps();
    expect(midOps.map((o) => o.kind)).toEqual(["create_file", "rename_file"]);

    postGate.resolve();
    await flushPromise;

    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toEqual([]);
    });
    expect(requests).toEqual(["POST:Initial.md", "PATCH:AfterInFlight.md"]);
    expect(findNode(queryClient, "real-99")?.name).toBe("AfterInFlight.md");

    opsQueue.dispose();
    syncQueue.dispose();
  });
});

describe("FIFO replay, causal pause, and deferred conflict handling", () => {
  it("pauses dependent ops transitively when a parent create_folder fails permanently, while independent ops flush", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const dir1 = await opsQueue.createFolder({ parentId: "root", name: "Existing" });
    const dir2 = await opsQueue.createFolder({ parentId: dir1.node.id, name: "Nested" });
    const depFile = await opsQueue.createFile({ parentId: dir2.node.id, name: "Inside.md" });
    const indepFile = await opsQueue.createFile({ parentId: "root", name: "Independent.md" });

    const calls: string[] = [];
    server.use(
      http.post("/api/folders/root/folders", () => {
        calls.push("POST:folder:Existing");
        return HttpResponse.json(
          { code: "name_exists", message: "Folder exists" },
          { status: 409 },
        );
      }),
      http.post("/api/folders/root/files", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        calls.push(`POST:file:${body.name}`);
        return HttpResponse.json(makeNode("real-indep", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"e-indep"' },
        });
      }),
    );

    setOnline(true);
    await opsQueue.flushAll();

    expect(calls).toEqual(["POST:folder:Existing", "POST:file:Independent.md"]);
    const remaining = opsQueue.getSnapshot().ops;
    expect(remaining.map((v) => v.op.targetId)).toEqual([
      dir1.node.id,
      dir2.node.id,
      depFile.node.id,
    ]);
    expect(remaining[0].state.status).toBe("error");
    expect(remaining[1].state.status).toBe("pending");
    expect(remaining[2].state.status).toBe("pending");
    expect(findNode(queryClient, "real-indep")?.name).toBe("Independent.md");
    expect(findNode(queryClient, indepFile.node.id)).toBeUndefined();

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("handles deferred autoSuffixOnConflict, adoptExistingOnConflict, openExistingOnConflict, delete 404, and rename-to-fix", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const dailyDir = await opsQueue.createFolder({
      parentId: "root",
      name: "Daily",
      adoptExistingOnConflict: true,
    });
    const dailyNote = await opsQueue.createFile({
      parentId: dailyDir.node.id,
      name: "2026-11-23.md",
      initialContent: "# 2026-11-23\n\n",
      openExistingOnConflict: true,
    });
    // User edits the offline daily note so it must NOT silently adopt remote on 409.
    syncQueue.enqueueSave(dailyNote.node.id, "# 2026-11-23\n\nMy offline notes", "", "");
    await vi.waitFor(async () => {
      expect((await readPendingWrite(dailyNote.node.id))?.text).toContain("My offline notes");
    });

    const untitled = await opsQueue.createFile({ parentId: "root" });
    const goneFile = makeNode("gone-1", "Gone.md", "markdown");
    queryClient.setQueryData(childrenKey("root"), [
      ...(queryClient.getQueryData<DriveNode[]>(childrenKey("root")) ?? []),
      goneFile,
    ]);
    await opsQueue.deleteFile("gone-1", "root", goneFile);

    server.use(
      http.post("/api/folders/root/folders", () =>
        HttpResponse.json({ code: "name_exists", message: "Exists" }, { status: 409 }),
      ),
      http.get("/api/folders/root/children", () =>
        HttpResponse.json({ nodes: [makeNode("real-daily", "Daily", "folder")] }),
      ),
      http.post("/api/folders/real-daily/files", async ({ request }) => {
        const body = (await request.json()) as { name: string; content: string };
        if (body.name === "2026-11-23.md") {
          return HttpResponse.json({ code: "name_exists", message: "Exists" }, { status: 409 });
        }
        return HttpResponse.json(makeNode("real-daily-note", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"e-daily"' },
        });
      }),
      http.post("/api/folders/root/files", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        if (body.name === "Untitled.md") {
          return HttpResponse.json({ code: "name_exists", message: "Exists" }, { status: 409 });
        }
        return HttpResponse.json(makeNode("real-u2", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"e-u2"' },
        });
      }),
      http.delete("/api/files/gone-1", () =>
        HttpResponse.json({ code: "not_found", message: "Gone" }, { status: 404 }),
      ),
    );

    setOnline(true);
    await opsQueue.flushAll();

    // Daily folder adopted -> real-daily; Untitled.md auto-suffixed -> Untitled 2.md; gone-1 404 succeeded;
    // edited 2026-11-23.md paused with 409 error!
    expect(findNode(queryClient, "real-daily")?.name).toBe("Daily");
    expect(findNode(queryClient, "real-u2")?.name).toBe("Untitled 2.md");
    expect(findNode(queryClient, untitled.node.id)).toBeUndefined();
    expect(opsQueue.getSnapshot().ops).toHaveLength(1);
    expect(opsQueue.getSnapshot().ops[0].op.targetId).toBe(dailyNote.node.id);
    expect(opsQueue.getSnapshot().ops[0].state.status).toBe("error");

    // Renaming the conflicted note folds into create_file and auto-retries online!
    await opsQueue.renameFile(dailyNote.node.id, "2026-11-23-offline.md", "2026-11-23.md");
    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toEqual([]);
    });
    expect(findNode(queryClient, "real-daily-note")?.name).toBe("2026-11-23-offline.md");

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("keeps ops in db.ops and invalidates session on 401 without clearing local cache", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(["session"], { email: "u@example.com" });
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const created = await opsQueue.createFile({ parentId: "root", name: "Secret.md" });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    server.use(
      http.post("/api/folders/root/files", () =>
        HttpResponse.json({ code: "unauthenticated", message: "Expired" }, { status: 401 }),
      ),
    );

    setOnline(true);
    await opsQueue.flushAll();

    expect(await readAllPendingOps()).toHaveLength(1);
    expect(opsQueue.getSnapshot().ops[0].state.status).toBe("error");
    expect(findNode(queryClient, created.node.id)?.name).toBe("Secret.md");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session"] });

    opsQueue.dispose();
    syncQueue.dispose();
  });
});

describe("Atomic localId -> realId remap & SyncQueue coordination", () => {
  it("remaps localId -> realId across Dexie, React Query, SyncQueue, openDocument, recentFiles, treeExpanded, and onIdRemapped", async () => {
    setOnline(false);
    const remapped: IdRemapEvent[] = [];
    const { queryClient, syncQueue, opsQueue } = makeHarness({
      onIdRemapped: (ev) => remapped.push(ev),
    });

    const initialIndex: VaultIndex = {
      rootId: "root",
      folders: [],
      files: [],
      truncated: false,
    };
    queryClient.setQueryData(childrenKey("root"), []);
    queryClient.setQueryData(VAULT_INDEX_KEY, initialIndex);
    await writeCachedFolder("root", []);

    const dir = await opsQueue.createFolder({ parentId: "root", name: "Journal" });
    const note = await opsQueue.createFile({
      parentId: dir.node.id,
      name: "Entry.md",
      initialContent: "initial",
    });

    // Simulate user expanding local folder, opening local note, and editing it offline.
    writeExpandedFolders("root", [dir.node.id]);
    const expandedEvents: (readonly string[])[] = [];
    const unsubExpanded = subscribeExpandedFolders((_root, list) => expandedEvents.push(list));

    window.history.replaceState(null, "", `/?file=${encodeURIComponent(note.node.id)}`);
    rememberLastOpenFile(note.node.id);
    recordRecentFile(note.node.id);

    syncQueue.enqueueSave(note.node.id, "edited offline", "", "initial");
    await vi.waitFor(async () => {
      expect((await readPendingWrite(note.node.id))?.text).toBe("edited offline");
    });

    // SyncQueue.flushFile on localId must NEVER issue PUT /api/files/local:...
    const putCalls: string[] = [];
    const postBodies: { parentId: string; name: string; content: string }[] = [];
    server.use(
      http.post("/api/folders/root/folders", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json(makeNode("real-dir", body.name, "folder"), { status: 201 });
      }),
      http.post("/api/folders/real-dir/files", async ({ request }) => {
        const body = (await request.json()) as { name: string; content: string };
        postBodies.push({ parentId: "real-dir", ...body });
        return HttpResponse.json(makeNode("real-note", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-created"' },
        });
      }),
      http.put("/api/files/:id/content", ({ params }) => {
        putCalls.push(String(params.id));
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    const historyLengthBefore = window.history.length;
    setOnline(true);
    await opsQueue.flushAll();

    // Single POST sent the latest outbox text, zero PUTs were issued!
    expect(postBodies).toEqual([
      { parentId: "real-dir", name: "Entry.md", content: "edited offline" },
    ]);
    expect(putCalls).toEqual([]);

    // Dexie remapped atomically.
    expect(await readAllPendingOps()).toEqual([]);
    expect(await readPendingWrite(note.node.id)).toBeUndefined();
    expect(await readPendingWrite("real-note")).toBeUndefined();
    expect(await readCachedFile("real-note")).toEqual({
      text: "edited offline",
      revision: '"etag-created"',
    });
    const folders = await readAllCachedFolders();
    expect(folders.find((f) => f.folderId === dir.node.id)).toBeUndefined();
    expect(folders.find((f) => f.folderId === "real-dir")?.nodes.map((n) => n.id)).toEqual([
      "real-note",
    ]);

    // React Query & VaultIndex remapped.
    expect(
      queryClient.getQueryData<DriveNode[]>(childrenKey("real-dir"))?.map((n) => n.id),
    ).toEqual(["real-note"]);
    expect(queryClient.getQueryData(["files", "real-note", "content"])).toEqual({
      text: "edited offline",
      revision: '"etag-created"',
    });
    const updatedIndex = queryClient.getQueryData<VaultIndex>(VAULT_INDEX_KEY);
    expect(updatedIndex?.folders.map((f) => f.id)).toEqual(["real-dir"]);
    expect(updatedIndex?.files.map((f) => [f.id, f.parentId])).toEqual([["real-note", "real-dir"]]);

    // URL, localStorage, recent files, expanded folders, SyncQueue, and onIdRemapped updated.
    expect(getOpenFileId()).toBe("real-note");
    expect(readLastOpenFile()).toBe("real-note");
    expect(window.history.length).toBe(historyLengthBefore);
    expect(getRecentFileIds()).toContain("real-note");
    expect(getRecentFileIds()).not.toContain(note.node.id);
    expect(readExpandedFolders("root")).toEqual(["real-dir"]);
    expect(expandedEvents).toContainEqual(["real-dir"]);
    expect(syncQueue.getFileState(note.node.id).status).toBe("idle");
    expect(syncQueue.getFileState("real-note").status).toBe("synced");
    expect(remapped.map((r) => [r.kind, r.localId, r.realId])).toEqual([
      ["folder", dir.node.id, "real-dir"],
      ["file", note.node.id, "real-note"],
    ]);

    unsubExpanded();
    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("chains mid-POST edits via sentSeq and automatically PUTs the follow-up edit with fresh ETag", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    const created = await opsQueue.createFile({
      parentId: "root",
      name: "LiveEdit.md",
      initialContent: "v0",
    });
    syncQueue.enqueueSave(created.node.id, "v1", "", "v0");
    await vi.waitFor(async () => {
      expect((await readPendingWrite(created.node.id))?.text).toBe("v1");
    });

    const postGate = deferred<void>();
    const posts: string[] = [];
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.post("/api/folders/root/files", async ({ request }) => {
        const body = (await request.json()) as { content: string };
        posts.push(body.content);
        await postGate.promise;
        return HttpResponse.json(makeNode("real-live", "LiveEdit.md", "markdown"), {
          status: 201,
          headers: { ETag: '"etag-1"' },
        });
      }),
      http.put("/api/files/real-live/content", async ({ request }) => {
        puts.push({ ifMatch: request.headers.get("If-Match"), text: await request.text() });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    setOnline(true);
    const flushPromise = opsQueue.flushAll();
    await vi.waitFor(() => {
      expect(posts).toEqual(["v1"]);
    });

    // User keeps typing while POST is in flight!
    syncQueue.enqueueSave(created.node.id, "v2 while posting", "", "v0");
    await vi.waitFor(async () => {
      expect((await readPendingWrite(created.node.id))?.text).toBe("v2 while posting");
    });

    postGate.resolve();
    await flushPromise;

    await vi.waitFor(() => {
      expect(puts).toEqual([{ ifMatch: '"etag-1"', text: "v2 while posting" }]);
    });
    await vi.waitFor(async () => {
      expect(await readCachedFile("real-live")).toEqual({
        text: "v2 while posting",
        revision: '"etag-2"',
      });
    });
    expect(syncQueue.getFileState("real-live").status).toBe("synced");

    opsQueue.dispose();
    syncQueue.dispose();
  });
});

describe("Hybrid eager-online execution & transient fallback", () => {
  it("rejects permanent 409/400 errors inline when online without queuing", async () => {
    setOnline(true);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    const doc = makeNode("doc-1", "Note.md", "markdown");
    queryClient.setQueryData(childrenKey("root"), [doc]);

    server.use(
      http.post("/api/folders/root/folders", () =>
        HttpResponse.json({ code: "name_exists", message: "Already exists" }, { status: 409 }),
      ),
      http.patch("/api/files/doc-1", () =>
        HttpResponse.json({ code: "invalid_move", message: "Bad move" }, { status: 400 }),
      ),
    );

    await expect(opsQueue.createFolder({ parentId: "root", name: "Dup" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(opsQueue.moveFile("doc-1", "dir-bad", "root")).rejects.toBeInstanceOf(ApiError);
    expect(await readAllPendingOps()).toEqual([]);

    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("falls back cleanly to queuing with auto-retry when online request hits a transient error", async () => {
    setOnline(true);
    const onNetworkError = vi.fn();
    const { queryClient, syncQueue, opsQueue } = makeHarness({ onNetworkError });
    queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);

    let attempts = 0;
    server.use(
      http.post("/api/folders/root/files", () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.error(); // triggers TypeError
        }
        return HttpResponse.json(makeNode("real-after-retry", "Flaky.md", "markdown"), {
          status: 201,
          headers: { ETag: '"e1"' },
        });
      }),
    );

    const res = await opsQueue.createFile({
      parentId: "root",
      name: "Flaky.md",
      initialContent: "draft",
    });
    expect(res.status).toBe("queued");
    expect(isLocalId(res.node.id)).toBe(true);
    expect(onNetworkError).toHaveBeenCalledTimes(1);

    const view = opsQueue.getSnapshot().ops[0];
    expect(view.state.status).toBe("error");
    if (view.state.status === "error") {
      expect(view.state.retry?.attempt).toBe(1);
    }

    // Manual retry flushes cleanly.
    await opsQueue.retryOp(view.op.opId);
    expect(await readAllPendingOps()).toEqual([]);
    expect(findNode(queryClient, "real-after-retry")?.name).toBe("Flaky.md");

    opsQueue.dispose();
    syncQueue.dispose();
  });
});

describe("discardOp rollback", () => {
  it("rolls back rename, move, delete_file, delete_folder, and create_folder cleanly", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();

    const doc = makeNode("doc-1", "Orig.md", "markdown");
    const folderA = makeNode("dir-a", "FolderA", "folder");
    const folderB = makeNode("dir-b", "FolderB", "folder");
    const insideA = makeNode("f-in-a", "InsideA.md", "markdown");
    queryClient.setQueryData(childrenKey("root"), [doc, folderA, folderB]);
    queryClient.setQueryData(childrenKey("dir-a"), [insideA]);
    queryClient.setQueryData(childrenKey("dir-b"), []);
    queryClient.setQueryData(["files", "doc-1", "content"], { text: "body1", revision: '"r1"' });
    await writeCachedFolder("root", [doc, folderA, folderB]);
    await writeCachedFolder("dir-a", [insideA]);
    await writeCachedFolder("dir-b", []);
    await writeCachedFile("doc-1", "body1", '"r1"');
    await writeCachedFile("f-in-a", "inside body", '"ra"');

    // 1. Discard rename_file -> reverts to Orig.md.
    const ren = await opsQueue.renameFile("doc-1", "Changed.md", "Orig.md");
    expect(findNode(queryClient, "doc-1")?.name).toBe("Changed.md");
    await opsQueue.discardOp(ren.opId!);
    expect(findNode(queryClient, "doc-1")?.name).toBe("Orig.md");

    // 2. Discard move_file -> moves back to root.
    const mov = await opsQueue.moveFile("doc-1", "dir-b", "root");
    expect(queryClient.getQueryData<DriveNode[]>(childrenKey("dir-b"))?.map((n) => n.id)).toContain(
      "doc-1",
    );
    await opsQueue.discardOp(mov.opId!);
    expect(queryClient.getQueryData<DriveNode[]>(childrenKey("root"))?.map((n) => n.id)).toContain(
      "doc-1",
    );
    expect(
      queryClient.getQueryData<DriveNode[]>(childrenKey("dir-b"))?.map((n) => n.id),
    ).not.toContain("doc-1");

    // 3. Discard delete_file -> restores node + content and unmarks syncQueue.deletedFiles.
    const delFile = await opsQueue.deleteFile("doc-1", "root");
    expect(findNode(queryClient, "doc-1")).toBeUndefined();
    expect(syncQueue.isDeleted("doc-1")).toBe(true);
    await opsQueue.discardOp(delFile.opId!);
    expect(findNode(queryClient, "doc-1")?.name).toBe("Orig.md");
    expect((await readCachedFile("doc-1"))?.text).toBe("body1");
    expect(syncQueue.isDeleted("doc-1")).toBe(false);

    // 4. Discard delete_folder -> restores folder + child note & content.
    const delDir = await opsQueue.deleteFolder("dir-a", "root");
    expect(findNode(queryClient, "dir-a")).toBeUndefined();
    await opsQueue.discardOp(delDir.opId!);
    expect(findNode(queryClient, "dir-a")?.name).toBe("FolderA");
    expect(queryClient.getQueryData<DriveNode[]>(childrenKey("dir-a"))?.map((n) => n.id)).toEqual([
      "f-in-a",
    ]);
    expect((await readCachedFile("f-in-a"))?.text).toBe("inside body");

    // 5. Discard create_folder that had a moved real file -> removes local folder & restores real file to root.
    const localDir = await opsQueue.createFolder({ parentId: "root", name: "TempDir" });
    await opsQueue.moveFile("doc-1", localDir.node.id, "root");
    await opsQueue.discardOp(localDir.opId!);
    expect(findNode(queryClient, localDir.node.id)).toBeUndefined();
    expect(queryClient.getQueryData<DriveNode[]>(childrenKey("root"))?.map((n) => n.id)).toContain(
      "doc-1",
    );
    expect(await readAllPendingOps()).toEqual([]);

    opsQueue.dispose();
    syncQueue.dispose();
  });
});

describe("overlayListing, overlayVaultIndex, VaultSync, cloudState, vaultDocuments & deduplicated count", () => {
  it("protects local creates, renames, moves, and deletes against stale remote listings", async () => {
    setOnline(false);
    const { queryClient, syncQueue, opsQueue } = makeHarness();
    const a = makeNode("f-a", "A.md", "markdown");
    const b = makeNode("f-b", "B.md", "markdown");
    const c = makeNode("f-c", "C.md", "markdown");
    const sub = makeNode("sub-1", "Sub", "folder");
    queryClient.setQueryData(childrenKey("root"), [a, b, c, sub]);
    queryClient.setQueryData(childrenKey("sub-1"), []);
    await writeCachedFolder("root", [a, b, c, sub]);
    await writeCachedFolder("sub-1", []);

    const created = await opsQueue.createFile({ parentId: "root", name: "NewLocal.md" });
    await opsQueue.renameFile("f-a", "A-Renamed.md", "A.md");
    await opsQueue.moveFile("f-b", "sub-1", "root");
    await opsQueue.deleteFile("f-c", "root");

    // Stale remote listing arrives from Drive before flush completes:
    const overlaidRoot = opsQueue.overlayListing("root", [a, b, c, sub]);
    expect(overlaidRoot.map((n) => [n.id, n.name])).toEqual([
      ["f-a", "A-Renamed.md"],
      ["sub-1", "Sub"],
      [created.node.id, "NewLocal.md"],
    ]);
    const overlaidSub = opsQueue.overlayListing("sub-1", []);
    expect(overlaidSub.map((n) => n.id)).toEqual(["f-b"]);

    // VaultSync skips downloading pending-deleted and local files and overlays the index.
    const downloaded: string[] = [];
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json<VaultIndex>({
          rootId: "root",
          folders: [{ id: "sub-1", name: "Sub", parentId: "root", modifiedTime: MODIFIED }],
          files: [
            { id: "f-a", name: "A.md", parentId: "root", modifiedTime: MODIFIED },
            { id: "f-b", name: "B.md", parentId: "root", modifiedTime: MODIFIED },
            { id: "f-c", name: "C.md", parentId: "root", modifiedTime: MODIFIED },
          ],
          truncated: false,
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) => {
        downloaded.push(String(params.id));
        return new HttpResponse("remote text", {
          status: 200,
          headers: { "Content-Type": "text/markdown", ETag: '"e-remote"' },
        });
      }),
    );

    const vaultSync = new VaultSync(queryClient, {
      overlayListing: opsQueue.overlayListing,
      overlayVaultIndex: opsQueue.overlayVaultIndex,
      isPendingDeleted: opsQueue.isPendingDeleted,
    });
    setOnline(true);
    await vaultSync.run();

    // f-c (pending delete) and created.node.id (local:) must NEVER be fetched!
    expect(downloaded.sort()).toEqual(["f-a", "f-b"]);
    const index = queryClient.getQueryData<VaultIndex>(VAULT_INDEX_KEY);
    expect(index?.files.find((f) => f.id === "f-c")).toBeUndefined();
    expect(index?.files.find((f) => f.id === "f-a")?.name).toBe("A-Renamed.md");
    expect(index?.files.find((f) => f.id === "f-b")?.parentId).toBe("sub-1");
    expect(index?.files.find((f) => f.id === created.node.id)?.name).toBe("NewLocal.md");

    vaultSync.dispose();
    opsQueue.dispose();
    syncQueue.dispose();
  });

  it("filters local: ids from cloudState, guards local: templates in vaultDocuments, and deduplicates pending counts", async () => {
    const localFile = makeLocalId();
    const localFolder = makeLocalId();
    window.history.replaceState(null, "", `/?file=${encodeURIComponent(localFile)}`);
    writeExpandedFolders("root", ["real-dir", localFolder]);

    const cloud = readLocalCloudState("root");
    expect(cloud.lastOpenFileId).toBeNull();
    expect(cloud.expandedFolders).toEqual(["real-dir"]);

    // vaultDocuments.readTemplates must never fetch local: folder or local: file IDs over HTTP.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["root"], makeNode("root", "Vault", "folder"));
    queryClient.setQueryData(childrenKey("root"), [makeNode(localFolder, "Templates", "folder")]);
    // Unloaded local Templates folder -> no HTTP call.
    expect(await readTemplates(queryClient)).toEqual([]);

    // Loaded local Templates folder with uncached local note -> no HTTP call.
    queryClient.setQueryData(childrenKey(localFolder), [
      makeNode(localFile, "Daily.md", "markdown"),
    ]);
    expect(await readTemplates(queryClient)).toEqual([]);

    // Deduplicated total pending count: local create_file in BOTH ops and syncStates counts once.
    const now = Date.now();
    const createOp: PendingOp = {
      opId: "op-1",
      kind: "create_file",
      targetId: localFile,
      targetName: "Draft.md",
      parentId: "root",
      name: "Draft.md",
      initialContent: "",
      createdAt: now,
      updatedAt: now,
    };
    const count = countTotalPendingSync(
      [{ op: createOp, state: { status: "pending" } }],
      new Map([
        [localFile, { status: "pending" }],
        ["real-1", { status: "pending" }],
        ["real-2", { status: "synced" }],
      ]),
    );
    expect(count).toBe(2); // op-1 (localFile deduplicated) + real-1
  });

  it("adopts existing remote file when openExistingOnConflict note is untouched, hydrates across reload, discards create_file, cancels on resetAll, and guards DriveChanges", async () => {
    // 1. Untouched openExistingOnConflict adopts remote file across reload via hydrate(true).
    setOnline(false);
    const h1 = makeHarness();
    h1.queryClient.setQueryData(childrenKey("root"), []);
    await writeCachedFolder("root", []);
    const untouched = await h1.opsQueue.createFile({
      parentId: "root",
      name: "2026-11-23.md",
      initialContent: "# 2026-11-23\n\n",
      openExistingOnConflict: true,
    });
    const toDiscard = await h1.opsQueue.createFile({
      parentId: "root",
      name: "DiscardMe.md",
      initialContent: "temp",
    });
    h1.opsQueue.dispose();
    h1.syncQueue.dispose();

    // Simulate reload: fresh OpsQueue hydrates persisted db.ops.
    const h2 = makeHarness();
    h2.queryClient.setQueryData(childrenKey("root"), [untouched.node, toDiscard.node]);
    await h2.opsQueue.hydrate(false);
    expect(h2.opsQueue.getSnapshot().pendingCount).toBe(2);

    // Discard create_file removes it cleanly.
    await h2.opsQueue.discardOp(toDiscard.opId!);
    expect(findNode(h2.queryClient, toDiscard.node.id)).toBeUndefined();
    expect(h2.opsQueue.getSnapshot().pendingCount).toBe(1);

    server.use(
      http.post("/api/folders/root/files", () =>
        HttpResponse.json({ code: "name_exists", message: "Exists" }, { status: 409 }),
      ),
      http.get("/api/folders/root/children", () =>
        HttpResponse.json({ nodes: [makeNode("real-existing", "2026-11-23.md", "markdown")] }),
      ),
    );
    setOnline(true);
    await h2.opsQueue.flushAll();
    expect(await readAllPendingOps()).toEqual([]);
    expect(findNode(h2.queryClient, "real-existing")?.name).toBe("2026-11-23.md");

    // 2. resetAll() cancels in-flight flush commit.
    setOnline(false);
    const inFlightNote = await h2.opsQueue.createFile({ parentId: "root", name: "Race.md" });
    const gate = deferred<void>();
    server.use(
      http.post("/api/folders/root/files", async () => {
        await gate.promise;
        return HttpResponse.json(makeNode("late-real", "Race.md", "markdown"), {
          status: 201,
          headers: { ETag: '"e-late"' },
        });
      }),
    );
    setOnline(true);
    const flushP = h2.opsQueue.flushAll();
    await vi.waitFor(() => {
      expect(h2.opsQueue.getSnapshot().syncing).toBe(true);
    });
    h2.opsQueue.resetAll();
    gate.resolve();
    await flushP;
    expect(findNode(h2.queryClient, "late-real")).toBeUndefined();
    expect(findNode(h2.queryClient, inFlightNote.node.id)).toBeDefined();

    // 3. DriveChanges never fetches content for local: openFileId.
    const changes = new DriveChanges(h2.queryClient);
    const localOpen = makeLocalId();
    changes.setOpenFileId(localOpen);
    server.use(
      http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "tok-1" })),
      http.get("/api/changes", () =>
        HttpResponse.json({
          nextPageToken: "tok-2",
          hasMore: false,
          changes: [
            {
              fileId: localOpen,
              removed: false,
              time: MODIFIED,
              node: makeNode(localOpen, "Local.md", "markdown"),
              parentIds: ["root"],
            },
          ],
        }),
      ),
    );
    await changes.poll(); // gets start token
    await changes.poll(); // reads change mentioning localOpen without calling /api/files/local:.../content
    expect(changes.getSnapshot().external).toBeNull();

    changes.dispose();
    h2.opsQueue.dispose();
    h2.syncQueue.dispose();
  });
});
