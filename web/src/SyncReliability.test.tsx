import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { ApiError } from "./api";
import { AUTOSAVE_DELAY_MS } from "./components/DocumentView";
import {
  readCachedFile,
  readPendingWrite,
  upsertPendingWrite,
  writeCachedFile,
  writeCachedFolder,
  writeCachedRoot,
  writeCachedSession,
} from "./localCache";
import { retryDelayMs } from "./syncQueue";

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

function contentResponse(body: BodyInit, etag: string) {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function signedIn() {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({ nodes: [node("doc-1", "a.md", "markdown")] }),
    ),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

function pressSave() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

async function enterEditor(): Promise<HTMLElement> {
  const preview = await screen.findByRole("region", { name: "Preview" });
  fireEvent.click(await within(preview).findByTestId("editor-canvas"));
  return screen.findByRole("region", { name: "Editor" });
}

async function replaceText(region: HTMLElement, from: string, to: string) {
  const view = await getEditorView(region);
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe(from));
  act(() => {
    view.dispatch({ changes: { from: 0, to: from.length, insert: to } });
  });
  return view;
}

describe("sync reliability", () => {
  it("retries a transient 502 on its own with backoff and shows the specific reason meanwhile", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    const puts: string[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("start", '"etag-1"')),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push(await request.text());
        return puts.length === 1
          ? HttpResponse.json({ code: "upstream_error", message: "Drive hiccup" }, { status: 502 })
          : new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "edited");
    pressSave();

    const alert = await within(editor).findByRole("alert");
    expect(alert).toHaveTextContent("Unable to sync to Drive. Your changes are saved locally.");
    expect(alert).toHaveTextContent("Reason: HTTP 502 upstream_error — Drive hiccup");
    expect(alert).toHaveTextContent("Retrying automatically (attempt 1 of 4)…");

    // No click on Retry: the scheduled retry lands the edit.
    expect(await within(editor).findByText("Saved", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
    expect(puts).toEqual(["edited", "edited"]);
  });

  it("does not retry a permanent error on its own", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    let putCalls = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("start", '"etag-1"')),
      http.put("/api/files/doc-1/content", () => {
        putCalls += 1;
        return HttpResponse.json({ code: "too_large", message: "Too big" }, { status: 413 });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "edited");
    pressSave();

    expect(await within(editor).findByRole("alert")).toHaveTextContent("larger than 10 MB");
    await new Promise((r) => setTimeout(r, 1_400));
    expect(putCalls).toBe(1);
  });

  it("rebases onto Drive's fresh tag when a 412 is only a metadata change, without a conflict", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    let getCalls = 0;
    const puts: { ifMatch: string | null; text: string }[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => {
        getCalls += 1;
        // Same text, but Drive's tag moved (e.g. renamed on another device).
        return contentResponse("start", getCalls === 1 ? '"etag-1"' : '"etag-1b"');
      }),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        const ifMatch = request.headers.get("If-Match");
        puts.push({ ifMatch, text: await request.text() });
        return ifMatch === '"etag-1"'
          ? HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 })
          : new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "mine");
    pressSave();

    expect(await within(editor).findByText("Saved")).toBeInTheDocument();
    expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
    expect(puts).toEqual([
      { ifMatch: '"etag-1"', text: "mine" },
      { ifMatch: '"etag-1b"', text: "mine" },
    ]);
    expect(await readCachedFile("doc-1")).toEqual({ text: "mine", revision: '"etag-2"' });
  });

  it("treats a 412 as done when Drive already holds the edit (an earlier answer was lost)", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    let getCalls = 0;
    let putCalls = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => {
        getCalls += 1;
        return getCalls === 1
          ? contentResponse("start", '"etag-1"')
          : contentResponse("mine", '"etag-2"');
      }),
      http.put("/api/files/doc-1/content", () => {
        putCalls += 1;
        return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "mine");
    pressSave();

    expect(await within(editor).findByText("Saved")).toBeInTheDocument();
    expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
    expect(putCalls).toBe(1);
    expect(await readPendingWrite("doc-1")).toBeUndefined();
    expect(await readCachedFile("doc-1")).toEqual({ text: "mine", revision: '"etag-2"' });
  });

  it("still reports a real conflict when Drive's text differs from both base and edit", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    let getCalls = 0;
    let putCalls = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => {
        getCalls += 1;
        return getCalls === 1
          ? contentResponse("start", '"etag-1"')
          : contentResponse("theirs", '"etag-9"');
      }),
      http.put("/api/files/doc-1/content", () => {
        putCalls += 1;
        return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "mine");
    pressSave();

    expect(await within(editor).findByRole("alert")).toHaveTextContent(
      "This note changed on Drive since you opened it.",
    );
    expect(putCalls).toBe(1);
  });

  it("sends a strong If-Match even when a proxy weakened Drive's ETag", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    const ifMatches: (string | null)[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("start", 'W/"etag-1"')),
      http.put("/api/files/doc-1/content", ({ request }) => {
        ifMatches.push(request.headers.get("If-Match"));
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "mine");
    pressSave();

    expect(await within(editor).findByText("Saved")).toBeInTheDocument();
    expect(ifMatches).toEqual(['"etag-1"']);
  });

  it("keeps a just-saved edit when a slower background read returns Drive's older copy", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("doc-1", "a.md", "markdown")]);
    await writeCachedFile("doc-1", "start", '"etag-1"');
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();

    const slowRead = deferred<Response>();
    const puts: { ifMatch: string | null; text: string }[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => slowRead.promise),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push({ ifMatch: request.headers.get("If-Match"), text: await request.text() });
        return new HttpResponse(null, {
          status: 204,
          headers: { ETag: puts.length === 1 ? '"etag-2"' : '"etag-3"' },
        });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await replaceText(editor, "start", "first edit");
    pressSave();
    expect(await within(editor).findByText("Saved")).toBeInTheDocument();

    // The background revalidation that started at open answers only now, with the old copy.
    slowRead.resolve(contentResponse("start", '"etag-1"'));
    await new Promise((r) => setTimeout(r, 50));
    expect(view.state.doc.toString()).toBe("first edit");
    expect(await readCachedFile("doc-1")).toEqual({ text: "first edit", revision: '"etag-2"' });

    // The next save chains from the tag the first upload returned, not the stale one.
    act(() => {
      view.dispatch({ changes: { from: 0, to: "first edit".length, insert: "second edit" } });
    });
    pressSave();
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ ifMatch: '"etag-2"', text: "second edit" });
  });

  it("preserves db.outbox on 401 when viewing a clean note or on cold reload", async () => {
    // 1. Mid-session 401 while another note has an unsynced edit and current note is clean.
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [
      node("doc-a", "a.md", "markdown"),
      node("doc-b", "b.md", "markdown"),
    ]);
    await upsertPendingWrite("doc-a", "precious offline edit", '"etag-a1"', "old a");
    await writeCachedFile("doc-b", "clean b", '"etag-b1"');
    history.replaceState(null, "", "/?file=doc-b");

    const endedBody = {
      code: "unauthenticated",
      message: "Your session has ended. Sign in again.",
      reason: "session_ended",
    };
    server.use(
      http.get("/api/session", () => HttpResponse.json(endedBody, { status: 401 })),
      http.get("/api/root", () => HttpResponse.json(endedBody, { status: 401 })),
      http.get("/api/folders/:id/children", () => HttpResponse.json(endedBody, { status: 401 })),
      http.get("/api/files/:id/content", () => HttpResponse.json(endedBody, { status: 401 })),
    );

    render(<App />);

    // Cold reload with 401 must keep workspace mounted and preserve db.outbox!
    const account = await screen.findByRole("region", { name: "Account" });
    expect(await within(account).findByRole("alert")).toHaveTextContent(
      "Your session has ended. Copy your unsaved changes, then sign in again.",
    );
    expect(screen.queryByRole("region", { name: "Sign in" })).not.toBeInTheDocument();
    expect(await readPendingWrite("doc-a")).toMatchObject({
      fileId: "doc-a",
      text: "precious offline edit",
    });
    expect(await readCachedFile("doc-a")).toEqual({
      text: "precious offline edit",
      revision: '"etag-a1"',
    });
  });

  it("preserves db.outbox on mid-session 401 while draining a background note from a clean view", async () => {
    let authed = true;
    const endedBody = {
      code: "unauthenticated",
      message: "Your session has ended. Sign in again.",
      reason: "session_ended",
    };
    const putGate = deferred<void>();
    server.use(
      http.get("/api/session", () =>
        authed
          ? HttpResponse.json({ email: "owner@example.com" })
          : HttpResponse.json(endedBody, { status: 401 }),
      ),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [node("doc-a", "a.md", "markdown"), node("doc-b", "b.md", "markdown")],
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(params.id === "doc-a" ? "# A" : "# B", `"etag-${String(params.id)}"`),
      ),
      http.put("/api/files/doc-a/content", async () => {
        await putGate.promise;
        authed = false;
        return HttpResponse.json(endedBody, { status: 401 });
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.md/ }));
    const editor = await enterEditor();
    await replaceText(editor, "# A", "# A unsynced");
    pressSave();

    // Switch to clean b.md before a.md's PUT fails with 401.
    fireEvent.click(screen.getByRole("treeitem", { name: /b\.md/ }));
    const bPreview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(bPreview).findByRole("heading", { level: 3, name: "B" }),
    ).toBeInTheDocument();

    putGate.resolve();

    const account = screen.getByRole("region", { name: "Account" });
    expect(await within(account).findByRole("alert")).toHaveTextContent(
      "Your session has ended. Copy your unsaved changes, then sign in again.",
    );
    expect(screen.queryByRole("region", { name: "Sign in" })).not.toBeInTheDocument();
    expect(await readPendingWrite("doc-a")).toMatchObject({
      fileId: "doc-a",
      text: "# A unsynced",
    });
  });

  it("surfaces a 412 conflict instead of silently clobbering when background GET lands during an unflushed draft", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("doc-1", "a.md", "markdown")]);
    await writeCachedFile("doc-1", "old", '"etag-1"');
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();

    const bgGet = deferred<Response>();
    const puts: { ifMatch: string | null; text: string }[] = [];
    let getCalls = 0;
    server.use(
      http.get("/api/files/doc-1/content", () => {
        getCalls += 1;
        return getCalls === 1 ? bgGet.promise : contentResponse("remote edit", '"etag-2"');
      }),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        const ifMatch = request.headers.get("If-Match");
        puts.push({ ifMatch, text: await request.text() });
        if (ifMatch !== '"etag-2"') {
          return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
        }
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-3"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "old", "my edit");

    // Background GET lands with a remote edit while "my edit" is still unflushed.
    bgGet.resolve(contentResponse("remote edit", '"etag-2"'));
    await vi.waitFor(async () => {
      expect(await readCachedFile("doc-1")).toEqual({ text: "remote edit", revision: '"etag-2"' });
    });

    // Saving must send If-Match: "etag-1" and hit 412 rather than clobbering "remote edit".
    pressSave();
    expect(await within(editor).findByRole("alert")).toHaveTextContent(
      "This note changed on Drive since you opened it.",
    );
    expect(puts).toEqual([{ ifMatch: '"etag-1"', text: "my edit" }]);
  });

  it("does not clobber a remote edit when a note with a 412 conflict is renamed inline", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    let getCalls = 0;
    const puts: { ifMatch: string | null; text: string }[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => {
        getCalls += 1;
        return getCalls === 1
          ? contentResponse("start", '"etag-1"')
          : contentResponse("remote edit", '"etag-3"');
      }),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push({ ifMatch: request.headers.get("If-Match"), text: await request.text() });
        return HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 });
      }),
      http.patch("/api/files/doc-1", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json(node("doc-1", body.name, "markdown"), {
          status: 200,
          headers: { ETag: '"etag-3"' },
        });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "mine");
    pressSave();
    expect(await within(editor).findByRole("alert")).toHaveTextContent(
      "This note changed on Drive since you opened it.",
    );

    // Rename the conflicted note inline: outbox.baseRevision must remain "etag-1".
    fireEvent.click(within(editor).getByRole("button", { name: "a.md" }));
    const input = within(editor).getByLabelText("File name");
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "renamed.md" }),
    ).toBeInTheDocument();
    expect((await readPendingWrite("doc-1"))?.baseRevision).toBe('"etag-1"');
    expect(puts).toEqual([{ ifMatch: '"etag-1"', text: "mine" }]);
  });

  it("deleting an open note with an unflushed draft does not resurrect db.outbox on unmount", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    const puts: string[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("start", '"etag-1"')),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push(await request.text());
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
      http.delete("/api/files/doc-1", () => new HttpResponse(null, { status: 204 })),
    );

    render(<App />);
    const editor = await enterEditor();
    await replaceText(editor, "start", "unflushed edit");

    fireEvent.click(screen.getByRole("button", { name: "Actions for a.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No note selected")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toEqual([]);
    expect(await readPendingWrite("doc-1")).toBeUndefined();
    expect(await readCachedFile("doc-1")).toBeUndefined();
  });

  it("deleting a folder discards pending outbox entries for descendants cached only in IndexedDB", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("dir-1", "Projects", "folder")]);
    await writeCachedFolder("dir-1", [node("sub-1", "Archive", "folder")]);
    await writeCachedFolder("sub-1", [node("deep-note", "deep.md", "markdown")]);
    await upsertPendingWrite("deep-note", "pending edit", '"etag-1"', "base");

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("dir-1", "Projects", "folder")] }),
      ),
      http.delete("/api/folders/dir-1", () => new HttpResponse(null, { status: 204 })),
    );

    render(<App />);
    await screen.findByText("Projects");
    // Delete Projects without expanding it (sub-1/deep-note are only in IndexedDB).
    fireEvent.click(screen.getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete folder" }));

    await vi.waitFor(async () => {
      expect(await readPendingWrite("deep-note")).toBeUndefined();
      expect(await readCachedFile("deep-note")).toBeUndefined();
    });
  });

  it("does not wipe unsynced db.outbox edits when background GET /content returns 404", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("doc-1", "a.md", "markdown")]);
    await upsertPendingWrite("doc-1", "# Unsynced local work", '"etag-1"', "# Start");
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();

    server.use(
      http.get("/api/files/doc-1/content", () =>
        HttpResponse.json({ code: "not_found", message: "Gone" }, { status: 404 }),
      ),
      http.put("/api/files/doc-1/content", () =>
        HttpResponse.json({ code: "not_found", message: "Gone" }, { status: 404 }),
      ),
    );

    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Unsynced local work" }),
    ).toBeInTheDocument();
    expect(await within(preview).findByRole("alert")).toHaveTextContent(
      "This note could not be found. It may have been deleted. Your changes are not saved.",
    );
    expect(await readPendingWrite("doc-1")).toMatchObject({
      fileId: "doc-1",
      text: "# Unsynced local work",
    });
  });

  it("pauses autosave while an image upload placeholder is in flight and saves once resolved", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedIn();
    const uploadGate = deferred<Response>();
    const puts: string[] = [];
    server.use(
      http.get("/api/files/doc-1/content", () => contentResponse("Intro\n", '"etag-1"')),
      http.post("/api/attachments", () => uploadGate.promise),
      http.put("/api/files/doc-1/content", async ({ request }) => {
        puts.push(await request.text());
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Intro\n"));
    act(() => {
      view.dispatch({ selection: { anchor: 6 } });
    });

    const file = new File([new Uint8Array(16)], "shot.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        files: [file],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
        types: ["Files"],
        getData: () => "",
      },
    });
    act(() => {
      view.contentDOM.dispatchEvent(pasteEvent);
    });
    expect(view.state.doc.toString()).toContain("![Uploading shot.png…]()");

    // Wait past AUTOSAVE_DELAY_MS: placeholder must NOT be autosaved.
    await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 250));
    expect(puts).toEqual([]);

    // Resolve upload: autosave now saves the final image Markdown link.
    uploadGate.resolve(
      HttpResponse.json(
        {
          id: "img-1",
          name: "shot.png",
          mimeType: "image/png",
          size: 16,
          url: "/api/files/img-1/blob",
        },
        { status: 201 },
      ),
    );
    expect(
      await within(editor).findByText("Saved", {}, { timeout: AUTOSAVE_DELAY_MS + 1_500 }),
    ).toBeInTheDocument();
    expect(puts).toEqual(["Intro\n![shot](/api/files/img-1/blob)"]);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially, is capped, and honours Retry-After", () => {
    const network = new TypeError("Failed to fetch");
    expect(retryDelayMs(1, network)).toBeGreaterThanOrEqual(1_000);
    expect(retryDelayMs(1, network)).toBeLessThanOrEqual(1_250);
    expect(retryDelayMs(3, network)).toBeGreaterThanOrEqual(4_000);
    expect(retryDelayMs(10, network)).toBe(30_000);
    expect(retryDelayMs(1, new ApiError(429, "rate_limited", "Busy", undefined, 7))).toBe(7_000);
  });
});
