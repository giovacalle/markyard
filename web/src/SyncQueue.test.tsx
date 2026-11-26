import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { AUTOSAVE_DELAY_MS } from "./components/DocumentView";
import { readCachedFile, readPendingWrite } from "./localCache";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function contentResponse(body: BodyInit, etag = '"etag-1"') {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function getEditorTextbox(region: HTMLElement): HTMLElement {
  const host = region.querySelector('[data-testid="editor-host"]');
  const shadow = host?.shadowRoot;
  const textbox = shadow?.querySelector<HTMLElement>('[role="textbox"][aria-label="Note text"]');
  if (!textbox) {
    throw new Error("CodeMirror textbox not found inside shadow root");
  }
  return textbox;
}

async function getEditorView(region: HTMLElement): Promise<EditorView> {
  await vi.waitFor(() => getEditorTextbox(region));
  const view = EditorView.findFromDOM(getEditorTextbox(region));
  if (!view) {
    throw new Error("CodeMirror EditorView not found on textbox");
  }
  return view;
}

function pressSave() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

async function enterEditor(): Promise<HTMLElement> {
  const preview = await screen.findByRole("region", { name: "Preview" });
  const canvas = await within(preview).findByTestId("editor-canvas");
  fireEvent.click(canvas);
  return screen.findByRole("region", { name: "Editor" });
}

describe("local-first writes and background sync queue", () => {
  it("saves locally while offline, survives reload, and syncs to Drive automatically on reconnect", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("doc-1", "a.md", "markdown")] }),
      ),
      http.get("/api/files/doc-1/content", () => contentResponse("# Initial", '"etag-1"')),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push({
          ifMatch: request.headers.get("If-Match"),
          text: await request.text(),
        });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    const first = render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("# Initial"));

    // Go offline, edit the note, and press Cmd+S.
    setOnline(false);
    act(() => {
      view.dispatch({ changes: { from: 0, to: "# Initial".length, insert: "# Offline edit" } });
    });
    pressSave();

    expect(await within(editor).findByText("Saved locally")).toBeInTheDocument();
    expect(
      await screen.findByText("Offline — 1 note saved locally, will sync when online"),
    ).toBeInTheDocument();
    expect(puts).toHaveLength(0);

    await vi.waitFor(async () => {
      expect(await readPendingWrite("doc-1")).toMatchObject({
        fileId: "doc-1",
        text: "# Offline edit",
        baseRevision: '"etag-1"',
      });
    });

    // Unmount and cold-reopen while still offline: the local edit is preserved.
    first.unmount();
    server.use(
      http.get("/api/session", () => HttpResponse.error()),
      http.get("/api/root", () => HttpResponse.error()),
      http.get("/api/folders/:id/children", () => HttpResponse.error()),
      http.get("/api/files/:id/content", () => HttpResponse.error()),
    );

    render(<App />);
    const offlinePreview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(offlinePreview).findByRole("heading", { level: 3, name: "Offline edit" }),
    ).toBeInTheDocument();
    expect(await within(offlinePreview).findByText("Saved locally")).toBeInTheDocument();

    // Restore Drive endpoints and come back online: outbox flushes automatically in background.
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("doc-1", "a.md", "markdown")] }),
      ),
      http.get("/api/files/doc-1/content", () => contentResponse("# Initial", '"etag-1"')),
    );
    setOnline(true);

    expect(await within(offlinePreview).findByText("Saved")).toBeInTheDocument();
    expect(puts).toEqual([{ ifMatch: '"etag-1"', text: "# Offline edit" }]);
    await vi.waitFor(async () => {
      expect(await readPendingWrite("doc-1")).toBeUndefined();
      expect(await readCachedFile("doc-1")).toEqual({
        text: "# Offline edit",
        revision: '"etag-2"',
      });
    });
  });

  it("finishes syncing in the background even after switching to another note", async () => {
    let resolvePut!: () => void;
    const putGate = new Promise<void>((r) => {
      resolvePut = r;
    });
    const puts: { fileId: string; ifMatch: string | null; text: string }[] = [];

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [node("a-id", "a.md", "markdown"), node("b-id", "b.md", "markdown")],
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(params.id === "a-id" ? "# A" : "# B", `"etag-${String(params.id)}"`),
      ),
      http.put("/api/files/:id/content", async ({ params, request }) => {
        puts.push({
          fileId: String(params.id),
          ifMatch: request.headers.get("If-Match"),
          text: await request.text(),
        });
        await putGate;
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-a-2"' } });
      }),
    );

    const confirmSpy = vi.spyOn(window, "confirm");
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("treeitem", { name: /a\.md/ }));
      const editor = await enterEditor();
      const view = await getEditorView(editor);

      act(() => {
        view.dispatch({ changes: { from: 0, to: "# A".length, insert: "# A saved in bg" } });
      });
      pressSave();
      expect(await within(editor).findByText("Saving…")).toBeInTheDocument();

      // Switch immediately to b.md while a.md is still syncing: no confirm prompt needed,
      // and b.md opens in rendered Markdown preview.
      fireEvent.click(screen.getByRole("treeitem", { name: /b\.md/ }));
      expect(confirmSpy).not.toHaveBeenCalled();
      const bPreview = await screen.findByRole("region", { name: "Preview" });
      expect(
        await within(bPreview).findByRole("heading", { level: 3, name: "B" }),
      ).toBeInTheDocument();

      // Let background PUT for a.md complete while b.md is open.
      resolvePut();
      await vi.waitFor(async () => {
        expect(await readPendingWrite("a-id")).toBeUndefined();
        expect(await readCachedFile("a-id")).toEqual({
          text: "# A saved in bg",
          revision: '"etag-a-2"',
        });
      });
      expect(puts).toEqual([{ fileId: "a-id", ifMatch: '"etag-a-id"', text: "# A saved in bg" }]);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("chains ETags automatically when a newer edit is saved while a previous sync is in flight", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    let resolveFirstPut!: () => void;
    const firstPutGate = new Promise<void>((r) => {
      resolveFirstPut = r;
    });
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("doc-1", "a.md", "markdown")] }),
      ),
      http.get("/api/files/doc-1/content", () => contentResponse("v0", '"etag-0"')),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        const callIndex = puts.length;
        puts.push({
          ifMatch: request.headers.get("If-Match"),
          text: await request.text(),
        });
        if (callIndex === 0) {
          await firstPutGate;
          return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-1"' } });
        }
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("v0"));

    // Save v1 (stays in flight).
    act(() => {
      view.dispatch({ changes: { from: 0, to: 2, insert: "v1" } });
    });
    pressSave();
    await vi.waitFor(() => expect(puts).toHaveLength(1));

    // Edit to v2 and save again before PUT 1 returns.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 2, insert: "v2" } });
    });
    pressSave();
    await vi.waitFor(async () => {
      expect((await readPendingWrite("doc-1"))?.text).toBe("v2");
    });

    // Release PUT 1 -> SyncQueue chains "etag-1" into PUT 2 automatically.
    resolveFirstPut();

    expect(await within(editor).findByText("Saved")).toBeInTheDocument();
    expect(puts).toEqual([
      { ifMatch: '"etag-0"', text: "v1" },
      { ifMatch: '"etag-1"', text: "v2" },
    ]);
    await vi.waitFor(async () => {
      expect(await readCachedFile("doc-1")).toEqual({ text: "v2", revision: '"etag-2"' });
    });
  });

  it("autosaves after a pause without pressing Cmd+S", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    const puts: { ifMatch: string | null; text: string }[] = [];

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("doc-1", "a.md", "markdown")] }),
      ),
      http.get("/api/files/doc-1/content", () => contentResponse("hello", '"etag-1"')),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push({
          ifMatch: request.headers.get("If-Match"),
          text: await request.text(),
        });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("hello"));

    act(() => {
      view.dispatch({ changes: { from: 5, to: 5, insert: " autosave" } });
    });
    expect(within(editor).getByRole("status")).toHaveTextContent("Unsaved changes");

    // Wait just past AUTOSAVE_DELAY_MS without pressing Cmd+S.
    expect(
      // test-timeout-allowed: waits out the real 1.5 s AUTOSAVE_DELAY_MS, longer than the default timeout.
      await within(editor).findByText("Saved", {}, { timeout: AUTOSAVE_DELAY_MS + 1_500 }),
    ).toBeInTheDocument();
    expect(puts).toEqual([{ ifMatch: '"etag-1"', text: "hello autosave" }]);
  });
});
