import { QueryClient } from "@tanstack/react-query";
import { HttpResponse, delay, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { DriveNode, VaultIndex } from "./api";
import {
  readCachedFile,
  readVaultState,
  upsertPendingWrite,
  writeCachedFile,
  writeCachedSession,
} from "./localCache";
import { childrenKey, VAULT_INDEX_KEY } from "./treeCache";
import { VAULT_PIN_STORAGE_KEY, VAULT_SYNC_CONCURRENCY, VaultSync } from "./vaultSync";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => writeCachedSession("owner@example.com"));
afterEach(() => {
  server.resetHandlers();
  localStorage.removeItem(VAULT_PIN_STORAGE_KEY);
});
afterAll(() => server.close());

const OLD = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

function index(files: { id: string; modifiedTime: string; parentId?: string }[]): VaultIndex {
  return {
    rootId: "root",
    folders: [{ id: "sub", name: "Sub", parentId: "root", modifiedTime: OLD }],
    files: files.map((file) => ({
      id: file.id,
      name: `${file.id}.md`,
      parentId: file.parentId ?? "root",
      modifiedTime: file.modifiedTime,
    })),
    truncated: false,
  };
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("VaultSync", () => {
  it("seeds folder listings and downloads only missing or stale notes", async () => {
    await writeCachedFile("fresh", "kept", '"r1"');
    await writeCachedFile("stale", "old text", '"r1"');
    const fetched: string[] = [];
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json(
          index([
            { id: "fresh", modifiedTime: OLD },
            { id: "stale", modifiedTime: FUTURE },
            { id: "missing", modifiedTime: OLD, parentId: "sub" },
          ]),
        ),
      ),
      http.get("/api/files/:id/content", ({ params }) => {
        fetched.push(String(params.id));
        return new HttpResponse(`text of ${String(params.id)}`, { headers: { ETag: '"r2"' } });
      }),
    );
    const queryClient = client();
    const sync = new VaultSync(queryClient);
    await sync.run();

    expect(fetched.sort()).toEqual(["missing", "stale"]);
    expect((await readCachedFile("fresh"))?.text).toBe("kept");
    expect((await readCachedFile("stale"))?.text).toBe("text of stale");
    expect((await readCachedFile("missing"))?.text).toBe("text of missing");
    expect(queryClient.getQueryData<DriveNode[]>(childrenKey("sub"))?.map((n) => n.id)).toEqual([
      "missing",
    ]);
    expect(queryClient.getQueryData(VAULT_INDEX_KEY)).toBeDefined();
    const snapshot = sync.getSnapshot();
    expect(snapshot).toMatchObject({ running: false, total: 3, cached: 3, failed: 0 });
    expect(snapshot.lastSyncedAt).not.toBeNull();
    expect(await readVaultState()).toMatchObject({ total: 3, cached: 3 });
  });

  it("never overwrites a note with local edits waiting to sync", async () => {
    await upsertPendingWrite("dirty", "my edit", '"r1"', "base");
    let fetched = 0;
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json(index([{ id: "dirty", modifiedTime: FUTURE }])),
      ),
      http.get("/api/files/:id/content", () => {
        fetched += 1;
        return new HttpResponse("theirs", { headers: { ETag: '"r2"' } });
      }),
    );
    await new VaultSync(client()).run();
    expect(fetched).toBe(0);
  });

  it(`keeps at most ${VAULT_SYNC_CONCURRENCY} downloads in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json(
          index(Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, modifiedTime: OLD }))),
        ),
      ),
      http.get("/api/files/:id/content", async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(5);
        inFlight -= 1;
        return new HttpResponse("x", { headers: { ETag: '"r"' } });
      }),
    );
    const sync = new VaultSync(client());
    await sync.run();
    expect(peak).toBeLessThanOrEqual(VAULT_SYNC_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(sync.getSnapshot().cached).toBe(9);
  });

  it("waits out a 429 Retry-After and then retries the same note", async () => {
    let calls = 0;
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json(index([{ id: "a", modifiedTime: OLD }])),
      ),
      http.get("/api/files/:id/content", () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { code: "rate_limited", message: "Slow down" },
            { status: 429, headers: { "Retry-After": "0" } },
          );
        }
        return new HttpResponse("ok", { headers: { ETag: '"r"' } });
      }),
    );
    const sync = new VaultSync(client());
    await sync.run();
    expect(calls).toBe(2);
    expect(sync.getSnapshot()).toMatchObject({ cached: 1, failed: 0 });
  });

  it("counts a failed note and carries on with the rest", async () => {
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json(
          index([
            { id: "bad", modifiedTime: OLD },
            { id: "good", modifiedTime: OLD },
          ]),
        ),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        params.id === "bad"
          ? HttpResponse.json({ code: "drive_error", message: "Boom" }, { status: 502 })
          : new HttpResponse("ok", { headers: { ETag: '"r"' } }),
      ),
    );
    const sync = new VaultSync(client());
    await sync.run();
    expect(sync.getSnapshot()).toMatchObject({ cached: 1, failed: 1, total: 2 });
  });

  it("stops cleanly when unpinned mid-run", async () => {
    let started = 0;
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json(
          index(Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, modifiedTime: OLD }))),
        ),
      ),
      http.get("/api/files/:id/content", async () => {
        started += 1;
        await delay(20);
        return new HttpResponse("x", { headers: { ETag: '"r"' } });
      }),
    );
    const sync = new VaultSync(client());
    sync.setPinned(true);
    expect(localStorage.getItem(VAULT_PIN_STORAGE_KEY)).toBe("1");
    await expect.poll(() => started).toBeGreaterThan(0);
    sync.setPinned(false);
    expect(sync.getSnapshot()).toMatchObject({ pinned: false, running: false });
    expect(localStorage.getItem(VAULT_PIN_STORAGE_KEY)).toBeNull();
    const startedAtStop = started;
    await delay(80);
    expect(started).toBe(startedAtStop);
    expect(await readVaultState()).toBeUndefined();
  });
});
