import { EditorView } from "@codemirror/view";
import { onlineManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { todayNoteName } from "./commandSearch";
import {
  clearLocalCache,
  enqueueOrCoalesceOp,
  readAllPendingOps,
  readCachedFile,
  readPendingWrite,
  upsertPendingWrite,
  writeCachedFile,
  writeCachedFolder,
  writeCachedRoot,
  writeCachedSession,
} from "./localCache";
import { isLocalId } from "./localIds";
import { updateSettings } from "./settings";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(async () => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
  localStorage.clear();
  history.replaceState(null, "", "/");
  setOnline(true);
  await clearLocalCache();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-23T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function contentResponse(body: BodyInit, etag = '"etag-1"') {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
  act(() => {
    onlineManager.setOnline(value);
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

function pressSave() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

function pressCmdK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
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

async function enterEditor(): Promise<HTMLElement> {
  const preview = await screen.findByRole("region", { name: "Preview" });
  const canvas = await within(preview).findByTestId("editor-canvas");
  fireEvent.click(canvas);
  return screen.findByRole("region", { name: "Editor" });
}

function openInspector(): HTMLElement {
  const triggers = screen.getAllByRole("button", { name: /^Sync status:/ });
  const existing = screen.queryByRole("dialog", { name: "Sync & offline" });
  if (existing !== null) {
    return existing;
  }
  fireEvent.click(triggers[0]);
  return screen.getByRole("dialog", { name: "Sync & offline" });
}

function mockSignedInVault(rootNodes: ReturnType<typeof node>[]) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes: rootNodes })),
    http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "t1" })),
    http.get("/api/changes", () =>
      HttpResponse.json({ nextPageToken: "t1", hasMore: false, changes: [] }),
    ),
  );
}

function mockNetworkOffline() {
  server.use(
    http.get("/api/session", () => HttpResponse.error()),
    http.get("/api/root", () => HttpResponse.error()),
    http.get("/api/folders/:id/children", () => HttpResponse.error()),
    http.get("/api/files/:id/content", () => HttpResponse.error()),
    http.get("/api/changes/start-token", () => HttpResponse.error()),
    http.get("/api/changes", () => HttpResponse.error()),
  );
}

describe("local-first structural vault operations (App integration)", () => {
  it("creates and edits a note offline, survives cold reload, and remaps localId -> realId on reconnect without unmounting CodeMirror", async () => {
    const posts: { parentId: string; name: string; content: string }[] = [];
    const puts: { id: string; text: string }[] = [];
    const revisionCalls: string[] = [];

    mockSignedInVault([node("doc-1", "existing.md", "markdown")]);

    const first = render(<App />);
    await screen.findByText("existing.md");

    // Go offline and create a new note via empty workspace CTA.
    setOnline(false);
    fireEvent.click(screen.getByRole("button", { name: "Create a note" }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(await within(editor).findByText("Saved locally")).toBeInTheDocument();
    expect(
      await screen.findByText("Offline — 1 change saved locally, will sync when online"),
    ).toBeInTheDocument();

    const localFileId = new URLSearchParams(window.location.search).get("file");
    expect(localFileId).not.toBeNull();
    expect(isLocalId(localFileId!)).toBe(true);

    // Type content and save locally (single deduplicated count in banner).
    const view1 = await getEditorView(editor);
    act(() => {
      view1.dispatch({ changes: { from: 0, to: 0, insert: "# Offline draft\n\nBody text" } });
    });
    pressSave();
    expect(await within(editor).findByText("Saved locally")).toBeInTheDocument();
    expect(
      await screen.findByText("Offline — 1 change saved locally, will sync when online"),
    ).toBeInTheDocument();

    // Cold reload while still offline: note opens cleanly from local cache with no network calls.
    first.unmount();
    mockNetworkOffline();
    render(<App />);

    const reloadedPreview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(reloadedPreview).findByRole("heading", { level: 3, name: "Offline draft" }),
    ).toBeInTheDocument();
    expect(await within(reloadedPreview).findByText("Saved locally")).toBeInTheDocument();

    // Enter Edit mode before reconnecting so we can verify CodeMirror continuity across remap!
    const reloadedEditor = await enterEditor();
    const viewBeforeRemap = await getEditorView(reloadedEditor);
    await vi.waitFor(() =>
      expect(viewBeforeRemap.state.doc.toString()).toBe("# Offline draft\n\nBody text"),
    );

    // Also verify VersionHistoryDialog on a local: note shows the friendly message without fetching.
    server.use(
      http.get("/api/files/:id/revisions", ({ params }) => {
        revisionCalls.push(String(params.id));
        return HttpResponse.json({ revisions: [] });
      }),
    );
    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: ">version" } });
    fireEvent.click(await within(palette).findByRole("option", { name: /Version history/ }));
    const vhDialog = await screen.findByRole("dialog", { name: "Version history" });
    expect(
      await within(vhDialog).findByText(
        "Version history is available after this note syncs to Drive.",
      ),
    ).toBeInTheDocument();
    expect(revisionCalls).toHaveLength(0);
    fireEvent.click(within(vhDialog).getByRole("button", { name: "Close" }));

    // Closing the modal dialog preserves the active editor; place cursor at end.
    const activeEditor = screen.getByRole("region", { name: "Editor" });
    const cmView = await getEditorView(activeEditor);
    act(() => {
      cmView.dispatch({ selection: { anchor: cmView.state.doc.length } });
    });

    // Reconnect: a single POST creates the file with the edited text and remaps localId -> real-1.
    let resolvePost!: (res: Response) => void;
    const postPromise = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    mockSignedInVault([
      node("doc-1", "existing.md", "markdown"),
      node("real-1", "Untitled.md", "markdown"),
    ]);
    server.use(
      http.post("/api/folders/:parentId/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string; content: string };
        posts.push({ parentId: String(params.parentId), name: body.name, content: body.content });
        return postPromise;
      }),
      http.put("/api/files/:id/content", async ({ params, request }) => {
        puts.push({ id: String(params.id), text: await request.text() });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    setOnline(true);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      parentId: "root-id",
      name: "Untitled.md",
      content: "# Offline draft\n\nBody text",
    });

    // Type additional text WHILE the POST is in flight; remap must NOT unmount CodeMirror or drop it!
    act(() => {
      cmView.dispatch({
        changes: { from: cmView.state.doc.length, insert: " + mid-flight" },
      });
    });

    resolvePost(
      HttpResponse.json(node("real-1", "Untitled.md", "markdown"), {
        status: 201,
        headers: { ETag: '"etag-1"' },
      }),
    );

    // URL remaps seamlessly from local:... to real-1 while the exact same CodeMirror EditorView stays mounted!
    await vi.waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("file")).toBe("real-1");
    });
    const cmAfterRemap = await getEditorView(screen.getByRole("region", { name: "Editor" }));
    expect(cmAfterRemap).toBe(cmView);
    expect(cmAfterRemap.state.doc.toString()).toBe("# Offline draft\n\nBody text + mid-flight");

    // Pressing Cmd+S after remap saves the mid-flight edit to real-1 with If-Match '"etag-1"'.
    pressSave();
    await vi.waitFor(() =>
      expect(puts).toEqual([{ id: "real-1", text: "# Offline draft\n\nBody text + mid-flight" }]),
    );
    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toHaveLength(0);
      expect(await readPendingWrite("real-1")).toBeUndefined();
      expect(await readCachedFile("real-1")).toEqual({
        text: "# Offline draft\n\nBody text + mid-flight",
        revision: '"etag-2"',
      });
    });
  });

  it("cancels offline create folder -> create note -> rename -> move -> delete with 0 network calls on reconnect", async () => {
    const mutations: string[] = [];
    mockSignedInVault([node("target-dir", "Archive", "folder")]);
    server.use(
      http.get("/api/folders/target-dir/children", () => HttpResponse.json({ nodes: [] })),
      http.post("/api/folders/:id/folders", () => {
        mutations.push("POST folder");
        return HttpResponse.json(node("x", "x", "folder"), { status: 201 });
      }),
      http.post("/api/folders/:id/files", () => {
        mutations.push("POST file");
        return HttpResponse.json(node("x", "x.md", "markdown"), { status: 201 });
      }),
      http.patch("/api/folders/:id", () => {
        mutations.push("PATCH folder");
        return HttpResponse.json(node("x", "x", "folder"));
      }),
      http.patch("/api/files/:id", () => {
        mutations.push("PATCH file");
        return HttpResponse.json(node("x", "x.md", "markdown"));
      }),
      http.delete("/api/folders/:id", () => {
        mutations.push("DELETE folder");
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("/api/files/:id", () => {
        mutations.push("DELETE file");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    render(<App />);
    await screen.findByText("Archive");

    setOnline(false);

    // 1. Create folder "Scratch" offline.
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const createDialog = await screen.findByRole("dialog");
    fireEvent.change(within(createDialog).getByLabelText("Folder name"), {
      target: { value: "Scratch" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Scratch")).toBeInTheDocument();

    // 2. Create a note inside "Scratch".
    fireEvent.click(screen.getByRole("button", { name: "Actions for Scratch" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New note" }));
    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(within(editor).getByRole("heading", { level: 2 })).toHaveTextContent("Untitled.md");

    // 3. Rename the note inline to "temp.md".
    fireEvent.click(within(editor).getByRole("button", { name: "Untitled.md" }));
    const nameInput = within(editor).getByRole("textbox", { name: "File name" });
    fireEvent.change(nameInput, { target: { value: "temp" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    expect(await within(editor).findByRole("heading", { level: 2 })).toHaveTextContent("temp.md");

    // 4. Move the folder "Scratch" into "Archive" via Move dialog.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Scratch" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const moveDialog = await screen.findByRole("dialog", { name: "Move to…" });
    fireEvent.click(await within(moveDialog).findByRole("option", { name: /Archive/ }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Move to…" })).not.toBeInTheDocument(),
    );

    // Expand Archive to see Scratch inside it, then delete Scratch.
    fireEvent.click(screen.getByText("Archive"));
    expect(await screen.findByText("Scratch")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Scratch" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const delDialog = await screen.findByRole("dialog", { name: "Delete folder" });
    fireEvent.click(within(delDialog).getByRole("button", { name: "Delete folder" }));

    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toHaveLength(0);
    });
    expect(screen.queryByText("Scratch")).not.toBeInTheDocument();
    // Open note inside deleted folder was closed.
    expect(screen.getByRole("heading", { name: "No note selected" })).toBeInTheDocument();

    // Reconnect: 0 structural mutation requests fire!
    setOnline(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mutations).toHaveLength(0);
  });

  it("replays offline rename, move, and delete of existing Drive items in strict FIFO order after reload", async () => {
    const calls: string[] = [];
    mockSignedInVault([
      node("dir-work", "Work", "folder"),
      node("doc-1", "alpha.md", "markdown"),
      node("doc-2", "trash-me.md", "markdown"),
    ]);
    server.use(
      http.get("/api/folders/dir-work/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/doc-1/content", () => contentResponse("# Alpha", '"etag-a1"')),
      http.get("/api/files/doc-2/content", () => contentResponse("# Bye", '"etag-b1"')),
    );

    const first = render(<App />);
    await screen.findByText("alpha.md");

    // Open alpha.md so we can rename it offline.
    fireEvent.click(screen.getByText("alpha.md"));
    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Alpha" });

    setOnline(false);

    // Op 1: Rename alpha.md -> renamed.md.
    fireEvent.click(within(preview).getByRole("button", { name: "alpha.md" }));
    const renameInput = within(preview).getByRole("textbox", { name: "File name" });
    fireEvent.change(renameInput, { target: { value: "renamed" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    expect(await within(preview).findByRole("heading", { level: 2 })).toHaveTextContent(
      "renamed.md",
    );

    // Op 2: Move renamed.md into Work.
    fireEvent.click(screen.getByRole("button", { name: "Actions for renamed.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const moveDialog = await screen.findByRole("dialog", { name: "Move to…" });
    fireEvent.click(await within(moveDialog).findByRole("option", { name: /Work/ }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Move to…" })).not.toBeInTheDocument(),
    );

    // Op 3: Delete trash-me.md.
    fireEvent.click(screen.getByRole("button", { name: "Actions for trash-me.md" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const delDialog = await screen.findByRole("dialog", { name: "Delete note" });
    fireEvent.click(within(delDialog).getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(screen.queryByText("trash-me.md")).not.toBeInTheDocument());

    // Offline banner reflects 3 pending structural changes.
    expect(
      await screen.findByText("Offline — 3 changes saved locally, will sync when online"),
    ).toBeInTheDocument();

    // Settings dialog disables Clear local cache while structural ops are pending.
    fireEvent.click(screen.getByRole("button", { name: /owner@example\.com/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settingsDialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(settingsDialog).getByRole("tab", { name: "Sync & Storage" }));
    expect(
      within(settingsDialog).getByRole("button", { name: "Clear local cache" }),
    ).toBeDisabled();
    fireEvent.click(within(settingsDialog).getByRole("button", { name: "Close settings" }));

    // Cold reload offline: all 3 ops persist in Dexie and UI shows optimistic state.
    first.unmount();
    mockNetworkOffline();
    render(<App />);
    expect(await screen.findByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByText("trash-me.md")).not.toBeInTheDocument();
    expect(await readAllPendingOps()).toHaveLength(3);

    // Reconnect: verify strict FIFO replay order (rename -> move -> delete).
    mockSignedInVault([node("dir-work", "Work", "folder")]);
    server.use(
      http.get("/api/folders/dir-work/children", () =>
        HttpResponse.json({ nodes: [node("doc-1", "renamed.md", "markdown")] }),
      ),
      http.get("/api/files/doc-1/content", () => contentResponse("# Alpha", '"etag-a3"')),
      http.patch("/api/files/:id", async ({ params, request }) => {
        const body = (await request.json()) as { name?: string; parentId?: string };
        const id = String(params.id);
        if (body.name !== undefined) {
          calls.push(`rename:${id}:${body.name}`);
          return HttpResponse.json(node(id, body.name, "markdown"), {
            headers: { ETag: '"etag-a2"' },
          });
        }
        calls.push(`move:${id}:${body.parentId ?? ""}`);
        return HttpResponse.json(node(id, "renamed.md", "markdown"), {
          headers: { ETag: '"etag-a3"' },
        });
      }),
      http.delete("/api/files/:id", ({ params }) => {
        calls.push(`delete:${String(params.id)}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    setOnline(true);
    await vi.waitFor(() => {
      expect(calls).toEqual(["rename:doc-1:renamed.md", "move:doc-1:dir-work", "delete:doc-2"]);
    });
    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toHaveLength(0);
    });
  });

  it("creates today's daily note offline even when the daily folder does not exist yet, then replays folder + file on reconnect", async () => {
    updateSettings({ dailyNotesFolder: "Daily" });
    const createdFolders: { parentId: string; name: string }[] = [];
    const createdFiles: { parentId: string; name: string; content: string }[] = [];
    const expectedTodayName = todayNoteName();

    mockSignedInVault([node("doc-1", "welcome.md", "markdown")]);
    render(<App />);
    await screen.findByText("welcome.md");

    setOnline(false);

    // Invoke Today's note via Command Palette while offline (Daily folder does not exist yet).
    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(await within(palette).findByRole("option", { name: /Today's note/ }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(await within(editor).findByRole("heading", { level: 2 })).toHaveTextContent(
      expectedTodayName,
    );
    const sidebar = screen.getByRole("navigation", { name: "Files" });
    expect(await within(sidebar).findByText("Daily")).toBeInTheDocument();

    const ops = await readAllPendingOps();
    expect(ops.map((o) => o.kind)).toEqual(["create_folder", "create_file"]);

    // Reconnect: Daily folder creates first, then today's note creates inside the real Daily folder ID!
    server.use(
      http.post("/api/folders/:parentId/folders", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        createdFolders.push({ parentId: String(params.parentId), name: body.name });
        return HttpResponse.json(node("daily-real", body.name, "folder"), { status: 201 });
      }),
      http.post("/api/folders/:parentId/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string; content: string };
        createdFiles.push({
          parentId: String(params.parentId),
          name: body.name,
          content: body.content,
        });
        return HttpResponse.json(node("today-real", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-today"' },
        });
      }),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [node("daily-real", "Daily", "folder"), node("doc-1", "welcome.md", "markdown")],
        }),
      ),
      http.get("/api/folders/daily-real/children", () =>
        HttpResponse.json({ nodes: [node("today-real", expectedTodayName, "markdown")] }),
      ),
    );

    setOnline(true);

    await vi.waitFor(() => {
      expect(createdFolders).toEqual([{ parentId: "root-id", name: "Daily" }]);
      expect(createdFiles).toHaveLength(1);
      expect(createdFiles[0].parentId).toBe("daily-real");
      expect(createdFiles[0].name).toBe(expectedTodayName);
    });
    await vi.waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("file")).toBe("today-real");
    });
    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toHaveLength(0);
    });
  });

  it("surfaces a deferred 409 rename conflict in SyncInspector and rolls back cleanly on Discard", async () => {
    mockSignedInVault([node("doc-1", "alpha.md", "markdown")]);
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("# Alpha", '"etag-1"')),
      http.patch("/api/files/doc-1", () =>
        HttpResponse.json(
          { code: "name_exists", message: "A file with this name already exists." },
          { status: 409 },
        ),
      ),
    );

    render(<App />);
    fireEvent.click(await screen.findByText("alpha.md"));
    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Alpha" });

    // Rename offline to a name that will collide on Drive.
    setOnline(false);
    fireEvent.click(within(preview).getByRole("button", { name: "alpha.md" }));
    const input = within(preview).getByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "taken" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await within(preview).findByRole("heading", { level: 2 })).toHaveTextContent("taken.md");

    // Reconnect: 409 conflict appears in SyncInspector.
    setOnline(true);
    const inspector = await vi.waitFor(() => {
      const dialog = openInspector();
      expect(
        within(dialog).getByRole("listitem", { name: "Rename to taken.md" }),
      ).toHaveTextContent("Name already exists on Drive");
      return dialog;
    });

    // Discard rolls back the rename cleanly in tree, header, and Dexie.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(inspector).getByRole("button", { name: "Discard Rename to taken.md" }));

    await vi.waitFor(() => {
      expect(
        within(inspector).queryByRole("listitem", { name: "Rename to taken.md" }),
      ).not.toBeInTheDocument();
    });
    expect(within(inspector).getByRole("status")).toHaveTextContent("All changes synced");
    expect(await within(preview).findByRole("heading", { level: 2 })).toHaveTextContent("alpha.md");
    const sidebar = screen.getByRole("navigation", { name: "Files" });
    expect(await within(sidebar).findByText("alpha.md")).toBeInTheDocument();
    expect(await readAllPendingOps()).toHaveLength(0);
  });

  it("allows creating a named note offline via Command Palette and resolves a deferred 409 via inline rename-to-fix", async () => {
    const posts: { name: string; content: string }[] = [];
    mockSignedInVault([node("doc-1", "alpha.md", "markdown")]);
    server.use(
      http.post("/api/folders/root-id/files", async ({ request }) => {
        const body = (await request.json()) as { name: string; content: string };
        posts.push(body);
        if (body.name === "clash.md") {
          return HttpResponse.json(
            { code: "name_exists", message: "Already exists" },
            { status: 409 },
          );
        }
        return HttpResponse.json(node("real-fixed", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-fixed"' },
        });
      }),
    );

    render(<App />);
    await screen.findByText("alpha.md");

    // Offline create named note "clash.md" via Cmd+K.
    setOnline(false);
    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "clash" } });
    fireEvent.click(await within(palette).findByRole("option", { name: /Create "clash\.md"/ }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(await within(editor).findByRole("heading", { level: 2 })).toHaveTextContent("clash.md");

    // Reconnect: POST clash.md hits 409 and shows in SyncInspector.
    setOnline(true);
    await vi.waitFor(() => expect(posts).toEqual([{ name: "clash.md", content: "" }]));
    await vi.waitFor(() => {
      const dialog = openInspector();
      expect(within(dialog).getByRole("listitem", { name: "Create clash.md" })).toHaveTextContent(
        "Name already exists on Drive",
      );
    });
    // Close inspector popover by clicking trigger.
    fireEvent.click(screen.getAllByRole("button", { name: /^Sync status:/ })[0]);

    // Rename inline to "resolved.md": folds into create_file and auto-syncs cleanly!
    const region =
      screen.queryByRole("region", { name: "Editor" }) ??
      screen.getByRole("region", { name: "Preview" });
    fireEvent.click(within(region).getByRole("button", { name: "clash.md" }));
    const input = within(region).getByRole("textbox", { name: "File name" });
    fireEvent.change(input, { target: { value: "resolved" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() => {
      expect(posts).toEqual([
        { name: "clash.md", content: "" },
        { name: "resolved.md", content: "" },
      ]);
    });
    await vi.waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("file")).toBe("real-fixed");
    });
    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toHaveLength(0);
    });
  });

  it("preserves db.ops and local cache on 401 when structural ops are queued", async () => {
    mockSignedInVault([node("doc-1", "keep.md", "markdown")]);
    const first = render(<App />);
    await screen.findByText("keep.md");

    // Create a folder offline so db.ops has a queued structural op (with empty db.outbox).
    setOnline(false);
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), {
      target: { value: "OfflineFolder" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("OfflineFolder")).toBeInTheDocument();
    expect(await readAllPendingOps()).toHaveLength(1);

    // Cold reload when the session has expired (401): workspace stays visible and db.ops is preserved!
    first.unmount();
    setOnline(true);
    let folderPostCalls = 0;
    server.use(
      http.get("/api/session", () =>
        HttpResponse.json({ code: "unauthenticated", message: "Session expired" }, { status: 401 }),
      ),
      http.post("/api/folders/:parentId/folders", () => {
        folderPostCalls += 1;
        return HttpResponse.json(
          { code: "unauthenticated", message: "Session expired" },
          { status: 401 },
        );
      }),
    );

    render(<App />);
    expect(await screen.findByText("OfflineFolder")).toBeInTheDocument();
    expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sign in" })).not.toBeInTheDocument();
    expect(folderPostCalls).toBe(0);

    // Triggering an online event while the session is still 401 must not flush queued mutations.
    setOnline(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(folderPostCalls).toBe(0);

    // db.ops was NOT wiped by the 401!
    const preservedOps = await readAllPendingOps();
    expect(preservedOps).toHaveLength(1);
    expect(preservedOps[0]).toMatchObject({ kind: "create_folder", name: "OfflineFolder" });
  });

  it("creates today's daily note offline when the configured daily folder already exists in root but was never expanded, then adopts on reconnect", async () => {
    updateSettings({ dailyNotesFolder: "Daily" });
    const expectedTodayName = todayNoteName();
    const createdFiles: { parentId: string; name: string }[] = [];

    mockSignedInVault([
      node("daily-id", "Daily", "folder"),
      node("doc-1", "welcome.md", "markdown"),
    ]);
    render(<App />);
    await screen.findByText("Daily");

    // Go offline without ever expanding "Daily" (its children listing is not cached).
    setOnline(false);
    mockNetworkOffline();

    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(await within(palette).findByRole("option", { name: /Today's note/ }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(await within(editor).findByRole("heading", { level: 2 })).toHaveTextContent(
      expectedTodayName,
    );
    expect(screen.queryByText(/Could not open the “Daily” folder/)).not.toBeInTheDocument();

    const ops = await readAllPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "create_file",
      parentId: "daily-id",
      name: expectedTodayName,
      openExistingOnConflict: true,
    });

    // Reconnect when Drive already has today's note: 409 name_exists adopts the existing remote note cleanly.
    mockSignedInVault([
      node("daily-id", "Daily", "folder"),
      node("doc-1", "welcome.md", "markdown"),
    ]);
    server.use(
      http.post("/api/folders/daily-id/files", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        createdFiles.push({ parentId: "daily-id", name: body.name });
        return HttpResponse.json(
          { code: "name_exists", message: "Already exists" },
          { status: 409 },
        );
      }),
      http.get("/api/folders/daily-id/children", () =>
        HttpResponse.json({
          nodes: [node("existing-today", expectedTodayName, "markdown")],
        }),
      ),
      http.get("/api/files/existing-today/content", () =>
        contentResponse("# Already on Drive", '"etag-existing"'),
      ),
    );

    setOnline(true);

    await vi.waitFor(() => {
      expect(createdFiles).toEqual([{ parentId: "daily-id", name: expectedTodayName }]);
    });
    await vi.waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("file")).toBe("existing-today");
    });
    await vi.waitFor(async () => {
      expect(await readAllPendingOps()).toHaveLength(0);
    });
  });

  it("clears Account A's persisted ops, outbox, and cached folders on cold-load switch to Account B", async () => {
    // Seed IndexedDB with Account A's cached vault, pending outbox edit, and pending structural op.
    await writeCachedSession("alice@example.com");
    await writeCachedRoot(node("root-a", "Alice Vault", "folder"));
    await writeCachedFolder("root-a", [node("doc-a", "alice-secret.md", "markdown")]);
    await writeCachedFile("doc-a", "# Alice Secret", '"etag-a"');
    await upsertPendingWrite("doc-a", "# Alice Dirty Edit", '"etag-a"');
    await enqueueOrCoalesceOp({
      opId: "op-alice-1",
      kind: "create_folder",
      targetId: "local:alice-dir",
      targetName: "AliceOfflineFolder",
      parentId: "root-a",
      name: "AliceOfflineFolder",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(await readAllPendingOps()).toHaveLength(1);
    expect(await readPendingWrite("doc-a")).toBeDefined();

    // Boot <App /> with /api/session resolving immediately as Account B.
    const unexpectedMutations: string[] = [];
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "bob@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-b", "Bob Vault", "folder"))),
      http.get("/api/folders/root-b/children", () =>
        HttpResponse.json({ nodes: [node("doc-b", "bob-note.md", "markdown")] }),
      ),
      http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "tb1" })),
      http.get("/api/changes", () =>
        HttpResponse.json({ nextPageToken: "tb1", hasMore: false, changes: [] }),
      ),
      http.post("/api/folders/:id/folders", ({ params }) => {
        unexpectedMutations.push(`POST folder ${String(params.id)}`);
        return HttpResponse.json(node("x", "x", "folder"), { status: 201 });
      }),
      http.put("/api/files/:id/content", ({ params }) => {
        unexpectedMutations.push(`PUT file ${String(params.id)}`);
        return new HttpResponse(null, { status: 204, headers: { ETag: '"e"' } });
      }),
    );

    render(<App />);
    expect(await screen.findByText("bob-note.md")).toBeInTheDocument();
    expect(await screen.findByText("bob@example.com")).toBeInTheDocument();

    // Wait a tick so any in-flight mount hydration would have settled if unguarded.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // Account B sees no leftover Account A folders/notes and 0 pending ops/outbox items.
    expect(screen.queryByText("alice-secret.md")).not.toBeInTheDocument();
    expect(screen.queryByText("AliceOfflineFolder")).not.toBeInTheDocument();

    const inspector = openInspector();
    expect(within(inspector).getByRole("status")).toHaveTextContent("All changes synced");
    expect(within(inspector).queryByText("AliceOfflineFolder")).not.toBeInTheDocument();
    expect(unexpectedMutations).toHaveLength(0);
    expect(await readAllPendingOps()).toHaveLength(0);
    expect(await readPendingWrite("doc-a")).toBeUndefined();
  });
});
