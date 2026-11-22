import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import {
  readCachedAccount,
  readCachedFile,
  writeCachedFile,
  writeCachedFolder,
  writeCachedRoot,
  writeCachedSession,
} from "./localCache";
import { CLOUD_STATE_STAMP_KEY } from "./cloudStateStamp";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

async function enterEditor(): Promise<HTMLElement> {
  const preview = await screen.findByRole("region", { name: "Preview" });
  const canvas = await within(preview).findByTestId("editor-canvas");
  fireEvent.click(canvas);
  return screen.findByRole("region", { name: "Editor" });
}

describe("local IndexedDB read cache (Dexie)", () => {
  it("opens cached dashboard, tree, and notes immediately when offline", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [node("a-id", "alpha.md", "markdown"), node("b-id", "beta.md", "markdown")],
        }),
      ),
      http.get(
        "/api/files/a-id/content",
        () => new HttpResponse("# Alpha cached", { status: 200, headers: { ETag: '"e-a"' } }),
      ),
      http.get(
        "/api/files/b-id/content",
        () => new HttpResponse("# Beta cached", { status: 200, headers: { ETag: '"e-b"' } }),
      ),
    );

    const first = render(<App />);
    const alphaItem = await screen.findByRole("treeitem", { name: /alpha\.md/ });
    fireEvent.click(alphaItem);
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Alpha cached" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("treeitem", { name: /beta\.md/ }));
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Beta cached" }),
    ).toBeInTheDocument();

    // Wait for Dexie background writes to settle before simulating a cold offline reopen.
    await vi.waitFor(async () => {
      expect(await readCachedFile("b-id")).toEqual({ text: "# Beta cached", revision: '"e-b"' });
    });
    first.unmount();

    // Now simulate completely offline reopen at /?file=b-id.
    server.use(
      http.get("/api/session", () => HttpResponse.error()),
      http.get("/api/root", () => HttpResponse.error()),
      http.get("/api/folders/:id/children", () => HttpResponse.error()),
      http.get("/api/files/:id/content", () => HttpResponse.error()),
    );

    render(<App />);
    expect(await screen.findByRole("treeitem", { name: /alpha\.md/ })).toBeInTheDocument();
    const offlinePreview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(offlinePreview).findByRole("heading", { level: 3, name: "Beta cached" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Offline — showing cached notes")).toBeInTheDocument();
    expect(within(offlinePreview).getByRole("banner")).toHaveAttribute("data-offline", "true");

    // Switching to another previously viewed note also works offline from IndexedDB.
    fireEvent.click(screen.getByRole("treeitem", { name: /alpha\.md/ }));
    expect(
      await within(offlinePreview).findByRole("heading", { level: 3, name: "Alpha cached" }),
    ).toBeInTheDocument();
  });

  it("renders cached data immediately while Drive revalidates in the background", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("a-id", "old.md", "markdown")]);
    await writeCachedFile("a-id", "# Old cached version", '"e-1"');
    history.replaceState(null, "", "/?file=a-id");

    const childrenGate = deferred<Response>();
    const contentGate = deferred<Response>();

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () => childrenGate.promise),
      http.get("/api/files/a-id/content", () => contentGate.promise),
    );

    render(<App />);

    // Both cached tree and cached note content appear before Drive responds.
    expect(await screen.findByRole("treeitem", { name: /old\.md/ })).toBeInTheDocument();
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Old cached version" }),
    ).toBeInTheDocument();

    // Background Drive responses arrive with fresher tree and note content.
    childrenGate.resolve(
      HttpResponse.json({
        nodes: [node("a-id", "old.md", "markdown"), node("new-id", "fresh.md", "markdown")],
      }),
    );
    contentGate.resolve(
      new HttpResponse("# Fresh from Drive", { status: 200, headers: { ETag: '"e-2"' } }),
    );

    expect(await screen.findByRole("treeitem", { name: /fresh\.md/ })).toBeInTheDocument();
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Fresh from Drive" }),
    ).toBeInTheDocument();
  });

  it("never overwrites unsaved local edits when background Drive revalidation finishes", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("a-id", "alpha.md", "markdown")]);
    await writeCachedFile("a-id", "# Cached", '"e-1"');
    history.replaceState(null, "", "/?file=a-id");

    const contentGate = deferred<Response>();
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "alpha.md", "markdown")] }),
      ),
      http.get("/api/files/a-id/content", () => contentGate.promise),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({ changes: { from: 0, to: "# Cached".length, insert: "# My unsaved edit" } });
    });

    // Background revalidation returns newer content on Drive.
    contentGate.resolve(
      new HttpResponse("# Changed remotely", { status: 200, headers: { ETag: '"e-2"' } }),
    );

    // Give React/Query a tick to process the response.
    await vi.waitFor(async () => {
      expect(await readCachedFile("a-id")).toEqual({
        text: "# Changed remotely",
        revision: '"e-2"',
      });
    });

    // The active editor keeps the user's unsaved text untouched.
    expect(view.state.doc.toString()).toBe("# My unsaved edit");
    expect(within(editor).getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("updates IndexedDB after saving and creating a note", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes: [] })),
      http.post("/api/folders/root-id/files", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json(node("created-1", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"e-created"' },
        });
      }),
      http.put(
        "/api/files/created-1/content",
        () => new HttpResponse(null, { status: 204, headers: { ETag: '"e-saved"' } }),
      ),
    );

    const first = render(<App />);
    await screen.findByText("This folder is empty.");

    fireEvent.click(screen.getByRole("button", { name: "Create a note" }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "# Saved locally too" } });
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => {
      expect(within(editor).getByRole("status")).toHaveTextContent("Saved");
    });

    await vi.waitFor(async () => {
      expect(await readCachedFile("created-1")).toEqual({
        text: "# Saved locally too",
        revision: '"e-saved"',
      });
    });
    first.unmount();

    // Reopen offline: the newly created & saved note is available in the tree and preview.
    server.use(
      http.get("/api/session", () => HttpResponse.error()),
      http.get("/api/root", () => HttpResponse.error()),
      http.get("/api/folders/:id/children", () => HttpResponse.error()),
      http.get("/api/files/:id/content", () => HttpResponse.error()),
    );

    render(<App />);
    expect(await screen.findByRole("treeitem", { name: /Untitled\.md/ })).toBeInTheDocument();
    const offlinePreview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(offlinePreview).findByRole("heading", { level: 3, name: "Saved locally too" }),
    ).toBeInTheDocument();
  });

  it("clears IndexedDB on sign out and when the session ends (401)", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("a-id", "secret.md", "markdown")]);
    await writeCachedFile("a-id", "# Secret", '"e-1"');

    server.use(
      http.get("/api/session", () =>
        HttpResponse.json({ code: "session_ended", message: "Ended" }, { status: 401 }),
      ),
    );

    const first = render(<App />);
    expect(await screen.findByRole("region", { name: "Sign in" })).toBeInTheDocument();
    await vi.waitFor(async () => {
      expect(await readCachedAccount()).toBeUndefined();
      expect(await readCachedFile("a-id")).toBeUndefined();
    });
    first.unmount();

    // Subsequent offline boot must not show the previous user's cached notes.
    server.use(http.get("/api/session", () => HttpResponse.error()));
    render(<App />);
    expect(await screen.findByText("Unable to reach the server.")).toBeInTheDocument();
    expect(screen.queryByText("secret.md")).not.toBeInTheDocument();
  });

  it("clears cached notes when a different account signs in and requests persistent storage", async () => {
    await writeCachedSession("old@example.com");
    await writeCachedRoot(node("old-root", "Old", "folder"));
    await writeCachedFile("old-file", "# Old user", '"e-old"');

    const persistMock = vi.fn().mockResolvedValue(true);
    const originalStorage = navigator.storage;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { persist: persistMock },
    });

    try {
      server.use(
        http.get("/api/session", () => HttpResponse.json({ email: "new@example.com" })),
        http.get("/api/root", () => HttpResponse.json(node("new-root", "New Notes", "folder"))),
        http.get("/api/folders/new-root/children", () => HttpResponse.json({ nodes: [] })),
      );

      render(<App />);
      expect(await screen.findByText("new@example.com")).toBeInTheDocument();

      await vi.waitFor(async () => {
        expect(await readCachedFile("old-file")).toBeUndefined();
        expect((await readCachedAccount())?.email).toBe("new@example.com");
      });
      expect(persistMock).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "storage", {
        configurable: true,
        value: originalStorage,
      });
    }
  });

  it("caches the display name and opens offline with it; an account switch drops the sync stamp", async () => {
    await writeCachedSession("owner@example.com", "Alex Rivera");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    expect(await readCachedAccount()).toMatchObject({
      email: "owner@example.com",
      name: "Alex Rivera",
    });

    server.use(
      http.get("/api/session", () => HttpResponse.error()),
      http.get("/api/root", () => HttpResponse.error()),
      http.get("/api/folders/:id/children", () => HttpResponse.error()),
    );
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Account: Alex Rivera (owner@example.com)" }),
    ).toBeInTheDocument();

    localStorage.setItem(CLOUD_STATE_STAMP_KEY, "9000");
    await writeCachedSession("other@example.com");
    expect(localStorage.getItem(CLOUD_STATE_STAMP_KEY)).toBeNull();
    expect((await readCachedAccount())?.name).toBeUndefined();
  });
});
