import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";

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

function signedInWith(text: string) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({ nodes: [node("doc-1", "a.md", "markdown")] }),
    ),
    http.get(
      "/api/files/doc-1/content",
      () =>
        new HttpResponse(text, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream", ETag: '"etag-1"' },
        }),
    ),
    http.put(
      "/api/files/doc-1/content",
      () => new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } }),
    ),
  );
}

function findView(region: HTMLElement): EditorView | null {
  const textbox = region
    .querySelector('[data-testid="editor-host"]')
    ?.shadowRoot?.querySelector<HTMLElement>('[role="textbox"][aria-label="Note text"]');
  return textbox ? EditorView.findFromDOM(textbox) : null;
}

describe("Preview → Editor switch", () => {
  it("preloads the editor chunk while previewing, so the first click mounts it without a loading step", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedInWith("# Hello");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { name: "Hello" });
    // The idle preload runs while the note is only being read.
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 20));

    act(() => {
      fireEvent.click(within(preview).getByTestId("editor-canvas"));
    });

    // Same commit as the click: no "Loading editor…" fallback, CodeMirror is already there.
    const editor = screen.getByRole("region", { name: "Editor" });
    expect(within(editor).queryByText("Loading editor…")).not.toBeInTheDocument();
    expect(findView(editor)?.state.doc.toString()).toBe("# Hello");
  });

  it("keeps one CodeMirror instance across toggles and catches up with Preview task ticks", async () => {
    history.replaceState(null, "", "/?file=doc-1");
    signedInWith("- [ ] task\r\nbody\r\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    fireEvent.click(await within(preview).findByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const first = await vi.waitFor(() => {
      const view = findView(editor);
      if (!view) throw new Error("editor not mounted");
      return view;
    });
    act(() => {
      first.dispatch({ selection: { anchor: 3 } });
    });

    // Back to Preview: the editor stays mounted but hidden.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const previewAgain = await screen.findByRole("region", { name: "Preview" });
    expect(within(previewAgain).getByTestId("editor-slot")).not.toBeVisible();

    // Tick the task in Preview: a complete edit that syncs right away.
    fireEvent.click(await within(previewAgain).findByRole("checkbox"));
    expect(await within(previewAgain).findByText("Saved")).toBeInTheDocument();

    fireEvent.click(within(previewAgain).getByTestId("editor-canvas"));
    const editorAgain = await screen.findByRole("region", { name: "Editor" });
    const second = findView(editorAgain);
    expect(second).toBe(first);
    expect(second?.state.doc.toString()).toBe("- [x] task\nbody\n");
    // The catch-up is not a user edit: nothing new to save, and the cursor stayed put.
    expect(within(editorAgain).getByRole("status")).toHaveTextContent("Saved");
    expect(second?.state.selection.main.head).toBe(3);
  });
});
