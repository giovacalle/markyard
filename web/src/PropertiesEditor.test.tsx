import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { LIVE_DRAFT_DEBOUNCE_MS } from "./components/Editor";
import { clearLocalCache, writeCachedFile } from "./localCache";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(async () => {
  vi.useRealTimers();
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
  it("clicking the Properties trigger in Preview toggles the panel without entering Edit mode", async () => {
    setupNote("---\nstatus: ready\ntags: [test]\n---\n\n# Body\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    const properties = await within(preview).findByRole("group", { name: "Properties" });
    const trigger = within(properties).getByRole("button", { name: "Properties" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument();
  });

  it("renders Preview properties as a ui-sdk Collapsible", async () => {
    setupNote("---\nstatus: ready\ntags: [test]\n---\n\n# Body\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    const properties = await within(preview).findByRole("group", { name: "Properties" });
    expect(properties).toHaveAttribute("data-slot", "collapsible");
    const trigger = within(properties).getByRole("button", { name: "Properties" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(within(properties).queryByText("status")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(properties).getByText("ready"));
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument();
  });

  it("renders the Edit properties panel as a ui-sdk Collapsible, collapsed by default", async () => {
    setupNote("---\nstatus: ready\ntags: [test]\n---\n\n# Body\n");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Body" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = within(editor).getByRole("group", { name: "Properties" });
    expect(propsEditor).toHaveAttribute("data-slot", "collapsible");
    expect(propsEditor).toHaveAttribute("data-properties-editor");

    const toggle = within(propsEditor).getByRole("button", { name: /Properties/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(propsEditor).queryByRole("button", { name: "Add property" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(propsEditor).toHaveAttribute("data-open");
    expect(within(propsEditor).getByRole("button", { name: "Add property" })).toBeInTheDocument();
    // The collapsed preview hides once the panel shows the editable values.
    expect(within(toggle).queryByText("#test")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(toggle).getByText("#test")).toBeInTheDocument();
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
    const tagInput = within(propsEditor).getByRole("combobox", { name: "Add tag" });
    act(() => tagInput.focus());
    const suggestion = await screen.findByRole("option", { name: "#backend" });
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
    // Re-queried: the root switches between a plain div (raw YAML, no frontmatter) and the Collapsible.
    const propsEditor = () => editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    fireEvent.click(within(propsEditor()).getByRole("button", { name: /Properties/ }));
    expect(within(propsEditor()).getByText("Complex YAML")).toBeInTheDocument();

    // Jump to Raw YAML mode via "Edit in </>".
    fireEvent.click(within(propsEditor()).getByRole("button", { name: "Edit in </>" }));
    expect(within(propsEditor()).getByText("YAML frontmatter")).toBeInTheDocument();

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
    fireEvent.click(within(propsEditor()).getByRole("button", { name: "Visual" }));
    expect(view.state.doc.toString()).toBe("# Hello\n");
    expect(within(propsEditor()).getByRole("button", { name: "Edit status" })).toHaveTextContent(
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
    // Re-queried: the root switches between a plain div (raw YAML, no frontmatter) and the Collapsible.
    const propsEditor = () => editor.querySelector<HTMLElement>("[data-properties-editor]")!;

    fireEvent.click(within(propsEditor()).getByRole("button", { name: "Add property" }));
    fireEvent.change(within(propsEditor()).getByRole("textbox", { name: "Property key" }), {
      target: { value: "tags" },
    });
    const valueInput = within(propsEditor()).getByRole("textbox", { name: "Property value" });
    fireEvent.change(valueInput, { target: { value: "#ideas, design" } });
    fireEvent.keyDown(valueInput, { key: "Enter" });

    // Panel auto-expands and shows the newly added tags while CodeMirror keeps body-only.
    expect(within(propsEditor()).getByRole("button", { name: /Properties/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(propsEditor()).getByRole("button", { name: "Remove tag ideas" }),
    ).toBeInTheDocument();
    expect(
      within(propsEditor()).getByRole("button", { name: "Remove tag design" }),
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

  it("suggests vault tags in a ui-sdk Autocomplete: keys commit, comma commits, Escape stays in Edit", async () => {
    await writeCachedFile("other-id", "---\ntags: [backend, urgent]\n---\nOther\n", "r1");
    const saved: string[] = [];
    setupNote("---\ntags: [work, old]\n---\n\n# Body\n", (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Body" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const propsEditor = editor.querySelector<HTMLElement>("[data-properties-editor]")!;
    fireEvent.click(within(propsEditor).getByRole("button", { name: /Properties/ }));

    const tagInput = within(propsEditor).getByRole("combobox", { name: "Add tag" });
    expect(tagInput).toHaveAttribute("data-slot", "autocomplete-input");
    act(() => tagInput.focus());
    const list = await screen.findByRole("listbox", { name: "Tag suggestions" });
    const backend = within(list).getByRole("option", { name: "#backend" });
    expect(backend).toHaveAttribute("data-slot", "autocomplete-item");
    // Tags already on the note are not offered.
    expect(within(list).queryByRole("option", { name: "#work" })).toBeNull();

    // ArrowDown highlights the first suggestion; Enter commits it and clears the draft.
    fireEvent.keyDown(tagInput, { key: "ArrowDown" });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(
      await within(propsEditor).findByRole("button", { name: "Remove tag backend" }),
    ).toBeInTheDocument();
    expect(tagInput).toHaveValue("");

    // A trailing comma commits the draft.
    fireEvent.change(tagInput, { target: { value: "ops," } });
    expect(within(propsEditor).getByRole("button", { name: "Remove tag ops" })).toBeInTheDocument();
    expect(tagInput).toHaveValue("");

    // Backspace on an empty draft removes the last tag.
    fireEvent.keyDown(tagInput, { key: "Backspace" });
    expect(within(propsEditor).queryByRole("button", { name: "Remove tag ops" })).toBeNull();

    // Escape closes the suggestions and clears the draft without leaving Edit.
    act(() => tagInput.focus());
    fireEvent.change(tagInput, { target: { value: "urg" } });
    expect(await screen.findByRole("option", { name: "#urgent" })).toBeInTheDocument();
    fireEvent.keyDown(tagInput, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Tag suggestions" })).toBeNull(),
    );
    expect(tagInput).toHaveValue("");
    expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();

    pressSave();
    await screen.findByText("Saved");
    expect(saved[0]).toBe("---\ntags: [work, old, backend]\n---\n\n# Body\n");
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
    const tagInputs = within(propsEditor).getAllByRole("combobox", { name: "Add tag" });
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

  it("keeps typed frontmatter YAML in the active editor buffer when toggling a task from an inline query widget", async () => {
    const initial = "- [ ] A\n\n```query\ntype: tasks\n```\n";
    const saved: string[] = [];
    setupNote(initial, (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("region", { name: "Query results" });
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = getEditorView(editor);

    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });
    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "A" })).toBeInTheDocument();
    });

    // Type frontmatter YAML at body start while in Visual mode and advance the live-draft debounce
    // so the inline query widget holds the post-YAML task offsets before the toggle click.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "---\ntitle: x\n---\n" } });
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_DRAFT_DEBOUNCE_MS);
    });
    vi.useRealTimers();

    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "A" }));

    const expected = "---\ntitle: x\n---\n- [x] A\n\n```query\ntype: tasks\n```\n";
    await waitFor(() => expect(saved).toEqual([expected]));
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("inverts joinFrontmatter without injecting a leading newline when pinned frontmatter has no trailing EOL", async () => {
    const initial = "---\ntitle: x\n---";
    const saved: string[] = [];
    setupNote(initial, (body) => saved.push(body));
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    fireEvent.click(await within(preview).findByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = getEditorView(editor);
    expect(view.state.doc.toString()).toBe("");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const typedBody = "- [ ] A\n\n```query\ntype: tasks\n```\n";
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: typedBody } });
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });
    act(() => {
      vi.advanceTimersByTime(LIVE_DRAFT_DEBOUNCE_MS);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "A" })).toBeInTheDocument();
    });

    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "A" }));

    const expectedBody = "- [x] A\n\n```query\ntype: tasks\n```\n";
    const expectedFull = `---\ntitle: x\n---\n${expectedBody}`;
    await waitFor(() => expect(saved).toEqual([expectedFull]));
    expect(view.state.doc.toString()).toBe(expectedBody);
  });
});
