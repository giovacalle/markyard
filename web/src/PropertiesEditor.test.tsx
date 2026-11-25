import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { App } from "./App";
import { clearLocalCache, writeCachedFile } from "./localCache";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(async () => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  window.localStorage.clear();
  await clearLocalCache();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-23T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function contentResponse(body: string, etag = '"etag-1"') {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function getEditorView(region: HTMLElement): EditorView {
  const host = region.querySelector('[data-testid="editor-host"]');
  const textbox = host?.shadowRoot?.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Note text"]',
  );
  if (!textbox) {
    throw new Error("CodeMirror textbox not found");
  }
  const view = EditorView.findFromDOM(textbox);
  if (!view) {
    throw new Error("EditorView not found");
  }
  return view;
}

function setupNote(markdown: string, onPut?: (body: string) => void) {
  history.replaceState(null, "", "/?file=doc-id");
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({ nodes: [node("doc-id", "note.md", "markdown")] }),
    ),
    http.get("/api/files/doc-id/content", () => contentResponse(markdown)),
    http.put("/api/files/doc-id/content", async ({ request }) => {
      onPut?.(await request.text());
      return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
    }),
  );
}

function pressSave() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

describe("Direction A frontmatter editing (PropertiesEditor + DocumentView)", () => {
  it("clicking <summary>Properties</summary> in Preview toggles details without entering Edit mode", async () => {
    setupNote("---\nstatus: ready\ntags: [test]\n---\n\n# Body\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    const properties = await within(preview).findByRole("group", { name: "Properties" });
    const summary = properties.querySelector("summary")!;
    expect(summary).not.toBeNull();

    fireEvent.click(summary);
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument();
  });

  it("hides PropertiesBar in Edit mode, places PropertiesEditor below toolbar, and edits body-only in Visual mode", async () => {
    setupNote("---\nstatus: ready\ntags: [test]\n---\n\n# Body\n\nParagraph.\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Body" });

    // Enter Edit mode.
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Zero duplicate `<details aria-label="Properties">` above toolbar.
    expect(editor.querySelector("details[aria-label='Properties']")).toBeNull();

    const toolbar = within(editor).getByRole("toolbar", { name: "Markdown formatting" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;
    const editorHost = within(editor).getByTestId("editor-host");
    expect(propsEditor).not.toBeNull();
    expect(
      toolbar.compareDocumentPosition(propsEditor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      propsEditor.compareDocumentPosition(editorHost) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Collapsed by default, showing compact tag + scalar summary.
    const toggle = within(propsEditor).getByRole("button", { name: /Properties/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(propsEditor).toHaveTextContent("#test");
    expect(propsEditor).toHaveTextContent("status: ready");

    // CodeMirror contains body ONLY (no raw YAML fences).
    const view = getEditorView(editor);
    expect(view.state.doc.toString()).toBe("# Body\n\nParagraph.\n");
    expect(view.state.doc.toString()).not.toContain("status: ready");
  });

  it("edits text, boolean, list, tags (with vault suggestions), add/delete while preserving YAML comments and Escape safety", async () => {
    await writeCachedFile("other-id", "---\ntags: [backend, urgent]\n---\nOther\n", "r1");
    const saved: string[] = [];
    setupNote(
      [
        "---",
        "# Keep this comment",
        "status: draft # inline note",
        "published: false",
        "tags: [work]",
        "aliases: [v1]",
        "---",
        "",
        "# Spec",
        "",
      ].join("\n"),
      (body) => saved.push(body),
    );
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Spec" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    // Expand Properties editor.
    fireEvent.click(within(propsEditor).getByRole("button", { name: /Properties/ }));

    // Edit text property: Escape cancels without exiting Edit mode.
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Edit status" }));
    const statusInput = within(propsEditor).getByRole("textbox", { name: "Edit status" });
    fireEvent.change(statusInput, { target: { value: "cancelled" } });
    fireEvent.keyDown(statusInput, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();
    expect(within(propsEditor).getByRole("button", { name: "Edit status" })).toHaveTextContent(
      "draft",
    );

    // Edit text property and commit with Enter.
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Edit status" }));
    const statusInput2 = within(propsEditor).getByRole("textbox", { name: "Edit status" });
    fireEvent.change(statusInput2, { target: { value: "ready" } });
    fireEvent.keyDown(statusInput2, { key: "Enter" });
    expect(within(propsEditor).getByRole("button", { name: "Edit status" })).toHaveTextContent(
      "ready",
    );

    // Toggle boolean switch.
    const pubSwitch = within(propsEditor).getByRole("switch", { name: "published" });
    expect(pubSwitch).toHaveAttribute("aria-checked", "false");
    expect(pubSwitch).toHaveAttribute("data-slot", "switch");
    fireEvent.click(pubSwitch);
    expect(within(propsEditor).getByRole("switch", { name: "published" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Tags: focus input, verify vault suggestion appears, click suggestion + type new tag.
    const tagInput = within(propsEditor).getByRole("textbox", { name: "Add tag" });
    fireEvent.focus(tagInput);
    const suggestion = await within(propsEditor).findByRole("option", { name: "#backend" });
    fireEvent.click(suggestion);
    expect(
      within(propsEditor).getByRole("button", { name: "Remove tag backend" }),
    ).toBeInTheDocument();

    fireEvent.change(tagInput, { target: { value: "#ops" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(within(propsEditor).getByRole("button", { name: "Remove tag ops" })).toBeInTheDocument();

    // Remove a tag with ×.
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Remove tag work" }));
    expect(within(propsEditor).queryByRole("button", { name: "Remove tag work" })).toBeNull();

    // Add list item.
    const listInput = within(propsEditor).getByRole("textbox", { name: "Add item to aliases" });
    fireEvent.change(listInput, { target: { value: "v2" } });
    fireEvent.keyDown(listInput, { key: "Enter" });
    expect(
      within(propsEditor).getByRole("button", { name: "Remove v2 from aliases" }),
    ).toBeInTheDocument();

    // Delete aliases property.
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Delete property aliases" }));
    expect(within(propsEditor).queryByRole("textbox", { name: "Add item to aliases" })).toBeNull();

    // Add new property (Escape cancels first without leaving Edit).
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Add property" }));
    const keyInput = within(propsEditor).getByRole("textbox", { name: "Property key" });
    fireEvent.keyDown(keyInput, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();

    fireEvent.click(within(propsEditor).getByRole("button", { name: "Add property" }));
    fireEvent.change(within(propsEditor).getByRole("textbox", { name: "Property key" }), {
      target: { value: "owner" },
    });
    const valInput = within(propsEditor).getByRole("textbox", { name: "Property value" });
    fireEvent.change(valInput, { target: { value: "giova" } });
    fireEvent.keyDown(valInput, { key: "Enter" });

    // Save and verify comments + surgical edits survived.
    pressSave();
    await screen.findByText("Saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain("# Keep this comment");
    expect(saved[0]).toContain("status: ready # inline note");
    expect(saved[0]).toContain("published: true");
    expect(saved[0]).toContain("tags: [backend, ops]");
    expect(saved[0]).toContain("owner: giova");
    expect(saved[0]).not.toContain("aliases:");
    expect(saved[0]).toMatch(/\n# Spec\n$/);
  });

  it("shows non-destructive Complex YAML badge and round-trips Visual <-> Raw YAML without losing edits", async () => {
    const saved: string[] = [];
    setupNote(
      [
        "---",
        "meta:",
        "  author: Alice",
        "  year: 2026",
        "status: draft",
        "---",
        "",
        "# Hello",
        "",
      ].join("\n"),
      (body) => saved.push(body),
    );
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Hello" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    fireEvent.click(within(propsEditor).getByRole("button", { name: /Properties/ }));
    expect(within(propsEditor).getByText("Complex YAML")).toBeInTheDocument();

    // Jump to Raw YAML mode via "Edit in </>".
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Edit in </>" }));
    expect(within(propsEditor).getByText("YAML frontmatter")).toBeInTheDocument();

    const view = getEditorView(editor);
    expect(view.state.doc.toString()).toContain("  author: Alice");
    expect(view.state.doc.toString()).toContain("status: draft");

    // Edit status directly in raw YAML.
    const rawDoc = view.state.doc.toString();
    const pos = rawDoc.indexOf("draft");
    act(() => {
      view.dispatch({ changes: { from: pos, to: pos + "draft".length, insert: "shipped" } });
    });

    // Switch back to Visual mode: body-only restored, visual card reflects `shipped` and nested YAML preserved.
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Visual" }));
    expect(view.state.doc.toString()).toBe("# Hello\n");
    expect(within(propsEditor).getByRole("button", { name: "Edit status" })).toHaveTextContent(
      "shipped",
    );

    pressSave();
    await screen.findByText("Saved");
    expect(saved[0]).toContain("meta:\n  author: Alice\n  year: 2026");
    expect(saved[0]).toContain("status: shipped");
    expect(saved[0]).toContain("# Hello\n");
  });

  it("adds frontmatter cleanly to a note without frontmatter via the + Add property chip", async () => {
    const saved: string[] = [];
    setupNote("# Plain note\n\nBody text.\n", (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Plain note" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    fireEvent.click(within(propsEditor).getByRole("button", { name: "Add property" }));
    fireEvent.change(within(propsEditor).getByRole("textbox", { name: "Property key" }), {
      target: { value: "tags" },
    });
    const valueInput = within(propsEditor).getByRole("textbox", { name: "Property value" });
    fireEvent.change(valueInput, { target: { value: "#ideas, design" } });
    fireEvent.keyDown(valueInput, { key: "Enter" });

    // Panel auto-expands and shows the newly added tags while CodeMirror keeps body-only.
    expect(within(propsEditor).getByRole("button", { name: /Properties/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(propsEditor).getByRole("button", { name: "Remove tag ideas" }),
    ).toBeInTheDocument();
    expect(
      within(propsEditor).getByRole("button", { name: "Remove tag design" }),
    ).toBeInTheDocument();
    expect(getEditorView(editor).state.doc.toString()).toBe("# Plain note\n\nBody text.\n");

    pressSave();
    await screen.findByText("Saved");
    expect(saved[0]).toBe("---\ntags: [ideas, design]\n---\n\n# Plain note\n\nBody text.\n");
  });

  it("never duplicates frontmatter when pasting/typing a YAML block into an empty note in Visual mode (Repro A)", async () => {
    const saved: string[] = [];
    setupNote("", (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    fireEvent.click(await within(preview).findByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = getEditorView(editor);

    // Paste a frontmatter block directly into CodeMirror while in Visual mode.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "---\ntitle: Test\n---\n\nHello" } });
    });
    // Type another character — must NOT duplicate the YAML block.
    act(() => {
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, to: end, insert: "!" } });
    });

    pressSave();
    await screen.findByText("Saved");
    expect(saved[0]).toBe("---\ntitle: Test\n---\n\nHello!");

    // Editing the newly detected property in Visual mode cleanly resyncs CM6 to body-only.
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;
    fireEvent.click(within(propsEditor).getByRole("button", { name: /Properties/ }));
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Edit title" }));
    const titleInput = within(propsEditor).getByRole("textbox", { name: "Edit title" });
    fireEvent.change(titleInput, { target: { value: "Updated" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("Hello!");
  });

  it("never injects a phantom blank line when inserting a leading newline after frontmatter in Visual mode (Repro B)", async () => {
    const saved: string[] = [];
    setupNote("---\na: 1\n---\nBody", (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    fireEvent.click(await within(preview).findByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = getEditorView(editor);
    expect(view.state.doc.toString()).toBe("Body");

    // Insert leading newline at start of body, then type `x` at end.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "\n" } });
    });
    act(() => {
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, to: end, insert: "x" } });
    });

    pressSave();
    await screen.findByText("Saved");
    expect(saved[0]).toBe("---\na: 1\n---\n\nBodyx");
  });

  it("edits a second tag-like property (keywords) without overwriting the first (tags)", async () => {
    const saved: string[] = [];
    setupNote("---\ntags: [a]\nkeywords: [b]\n---\n\n# Body\n", (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Body" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    fireEvent.click(within(propsEditor).getByRole("button", { name: /Properties/ }));
    const tagInputs = within(propsEditor).getAllByRole("textbox", { name: "Add tag" });
    expect(tagInputs).toHaveLength(2);

    // Add `#c` specifically to the second tag property (`keywords`).
    fireEvent.change(tagInputs[1], { target: { value: "#c" } });
    fireEvent.keyDown(tagInputs[1], { key: "Enter" });

    pressSave();
    await screen.findByText("Saved");
    expect(saved[0]).toBe("---\ntags: [a]\nkeywords: [b, c]\n---\n\n# Body\n");
  });

  it("flushes text-property blur synchronously before an immediate </> YAML toggle", async () => {
    setupNote("---\nstatus: draft\n---\n\n# Body\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Body" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    fireEvent.click(within(propsEditor).getByRole("button", { name: /Properties/ }));
    fireEvent.click(within(propsEditor).getByRole("button", { name: "Edit status" }));
    const input = within(propsEditor).getByRole("textbox", { name: "Edit status" });
    fireEvent.change(input, { target: { value: "final" } });

    // Trigger blur and click </> YAML back-to-back in the same turn.
    const yamlBtn = within(propsEditor).getByRole("button", { name: "Edit raw YAML" });
    fireEvent.blur(input);
    fireEvent.click(yamlBtn);

    expect(getEditorView(editor).state.doc.toString()).toContain("status: final");
  });
});
