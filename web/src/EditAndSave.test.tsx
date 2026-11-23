import { insertNewline } from "@codemirror/commands";
import { getChunks, rejectChunk } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { clearLocalCache } from "./localCache";

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

const MODIFIED = "2026-11-01T10:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function signedInWithRoot(nodes = [node("doc-id", "a.md", "markdown")]) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes })),
  );
}

function contentResponse(body: BodyInit, etag = '"etag-1"') {
  return new HttpResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      ETag: etag,
    },
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
  const textbox = getEditorTextbox(region);
  const view = EditorView.findFromDOM(textbox);
  if (!view) {
    throw new Error("CodeMirror EditorView not found on textbox");
  }
  return view;
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
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
  const canvas = await within(preview).findByTestId("editor-canvas");
  fireEvent.click(canvas);
  return screen.findByRole("region", { name: "Editor" });
}

describe("edit and save", () => {
  it("saves the editor text with the revision tag and changes only the edited line", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    const original = "\uFEFF---\r\ntitle: T\r\n---\r\n# Head  \r\n[[Wiki Link]]\r\nold line\r\n";
    const expected = "\uFEFF---\r\ntitle: T\r\n---\r\n# Head  \r\n[[Wiki Link]]\r\nnew line\r\n";
    const puts: { ifMatch: string | null; contentType: string | null; body: Uint8Array }[] = [];
    let resolveSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });

    server.use(
      http.get("/api/files/:id/content", () =>
        contentResponse(new TextEncoder().encode(original), '"etag-1"'),
      ),
      http.put("/api/files/:id/content", async ({ request }) => {
        puts.push({
          ifMatch: request.headers.get("If-Match"),
          contentType: request.headers.get("Content-Type"),
          body: new Uint8Array(await request.arrayBuffer()),
        });
        await saveGate;
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);

    const editor = await enterEditor();
    const view = await getEditorView(editor);

    const docText = view.state.doc.toString();
    const from = docText.indexOf("old line");
    act(() => {
      view.dispatch({ changes: { from, to: from + "old line".length, insert: "new line" } });
    });

    expect(within(editor).getByRole("status")).toHaveTextContent("Unsaved changes");

    pressSave();
    expect(await within(editor).findByRole("status")).toHaveTextContent("Saving…");

    resolveSave();
    expect(await within(editor).findByText("Saved")).toHaveAttribute("role", "status");

    expect(puts).toHaveLength(1);
    expect(puts[0].ifMatch).toBe('"etag-1"');
    expect(Array.from(puts[0].body)).toEqual(utf8Bytes(expected));
  });

  it("toggles a Preview task checkbox in place and syncs exactly that byte with the revision tag", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    const original =
      "\uFEFF---\r\ntags: [x]\r\n---\r\n- [ ] ship [[Release Plan]]  \r\n```\r\n- [ ] code\r\n```\r\n";
    const expected = original.replace("- [ ] ship", "- [x] ship");
    const puts: { ifMatch: string | null; body: Uint8Array }[] = [];
    server.use(
      http.get("/api/files/:id/content", () =>
        contentResponse(new TextEncoder().encode(original), '"etag-1"'),
      ),
      http.put("/api/files/:id/content", async ({ request }) => {
        puts.push({
          ifMatch: request.headers.get("If-Match"),
          body: new Uint8Array(await request.arrayBuffer()),
        });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    const checkbox = await within(preview).findByRole("checkbox", {
      name: "ship Release Plan",
    });
    expect(within(preview).getAllByRole("checkbox")).toHaveLength(1);

    fireEvent.click(checkbox);

    expect(
      await within(preview).findByRole("checkbox", { name: "ship Release Plan" }),
    ).toBeChecked();
    expect(await within(preview).findByText("Saved")).toHaveAttribute("role", "status");
    expect(screen.getByRole("region", { name: "Preview" })).toBe(preview);
    expect(puts).toHaveLength(1);
    expect(puts[0].ifMatch).toBe('"etag-1"');
    expect(Array.from(puts[0].body)).toEqual(utf8Bytes(expected));
  });

  it("opens in Markdown preview, enters Editor on click, and returns to Preview on outside click or Escape", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    server.use(
      http.get("/api/files/:id/content", () =>
        contentResponse("# Original\n\nVisit [Example](https://example.com)\n", '"etag-1"'),
      ),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(within(preview).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(within(preview).queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Original" }),
    ).toBeInTheDocument();

    // Clicking a link inside Preview does not switch to Editor.
    const link = within(preview).getByRole("link", { name: "Example" });
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument();

    // Clicking while text is selected does not switch to Editor.
    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Original",
    } as Selection);
    try {
      fireEvent.click(within(preview).getByTestId("editor-canvas"));
      expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    } finally {
      getSelectionSpy.mockRestore();
    }

    // Clicking the rendered note enters Editor with caret at the end.
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = await getEditorView(editor);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);

    act(() => {
      view.dispatch({ changes: { from: 0, to: "# Original".length, insert: "# Updated" } });
    });
    expect(within(editor).getByRole("status")).toHaveTextContent("Unsaved changes");

    // Switching OS windows / browser tabs (window.blur) stays in Editor.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();

    // Clicking outside the editor canvas (e.g. header) returns to Preview with unsaved edits intact.
    fireEvent.mouseDown(within(editor).getByRole("banner"));
    const updatedPreview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(updatedPreview).findByRole("heading", { level: 3, name: "Updated" }),
    ).toBeInTheDocument();
    expect(within(updatedPreview).getByRole("status")).toHaveTextContent("Unsaved changes");

    // Clicking back into Preview restores Editor with the unsaved draft; Escape exits back to Preview.
    fireEvent.click(within(updatedPreview).getByTestId("editor-canvas"));
    const editorAgain = await screen.findByRole("region", { name: "Editor" });
    const viewAgain = await getEditorView(editorAgain);
    expect(viewAgain.state.doc.toString()).toBe(
      "# Updated\n\nVisit [Example](https://example.com)\n",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("region", { name: "Preview" })).toBeInTheDocument();
  });

  it("shows a click-to-write placeholder for empty existing notes in Preview", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    server.use(http.get("/api/files/:id/content", () => contentResponse("", '"etag-1"')));

    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByText("Click anywhere to start writing…"),
    ).toBeInTheDocument();

    fireEvent.click(within(preview).getByText("Click anywhere to start writing…"));
    expect(await screen.findByRole("region", { name: "Editor" })).toBeInTheDocument();
  });

  it("applies Markdown formatting actions from the editor toolbar", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    server.use(
      http.get("/api/files/:id/content", () => contentResponse("hello world\nitem", '"etag-1"')),
    );

    render(<App />);

    const editor = await enterEditor();
    const view = await getEditorView(editor);
    const toolbar = within(editor).getByRole("toolbar", { name: "Markdown formatting" });

    // Wrap selected word in bold.
    act(() => {
      view.dispatch({ selection: { anchor: 0, head: 5 } });
    });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Bold" }));
    expect(view.state.doc.toString()).toBe("**hello** world\nitem");

    // Prefix first line as Heading 1.
    fireEvent.click(within(toolbar).getByRole("button", { name: "Heading 1" }));
    expect(view.state.doc.toString()).toBe("# **hello** world\nitem");

    // Turn second line into a task list item.
    const secondLineStart = view.state.doc.toString().indexOf("item");
    act(() => {
      view.dispatch({ selection: { anchor: secondLineStart } });
    });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Task list" }));
    expect(view.state.doc.toString()).toBe("# **hello** world\n- [ ] item");

    expect(within(editor).getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("saves with Ctrl+S and Meta+S and prevents default in both modes", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    const puts: { ifMatch: string | null; text: string }[] = [];
    let saveCount = 0;
    server.use(
      http.get("/api/files/:id/content", () => contentResponse("# Start\n", '"etag-1"')),
      http.put("/api/files/:id/content", async ({ request }) => {
        saveCount += 1;
        puts.push({
          ifMatch: request.headers.get("If-Match"),
          text: await request.text(),
        });
        return new HttpResponse(null, {
          status: 204,
          headers: { ETag: `"etag-${saveCount + 1}"` },
        });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    await getEditorView(editor);

    // Clean Ctrl+S prevents default and sends no PUT.
    const cleanEvent = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(true);
    expect(puts).toHaveLength(0);

    const textbox = getEditorTextbox(editor);
    const view = EditorView.findFromDOM(textbox)!;

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "one\n" } });
    });

    const ctrlSave = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    act(() => {
      textbox.dispatchEvent(ctrlSave);
    });
    expect(ctrlSave.defaultPrevented).toBe(true);
    expect(await within(editor).findByText("Saved")).toBeInTheDocument();

    // Edit again, return to Preview via Escape, and save with Meta+S.
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "two\n" } });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    const previewAgain = await screen.findByRole("region", { name: "Preview" });

    const metaSave = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(metaSave);
    });
    expect(metaSave.defaultPrevented).toBe(true);
    expect(await within(previewAgain).findByText("Saved")).toBeInTheDocument();

    expect(puts).toEqual([
      { ifMatch: '"etag-1"', text: "# Start\none\n" },
      { ifMatch: '"etag-2"', text: "# Start\none\ntwo\n" },
    ]);
  });

  it("chains the returned ETag across consecutive saves without reopening", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    const tags: (string | null)[] = [];
    server.use(
      http.get("/api/files/:id/content", () => contentResponse("v1", '"etag-1"')),
      http.put("/api/files/:id/content", ({ request }) => {
        const tag = request.headers.get("If-Match");
        tags.push(tag);
        const next = tag === '"etag-1"' ? '"etag-2"' : '"etag-3"';
        return new HttpResponse(null, { status: 204, headers: { ETag: next } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);

    act(() => {
      view.dispatch({ changes: { from: 0, to: 2, insert: "v2" } });
    });
    pressSave();
    expect(await within(editor).findByText("Saved")).toBeInTheDocument();
    // Pressing Cmd+S while clean does not send a second PUT.
    pressSave();

    act(() => {
      view.dispatch({ changes: { from: 0, to: 2, insert: "v3" } });
    });
    pressSave();
    expect(await within(editor).findByText("Saved")).toBeInTheDocument();

    expect(tags).toEqual(['"etag-1"', '"etag-2"']);
  });

  it("preserves CRLF on inserted newlines, round-trips LF, and normalizes mixed endings to the first separator", async () => {
    const cases = [
      {
        id: "crlf-doc",
        initial: "first\r\nsecond\r\n",
        action: (view: EditorView) => {
          view.dispatch({ selection: { anchor: "first".length } });
          insertNewline(view);
        },
        expected: "first\r\n\r\nsecond\r\n",
      },
      {
        id: "lf-doc",
        initial: "first\nsecond\n",
        action: (view: EditorView) => {
          view.dispatch({ selection: { anchor: "first".length } });
          insertNewline(view);
        },
        expected: "first\n\nsecond\n",
      },
      {
        id: "mixed-doc",
        initial: "a\r\nb\nc\r\n",
        action: (view: EditorView) => {
          const from = view.state.doc.toString().indexOf("c");
          view.dispatch({ changes: { from, to: from + 1, insert: "d" } });
        },
        expected: "a\r\nb\r\nd\r\n",
      },
    ];

    for (const c of cases) {
      history.replaceState(null, "", `/?file=${c.id}`);
      signedInWithRoot([node(c.id, `${c.id}.md`, "markdown")]);
      const bodies: number[][] = [];
      server.use(
        http.get("/api/files/:id/content", () => contentResponse(c.initial, '"etag-1"')),
        http.put("/api/files/:id/content", async ({ request }) => {
          bodies.push(Array.from(new Uint8Array(await request.arrayBuffer())));
          return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
        }),
      );

      const { unmount } = render(<App />);
      const editor = await enterEditor();
      const view = await getEditorView(editor);

      act(() => {
        c.action(view);
      });
      pressSave();
      expect(await within(editor).findByText("Saved")).toBeInTheDocument();
      expect(bodies).toEqual([utf8Bytes(c.expected)]);
      unmount();
      server.resetHandlers();
    }
  });

  it("a refused save (412) shows the conflict notice; Reload asks first, then replaces the editor text and tag", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    let getCalls = 0;
    let putCalls = 0;
    const putTags: (string | null)[] = [];

    server.use(
      http.get("/api/files/:id/content", () => {
        getCalls += 1;
        return getCalls === 1
          ? contentResponse("initial", '"etag-1"')
          : contentResponse("remote", '"etag-9"');
      }),
      http.put("/api/files/:id/content", ({ request }) => {
        putCalls += 1;
        putTags.push(request.headers.get("If-Match"));
        if (putCalls === 1) {
          return HttpResponse.json(
            { code: "conflict", message: "The note changed on Drive since it was opened." },
            { status: 412 },
          );
        }
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-10"' } });
      }),
    );

    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    try {
      render(<App />);
      const editor = await enterEditor();
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "initial".length, insert: "local edit" } });
      });

      pressSave();
      expect(await within(editor).findByRole("alert")).toHaveTextContent(
        "This note changed on Drive since you opened it. Your changes are not saved.",
      );
      // Cmd+S does not retry while in conflict.
      pressSave();
      expect(putCalls).toBe(1);
      expect(view.state.doc.toString()).toBe("local edit");

      const reloadButton = within(editor).getByRole("button", {
        name: "Reload the remote version",
      });
      reloadButton.focus();
      fireEvent.click(reloadButton);
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy).toHaveBeenCalledWith(
        "Discard your changes and load the version on Drive?",
      );
      // One read after the 412: the queue checks Drive's copy before calling it a conflict.
      expect(getCalls).toBe(2);
      expect(view.state.doc.toString()).toBe("local edit");

      fireEvent.click(reloadButton);
      expect(confirmSpy).toHaveBeenCalledTimes(2);
      await vi.waitFor(async () =>
        expect((await getEditorView(editor)).state.doc.toString()).toBe("remote"),
      );
      expect(getCalls).toBe(3);
      expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(editor).getByRole("status")).toHaveTextContent("");
      expect(document.activeElement).not.toBe(document.body);

      const reloadedView = await getEditorView(editor);
      expect(reloadedView.state.doc.toString()).toBe("remote");

      act(() => {
        reloadedView.dispatch({
          changes: { from: 0, to: "remote".length, insert: "remote + mine" },
        });
      });
      pressSave();
      expect(await within(editor).findByText("Saved")).toBeInTheDocument();
      expect(putTags).toEqual(['"etag-1"', '"etag-9"']);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("a refused save (412) can be compared and merged, then saved with the fresh Drive tag", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    let getCalls = 0;
    const puts: { ifMatch: string | null; body: string }[] = [];
    server.use(
      http.get("/api/files/:id/content", () => {
        getCalls += 1;
        return getCalls === 1
          ? contentResponse("line one\r\nline two\r\n", '"etag-1"')
          : contentResponse("line one\r\nline 2 (drive)\r\n", '"etag-9"');
      }),
      http.put("/api/files/:id/content", async ({ request }) => {
        puts.push({ ifMatch: request.headers.get("If-Match"), body: await request.text() });
        return puts.length === 1
          ? HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 })
          : new HttpResponse(null, { status: 204, headers: { ETag: '"etag-10"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({ changes: { from: 0, to: 4, insert: "LINE" } });
    });
    pressSave();
    await within(editor).findByRole("alert");

    fireEvent.click(within(editor).getByRole("button", { name: "Compare & merge" }));
    const merge = await within(editor).findByRole("region", { name: "Compare and merge" });
    const mergeView = await vi.waitFor(() => {
      const textbox = merge
        .querySelector('[data-testid="merge-host"]')
        ?.shadowRoot?.querySelector<HTMLElement>('[role="textbox"][aria-label="Merged text"]');
      const found = textbox ? EditorView.findFromDOM(textbox) : null;
      if (!found) {
        throw new Error("merge view not mounted");
      }
      return found;
    });
    // Initial load, the queue's post-412 check, and the Compare read.
    expect(getCalls).toBe(3);
    expect(mergeView.state.doc.toString()).toBe("LINE one\nline two\n");
    expect(getChunks(mergeView.state)?.chunks.length).toBe(1);

    // Take Drive's version of the hunk, then keep my first-line edit on top of it.
    act(() => {
      rejectChunk(mergeView, 0);
    });
    expect(mergeView.state.doc.toString()).toBe("line one\nline 2 (drive)\n");
    act(() => {
      mergeView.dispatch({ changes: { from: 0, to: 4, insert: "LINE" } });
    });

    fireEvent.click(within(merge).getByRole("button", { name: "Save merged" }));
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ ifMatch: '"etag-9"', body: "LINE one\r\nline 2 (drive)\r\n" });
    await vi.waitFor(() => expect(within(editor).queryByRole("alert")).not.toBeInTheDocument());
    expect(within(editor).queryByRole("region", { name: "Compare and merge" })).toBeNull();
    expect((await getEditorView(editor)).state.doc.toString()).toBe("LINE one\nline 2 (drive)\n");
  });

  it("falls back to Reload when the Drive version cannot be fetched for comparison", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    let getCalls = 0;
    server.use(
      http.get("/api/files/:id/content", () => {
        getCalls += 1;
        if (getCalls === 1) return contentResponse("initial");
        // Call 2 is the queue's post-412 check (Drive differs: real conflict); call 3 is Compare.
        if (getCalls === 2) return contentResponse("remote", '"etag-9"');
        return HttpResponse.json({ code: "not_found", message: "Gone" }, { status: 404 });
      }),
      http.put("/api/files/:id/content", () =>
        HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 }),
      ),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "x" } });
    });
    pressSave();
    await within(editor).findByRole("alert");

    fireEvent.click(within(editor).getByRole("button", { name: "Compare & merge" }));
    expect(
      await within(editor).findByText(
        "Unable to load the Drive version to compare. Reload it, or keep editing.",
      ),
    ).toBeInTheDocument();
    expect(within(editor).getByRole("button", { name: "Reload the remote version" })).toBeEnabled();
    expect(view.state.doc.toString()).toBe("xinitial");
  });

  it("keeps conflict state and reports an error if reloading the remote version fails", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();

    let getCalls = 0;
    server.use(
      http.get("/api/files/:id/content", () => {
        getCalls += 1;
        if (getCalls === 1) return contentResponse("initial", '"etag-1"');
        // Call 2 is the queue's post-412 check (Drive differs: a real conflict); 3 is the reload.
        if (getCalls === 2) return contentResponse("remote ok", '"etag-9"');
        if (getCalls === 3) {
          return HttpResponse.json({ code: "upstream_error", message: "Down" }, { status: 502 });
        }
        return contentResponse("remote ok", '"etag-9"');
      }),
      http.put("/api/files/:id/content", () =>
        HttpResponse.json({ code: "conflict", message: "Conflict" }, { status: 412 }),
      ),
    );

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<App />);
      const editor = await enterEditor();
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "initial".length, insert: "mine" } });
      });

      pressSave();
      await within(editor).findByRole("alert");

      fireEvent.click(within(editor).getByRole("button", { name: "Reload the remote version" }));
      expect(
        await within(editor).findByText("Unable to load the remote version. Try again."),
      ).toBeInTheDocument();
      expect(view.state.doc.toString()).toBe("mine");

      fireEvent.click(within(editor).getByRole("button", { name: "Reload the remote version" }));
      await vi.waitFor(async () =>
        expect((await getEditorView(editor)).state.doc.toString()).toBe("remote ok"),
      );
      expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("keeps editor text and allows retry on network, rate limit, and backend save errors", async () => {
    const cases = [
      {
        label: "network",
        fail: () => HttpResponse.error(),
        message:
          "Unable to reach the server. Your changes are saved locally and will sync when online.",
      },
      {
        label: "rate limit",
        fail: () =>
          HttpResponse.json(
            { code: "rate_limited", message: "Busy" },
            { status: 429, headers: { "Retry-After": "5" } },
          ),
        message: "Google Drive is busy. Your changes are saved locally and will sync when retried.",
      },
      {
        label: "backend",
        fail: () => HttpResponse.json({ code: "upstream_error", message: "Down" }, { status: 502 }),
        message: "Unable to sync to Drive. Your changes are saved locally.",
      },
    ];

    for (const c of cases) {
      history.replaceState(null, "", "/?file=doc-id");
      signedInWithRoot();
      let putCalls = 0;
      server.use(
        http.get("/api/files/:id/content", () => contentResponse("start", '"etag-1"')),
        http.put("/api/files/:id/content", () => {
          putCalls += 1;
          return putCalls === 1
            ? c.fail()
            : new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
        }),
      );

      const { unmount } = render(<App />);
      const editor = await enterEditor();
      await vi.waitFor(async () => {
        expect((await getEditorView(editor)).state.doc.toString()).toBe("start");
      });
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "start".length, insert: `edited-${c.label}` } });
      });

      pressSave();
      expect(await within(editor).findByRole("alert")).toHaveTextContent(c.message);
      expect(view.state.doc.toString()).toBe(`edited-${c.label}`);

      const retry = within(editor).getByRole("button", { name: "Retry" });
      retry.focus();
      fireEvent.click(retry);

      expect(await within(editor).findByText("Saved")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();
      expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
      expect(document.activeElement).not.toBe(document.body);
      expect(putCalls).toBe(2);

      unmount();
      await clearLocalCache();
      server.resetHandlers();
    }
  });

  it("shows non-retryable save errors for 404 and 413 while keeping editor text", async () => {
    const cases = [
      {
        status: 404,
        code: "not_found",
        message:
          "This note could not be found. It may have been deleted. Your changes are not saved.",
      },
      {
        status: 413,
        code: "too_large",
        message: "This note is larger than 10 MB and cannot be saved.",
      },
    ];

    for (const c of cases) {
      history.replaceState(null, "", "/?file=doc-id");
      signedInWithRoot();
      server.use(
        http.get("/api/files/:id/content", () => contentResponse("start", '"etag-1"')),
        http.put("/api/files/:id/content", () =>
          HttpResponse.json({ code: c.code, message: "err" }, { status: c.status }),
        ),
      );

      const { unmount } = render(<App />);
      const editor = await enterEditor();
      await vi.waitFor(async () => {
        expect((await getEditorView(editor)).state.doc.toString()).toBe("start");
      });
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "start".length, insert: "kept text" } });
      });

      pressSave();
      expect(await within(editor).findByRole("alert")).toHaveTextContent(c.message);
      expect(within(editor).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(view.state.doc.toString()).toBe("kept text");

      unmount();
      await clearLocalCache();
      server.resetHandlers();
    }
  });

  it("allows editing and saving again after a 413 too_large error once the draft is shortened", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    const puts: string[] = [];
    server.use(
      http.get("/api/files/:id/content", () => contentResponse("start", '"etag-1"')),
      http.put("/api/files/:id/content", async ({ request }) => {
        const body = await request.text();
        puts.push(body);
        if (body.length > 10) {
          return HttpResponse.json({ code: "too_large", message: "Too big" }, { status: 413 });
        }
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("start"));

    // Oversized edit hits 413; pressing Cmd+S without changing text does not resend it.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 5, insert: "way too large payload" } });
    });
    pressSave();
    expect(await within(editor).findByRole("alert")).toHaveTextContent("larger than 10 MB");
    pressSave();
    expect(puts).toEqual(["way too large payload"]);

    // Shortening the draft unblocks saving and clears the 413 alert.
    act(() => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "short" },
      });
    });
    pressSave();
    expect(await within(editor).findByText("Saved")).toBeInTheDocument();
    expect(within(editor).queryByRole("alert")).not.toBeInTheDocument();
    expect(puts).toEqual(["way too large payload", "short"]);
  });

  it("flushes edits automatically without confirmation when switching files", async () => {
    signedInWithRoot([node("one-id", "one.md", "markdown"), node("two-id", "two.md", "markdown")]);
    const saved: { fileId: string; text: string }[] = [];
    server.use(
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(params.id === "one-id" ? "# One" : "# Two", `"etag-${String(params.id)}"`),
      ),
      http.put("/api/files/:id/content", async ({ params, request }) => {
        saved.push({ fileId: String(params.id), text: await request.text() });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-one-2"' } });
      }),
    );

    const confirmSpy = vi.spyOn(window, "confirm");

    try {
      render(<App />);
      const oneItem = await screen.findByRole("treeitem", { name: /one\.md/ });
      const twoItem = screen.getByRole("treeitem", { name: /two\.md/ });

      fireEvent.click(oneItem);
      const editor = await enterEditor();
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "# One".length, insert: "# One edited" } });
      });

      fireEvent.click(twoItem);
      expect(confirmSpy).not.toHaveBeenCalled();
      const twoPreview = await screen.findByRole("region", { name: "Preview" });
      expect(
        await within(twoPreview).findByRole("heading", { level: 3, name: "Two" }),
      ).toBeInTheDocument();
      expect(window.location.search).toBe("?file=two-id");
      expect(twoItem).toHaveAttribute("aria-selected", "true");
      expect(oneItem).toHaveAttribute("aria-selected", "false");

      await vi.waitFor(() => {
        expect(saved).toEqual([{ fileId: "one-id", text: "# One edited" }]);
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("flushes edits automatically without confirmation on back navigation", async () => {
    history.replaceState(null, "", "/?file=one-id");
    signedInWithRoot([node("one-id", "one.md", "markdown"), node("two-id", "two.md", "markdown")]);
    const saved: { fileId: string; text: string }[] = [];
    server.use(
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(params.id === "one-id" ? "# One" : "# Two", `"etag-${String(params.id)}"`),
      ),
      http.put("/api/files/:id/content", async ({ params, request }) => {
        saved.push({ fileId: String(params.id), text: await request.text() });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-one-2"' } });
      }),
    );

    const confirmSpy = vi.spyOn(window, "confirm");

    try {
      render(<App />);
      const editor = await enterEditor();
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "# One".length, insert: "# Dirty" } });
      });

      act(() => {
        history.replaceState(null, "", "/?file=two-id");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(confirmSpy).not.toHaveBeenCalled();
      const twoPreview = await screen.findByRole("region", { name: "Preview" });
      expect(
        await within(twoPreview).findByRole("heading", { level: 3, name: "Two" }),
      ).toBeInTheDocument();
      expect(window.location.search).toBe("?file=two-id");
      await vi.waitFor(() => {
        expect(saved).toEqual([{ fileId: "one-id", text: "# Dirty" }]);
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("signs out without a discard confirmation dialog", async () => {
    history.replaceState(null, "", "/?file=one-id");
    let signedIn = true;
    let logoutCalls = 0;
    server.use(
      http.get("/api/session", () =>
        signedIn
          ? HttpResponse.json({ email: "owner@example.com" })
          : HttpResponse.json(
              { code: "unauthenticated", message: "Not signed in" },
              { status: 401 },
            ),
      ),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({
          nodes: [node("one-id", "one.md", "markdown"), node("two-id", "two.md", "markdown")],
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(params.id === "one-id" ? "# One" : "# Two", '"etag-1"'),
      ),
      http.put(
        "/api/files/:id/content",
        () => new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } }),
      ),
      http.post("/api/auth/logout", () => {
        logoutCalls += 1;
        signedIn = false;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const confirmSpy = vi.spyOn(window, "confirm");

    try {
      render(<App />);
      const editor = await enterEditor();
      const view = await getEditorView(editor);
      act(() => {
        view.dispatch({ changes: { from: 0, to: "# One".length, insert: "# One dirty" } });
      });

      const accountTrigger = screen.getByRole("button", { name: /Account: owner@example\.com/ });
      fireEvent.click(accountTrigger);
      fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(await screen.findByRole("region", { name: "Sign in" })).toBeInTheDocument();
      expect(logoutCalls).toBe(1);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("does not block beforeunload during normal editing and flushes on pagehide", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    const saved: string[] = [];
    server.use(
      http.get("/api/files/:id/content", () => contentResponse("clean", '"etag-1"')),
      http.put("/api/files/:id/content", async ({ request }) => {
        saved.push(await request.text());
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);

    act(() => {
      view.dispatch({ changes: { from: 0, to: "clean".length, insert: "dirty" } });
    });

    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await vi.waitFor(() => {
      expect(saved).toEqual(["dirty"]);
    });
  });

  it("focuses the editor at the end of the note when clicking empty space in the editor canvas", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    server.use(
      http.get("/api/files/:id/content", () => contentResponse("Hello world", '"etag-1"')),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({ selection: { anchor: 0 } });
      view.contentDOM.blur();
    });

    const focusSpy = vi.spyOn(view, "focus");
    const canvas = within(editor).getByTestId("editor-canvas");
    fireEvent.mouseDown(canvas, { button: 0 });

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(view.state.selection.main.head).toBe("Hello world".length);
  });

  it("keeps the editor mounted on 401 save while dirty, then switches to Sign in once reverted", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    let signedIn = true;
    const endedBody = {
      code: "unauthenticated",
      message: "Your session has ended. Sign in again.",
      reason: "session_ended",
    };

    server.use(
      http.get("/api/session", () =>
        signedIn
          ? HttpResponse.json({ email: "owner@example.com" })
          : HttpResponse.json(endedBody, { status: 401 }),
      ),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({ nodes: [node("doc-id", "a.md", "markdown")] }),
      ),
      http.get("/api/files/:id/content", () => contentResponse("original text", '"etag-1"')),
      http.put("/api/files/:id/content", () => {
        signedIn = false;
        return HttpResponse.json(endedBody, { status: 401 });
      }),
    );

    render(<App />);
    const editor = await enterEditor();
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({
        changes: { from: 0, to: "original text".length, insert: "unsaved precious draft" },
      });
    });

    pressSave();

    expect(await within(editor).findByRole("alert")).toHaveTextContent(
      "Your session has ended. Your changes are not saved.",
    );
    expect(within(editor).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(view.state.doc.toString()).toBe("unsaved precious draft");

    const account = screen.getByRole("region", { name: "Account" });
    expect(await within(account).findByRole("alert")).toHaveTextContent(
      "Your session has ended. Copy your unsaved changes, then sign in again.",
    );
    const signInAgain = within(account).getByRole("link", { name: "Sign in again" });
    expect(signInAgain).toHaveAttribute("href", "/api/auth/login");
    expect(screen.queryByRole("region", { name: "Sign in" })).not.toBeInTheDocument();

    // Reverting to the base text makes the note clean, so the Sign in screen takes over.
    act(() => {
      view.dispatch({
        changes: { from: 0, to: "unsaved precious draft".length, insert: "original text" },
      });
    });

    const signIn = await screen.findByRole("region", { name: "Sign in" });
    expect(within(signIn).getByRole("alert")).toHaveTextContent(
      "Your session has ended. Sign in again.",
    );
  });

  it("mounts CodeMirror styles in a shadow root adoptedStyleSheets instead of <style> tags", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    server.use(
      http.get("/api/files/:id/content", () => contentResponse("# CSP Safe\n", '"etag-1"')),
    );

    render(<App />);
    const editor = await enterEditor();
    await getEditorView(editor);

    const host = editor.querySelector('[data-testid="editor-host"]');
    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();
    expect(shadow!.adoptedStyleSheets.length).toBeGreaterThan(0);

    const ruleTexts = shadow!.adoptedStyleSheets.flatMap((sheet) =>
      Array.from(sheet.cssRules, (rule) => rule.cssText),
    );
    expect(ruleTexts.some((rule) => rule.includes(".cm-content"))).toBe(true);

    const styleElements = [
      ...Array.from(document.querySelectorAll("style")),
      ...Array.from(shadow!.querySelectorAll("style")),
    ];
    expect(
      styleElements.some((el) => el.textContent?.includes("cm-") || el.textContent?.includes("ͼ")),
    ).toBe(false);
  });
});
