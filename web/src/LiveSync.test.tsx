import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { updateChangesState, writeCachedSession } from "./localCache";
import { VAULT_PIN_STORAGE_KEY } from "./vaultSync";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function contentResponse(body: string, etag: string) {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function signedIn(nodes = [node("doc-1", "a.md", "markdown")]) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes })),
  );
}

/**
 * The changes feed resumes from `t1`. Each call to the returned `report` queues changes for the
 * next poll; every other poll reports nothing new.
 */
async function changesFeed(initial: unknown[] = []): Promise<(changes: unknown[]) => void> {
  await writeCachedSession("owner@example.com");
  await updateChangesState({ startPageToken: "t1" });
  let queued = initial;
  let poll = 0;
  server.use(
    http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "t1" })),
    http.get("/api/changes", () => {
      const changes = queued;
      queued = [];
      poll += 1;
      return HttpResponse.json({ nextPageToken: `t${poll + 1}`, hasMore: false, changes });
    }),
  );
  return (changes) => {
    queued = changes;
  };
}

function externalChange(fileId: string, name: string) {
  return {
    fileId,
    removed: false,
    time: new Date().toISOString(),
    node: node(fileId, name, "markdown"),
    parentIds: ["root-id"],
  };
}

async function getEditorView(region: HTMLElement): Promise<EditorView> {
  return vi.waitFor(() => {
    const textbox = region
      .querySelector('[data-testid="editor-host"]')
      ?.shadowRoot?.querySelector<HTMLElement>('[role="textbox"][aria-label="Note text"]');
    const view = textbox ? EditorView.findFromDOM(textbox) : null;
    if (!view) {
      throw new Error("CodeMirror EditorView not mounted");
    }
    return view;
  });
}

async function enterEditor(): Promise<HTMLElement> {
  const preview = await screen.findByRole("region", { name: "Preview" });
  fireEvent.click(await within(preview).findByTestId("editor-canvas"));
  return screen.findByRole("region", { name: "Editor" });
}

function pressSave() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

function openInspector(): HTMLElement {
  fireEvent.click(screen.getAllByRole("button", { name: /^Sync status/ })[0]);
  return screen.getByRole("dialog", { name: "Sync & offline" });
}

describe("live Drive sync", () => {
  it("refreshes the open note quietly when Drive changed it and nothing is unsaved", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    await changesFeed([externalChange("doc-1", "a.md")]);
    let reads = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => {
        reads += 1;
        return reads === 1 ? contentResponse("mine", '"r1"') : contentResponse("theirs", '"r2"');
      }),
    );

    render(<App />);
    expect(await screen.findByText("Updated from Drive")).toBeInTheDocument();
    const preview = await screen.findByRole("region", { name: "Preview" });
    await vi.waitFor(() => expect(preview).toHaveTextContent("theirs"));
    expect(screen.queryByText("This note was updated on Drive")).not.toBeInTheDocument();
  });

  it("warns with Reload and Compare & Merge when Drive changed a note with unsaved edits", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    const report = await changesFeed();
    let reads = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => {
        reads += 1;
        return reads === 1 ? contentResponse("start", '"r1"') : contentResponse("theirs", '"r2"');
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("start"));
    act(() => {
      view.dispatch({ changes: { from: 0, to: 5, insert: "my draft" } });
    });
    // The focus poll reports the change while the draft is still unsaved.
    report([externalChange("doc-1", "a.md")]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    const banner = await screen.findByText("This note was updated on Drive");
    const alert = banner.closest<HTMLElement>('[role="alert"]')!;
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(view.state.doc.toString()).toBe("my draft");

    fireEvent.click(within(alert).getByRole("button", { name: "Compare & Merge" }));
    expect(await screen.findByRole("region", { name: /merge/i })).toBeInTheDocument();
  });

  it("lists notes recently updated on Drive in the empty workspace and opens them", async () => {
    signedIn([node("doc-1", "a.md", "markdown"), node("doc-2", "Shared plan.md", "markdown")]);
    await changesFeed([externalChange("doc-2", "Shared plan.md")]);
    server.use(http.get("/api/files/doc-2/content", () => contentResponse("plan", '"r1"')));

    render(<App />);
    const section = await screen.findByRole("region", { name: "Recently updated on Drive" });
    fireEvent.click(within(section).getByRole("button", { name: /Shared plan\.md/ }));
    expect(await screen.findByRole("region", { name: "Preview" })).toHaveTextContent("plan");
  });
});

describe("Sync & offline inspector", () => {
  it("shows a failed upload with its exact error, and retries or discards it", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    await changesFeed();
    let puts = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("start", '"r1"')),
      http.put("/api/files/doc-1/content", () => {
        puts += 1;
        return HttpResponse.json({ code: "too_large", message: "Too big" }, { status: 413 });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("start"));
    act(() => {
      view.dispatch({ changes: { from: 0, to: 5, insert: "edited" } });
    });
    pressSave();
    await vi.waitFor(() => expect(puts).toBe(1));

    const inspector = await vi.waitFor(() => {
      const dialog = openInspector();
      expect(within(dialog).getByRole("listitem", { name: "a.md" })).toBeInTheDocument();
      return dialog;
    });
    const item = within(inspector).getByRole("listitem", { name: "a.md" });
    expect(item).toHaveTextContent("Failed");
    expect(item).toHaveTextContent("HTTP 413 too_large — Too big");

    fireEvent.click(within(item).getByRole("button", { name: "Retry a.md" }));
    await vi.waitFor(() => expect(puts).toBe(2));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(
      within(within(inspector).getByRole("listitem", { name: "a.md" })).getByRole("button", {
        name: "Discard a.md",
      }),
    );
    await vi.waitFor(() =>
      expect(within(inspector).queryByRole("listitem", { name: "a.md" })).not.toBeInTheDocument(),
    );
    expect(within(inspector).getByRole("status")).toHaveTextContent("All changes synced");
  });

  it("pins the vault offline and reports its coverage", async () => {
    signedIn([node("doc-1", "a.md", "markdown")]);
    await changesFeed();
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json({
          rootId: "root-id",
          folders: [],
          files: [{ id: "doc-1", name: "a.md", parentId: "root-id", modifiedTime: MODIFIED }],
          truncated: false,
        }),
      ),
      http.get("/api/files/doc-1/content", () => contentResponse("text", '"r1"')),
    );

    render(<App />);
    await screen.findByText("a.md");
    const inspector = openInspector();
    expect(inspector).toHaveTextContent("Vault not synced for offline use yet");

    fireEvent.click(within(inspector).getByRole("switch", { name: "Pin vault offline" }));
    expect(localStorage.getItem(VAULT_PIN_STORAGE_KEY)).toBe("1");
    expect(await within(inspector).findByText("1 / 1 notes cached offline")).toBeInTheDocument();
    expect(within(inspector).getByText(/Last synced just now/)).toBeInTheDocument();
  });
});
