import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { ApiError } from "./api";
import {
  readCachedFile,
  readPendingWrite,
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
