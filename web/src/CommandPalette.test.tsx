import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import {
  clearRecentFiles,
  extractHeadings,
  findContentSnippet,
  fuzzyMatch,
  matchFrontmatterTags,
  todayNoteInitialContent,
  todayNoteName,
} from "./commandSearch";
import { clearLocalCache, writeCachedFile } from "./localCache";
import { updateSettings } from "./settings";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(async () => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  clearRecentFiles();
  window.localStorage.clear();
  await clearLocalCache();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-21T01:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function contentResponse(body: string, etag = '"etag-1"') {
  return new HttpResponse(body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", ETag: etag },
  });
}

function pressCmdK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
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

describe("commandSearch unit helpers", () => {
  it("scores fuzzy matches and returns highlight indices", () => {
    const exact = fuzzyMatch("road", "roadmap.md");
    const fuzzy = fuzzyMatch("prj/rdm", "Projects/roadmap.md");
    expect(exact).not.toBeNull();
    expect(exact!.indices).toEqual([0, 1, 2, 3]);
    expect(fuzzy).not.toBeNull();
    expect(fuzzyMatch("zzz", "roadmap.md")).toBeNull();
  });

  it("extracts headings while skipping YAML frontmatter and fenced code blocks", () => {
    const md = [
      "---",
      "title: Ignored",
      "# Not a heading",
      "---",
      "# Main Title",
      "",
      "```md",
      "# Comment inside code",
      "```",
      "",
      "## **Bold** [Section](https://example.com)",
      "### Details ###",
    ].join("\n");

    expect(extractHeadings(md)).toEqual([
      { level: 1, text: "Main Title", line: 5, index: 0 },
      { level: 2, text: "Bold Section", line: 11, index: 1 },
      { level: 3, text: "Details", line: 12, index: 2 },
    ]);
  });

  it("extracts clean full-text snippets skipping frontmatter (including `...` closing fence)", () => {
    const md = "---\ntags: secret\n---\nIntro line\nWe should ship the rocket launch tomorrow.\n";
    expect(findContentSnippet(md, "secret")).toBeNull();
    expect(findContentSnippet(md, "rocket launch")).toEqual({
      before: "We should ship the ",
      match: "rocket launch",
      after: " tomorrow.",
      line: 5,
    });

    const dotMd = "---\ntitle: Hidden\n# Ignored heading\n...\n# Real Heading\nVisible line.\n";
    expect(extractHeadings(dotMd)).toEqual([{ level: 1, text: "Real Heading", line: 5, index: 0 }]);
    expect(findContentSnippet(dotMd, "Hidden")).toBeNull();
    expect(findContentSnippet(dotMd, "Visible")).toEqual({
      before: "",
      match: "Visible",
      after: " line.",
      line: 6,
    });
  });

  it("matches frontmatter tags case-insensitively with exact > prefix > substring priority", () => {
    const md = "---\ntags:\n  - #framework\n  - #work\n  - #workflow\n---\nBody\n";
    expect(matchFrontmatterTags(md, "#work")).toEqual(["work", "workflow", "framework"]);
    expect(matchFrontmatterTags(md, "WORK")).toEqual(["work", "workflow", "framework"]);
    expect(matchFrontmatterTags(md, "")).toEqual(["framework", "work", "workflow"]);
    expect(matchFrontmatterTags(md, "missing")).toEqual([]);
  });
});

describe("Command Palette (Cmd+K)", () => {
  it("opens with Cmd+K, shows recents, fuzzy-searches files by path, and opens with Enter", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [
            node("sub-1", "Projects", "folder"),
            node("a-id", "alpha.md", "markdown"),
            node("b-id", "beta.md", "markdown"),
          ],
        }),
      ),
      http.get("/api/folders/sub-1/children", () =>
        HttpResponse.json({ nodes: [node("road-id", "roadmap.md", "markdown")] }),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(`# Note ${String(params.id)}`),
      ),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
    );

    render(<App />);

    // Open alpha.md then beta.md so both are recorded in Recents (beta most recent).
    fireEvent.click(await screen.findByRole("treeitem", { name: /alpha\.md/ }));
    await screen.findByRole("heading", { level: 3, name: "Note a-id" });
    fireEvent.click(screen.getByRole("treeitem", { name: /beta\.md/ }));
    await screen.findByRole("heading", { level: 3, name: "Note b-id" });

    // Open palette via Cmd+K.
    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox", { name: "Search notes and commands" });

    // Recents show beta.md first, then alpha.md.
    const options = within(dialog).getAllByRole("option");
    expect(options[0]).toHaveTextContent("beta.md");
    expect(options[1]).toHaveTextContent("alpha.md");

    // Background folder warm-up loads Projects/roadmap.md so fuzzy path search finds it.
    await vi.waitFor(() => {
      fireEvent.change(input, { target: { value: "proj/road" } });
      expect(within(dialog).getByRole("option", { name: /roadmap\.md/ })).toBeInTheDocument();
    });

    const roadOption = within(dialog).getByRole("option", { name: /roadmap\.md/ });
    expect(roadOption).toHaveTextContent("Projects");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Note road-id" }),
    ).toBeInTheDocument();
  });

  it("sidebar search trigger: focuses the palette input in the click, forwards a typed key, labels the shortcut", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
    );

    render(<App />);

    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    const trigger = within(sidebar).getByRole("button", { name: "Search notes and commands" });
    // jsdom reports a Linux user agent, so the hint is spelled out and hidden on touch-only screens.
    const hint = within(trigger).getByText("Ctrl+K");
    expect(hint).toHaveClass("pointer-coarse:hidden");
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+K");

    // iOS only raises the keyboard when focus() runs inside the tap, so no timers here.
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox", { name: "Search notes and commands" });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });

    // A printable key typed on the focused trigger opens the palette with that key as the query.
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "r" });
    const reopened = screen.getByRole("dialog", { name: "Command palette" });
    const reopenedInput = within(reopened).getByRole("combobox", {
      name: "Search notes and commands",
    });
    expect(reopenedInput).toHaveValue("r");
    expect(reopenedInput).toHaveFocus();
    expect((reopenedInput as HTMLInputElement).selectionStart).toBe(1);

    // Modifier chords and Space keep their usual meaning.
    fireEvent.keyDown(reopenedInput, { key: "Escape" });
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
    fireEvent.keyDown(trigger, { key: "c", metaKey: true });
    fireEvent.keyDown(trigger, { key: " " });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("drives results with ui-sdk Command keyboard navigation and closes on one Escape", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [node("a-id", "alpha.md", "markdown"), node("b-id", "beta.md", "markdown")],
        }),
      ),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    const input = within(dialog).getByRole("combobox", { name: "Search notes and commands" });
    expect(input).toHaveAttribute("data-slot", "command-input");
    expect(input).toHaveFocus();

    await vi.waitFor(() => {
      const options = within(dialog).getAllByRole("option");
      expect(options.length).toBeGreaterThan(2);
      for (const option of options) {
        expect(option).toHaveAttribute("data-slot", "command-item");
      }
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = within(dialog).getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).not.toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(input);

    // ArrowUp twice from the second option wraps to the last one.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");

    // A query change moves the highlight back to the first result.
    fireEvent.change(input, { target: { value: ">theme" } });
    await vi.waitFor(() => {
      const themed = within(dialog).getAllByRole("option");
      expect(themed[0]).toHaveAccessibleName(/^Theme:/);
      expect(themed[0]).toHaveAttribute("aria-selected", "true");
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: ">theme:" } });
    await vi.waitFor(() => {
      expect(within(dialog).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    });

    // Nothing matches: the empty message sits outside the results listbox.
    fireEvent.change(input, { target: { value: ">zzqqxx" } });
    const listbox = within(dialog).getByRole("listbox", { name: "Search results" });
    const empty = await within(dialog).findByText("No matching commands.");
    expect(listbox).not.toContainElement(empty);

    // A non-empty query still closes the palette in one Escape.
    fireEvent.change(input, { target: { value: "alp" } });
    expect(input).toHaveValue("alp");
    fireEvent.keyDown(input, { key: "Escape" });
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("merges local full-text snippets from IndexedDB with remote Google Drive /api/search hits", async () => {
    await writeCachedFile("a-id", "# Alpha\n\nThis note mentions quantum computing.\n", '"e-1"');

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "alpha.md", "markdown")] }),
      ),
      http.get("/api/search", ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        if (q === "quantum") {
          return HttpResponse.json({
            results: [
              // Duplicate of local hit (should be deduplicated).
              { node: node("a-id", "alpha.md", "markdown"), path: [] },
              // Uncached remote file found on Drive.
              {
                node: node("remote-id", "physics.md", "markdown"),
                path: ["Archive", "Science"],
              },
            ],
          });
        }
        return HttpResponse.json({ results: [] });
      }),
      http.get("/api/files/remote-id/content", () => contentResponse("# Quantum Physics")),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");

    fireEvent.change(input, { target: { value: "quantum" } });

    // Local IndexedDB full-text snippet appears immediately.
    const localOption = await within(dialog).findByRole("option", { name: /alpha\.md/ });
    expect(localOption).toHaveTextContent("quantum");

    // Remote Drive match arrives after debounce and is merged without duplicating alpha.md.
    const remoteOption = await within(dialog).findByRole("option", { name: /physics\.md/ });
    expect(remoteOption).toHaveTextContent("Archive / Science");
    expect(remoteOption).toHaveTextContent("Drive");
    expect(within(dialog).getAllByRole("option", { name: /alpha\.md/ })).toHaveLength(1);

    fireEvent.click(remoteOption);
    expect(
      await screen.findByRole("heading", { level: 3, name: "Quantum Physics" }),
    ).toBeInTheDocument();
  });

  it("creates a new note on the fly when typing a non-existing filename", async () => {
    const posts: { folderId: string; name: string; content: string }[] = [];
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "alpha.md", "markdown")] }),
      ),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
      http.post("/api/folders/:id/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string; content: string };
        posts.push({ folderId: String(params.id), name: body.name, content: body.content });
        return HttpResponse.json(node("new-ideas", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-ideas"' },
        });
      }),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "weekend ideas" } });

    const createOption = await within(dialog).findByRole("option", {
      name: /Create "weekend ideas\.md"/,
    });
    fireEvent.click(createOption);

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(
      within(editor).getByRole("heading", { level: 2, name: "weekend ideas.md" }),
    ).toBeInTheDocument();
    expect(posts).toEqual([{ folderId: "root-id", name: "weekend ideas.md", content: "" }]);
  });

  it("> copy writes the current note as rich text, and the header button does the same", async () => {
    history.replaceState(null, "", "/?file=a-id");
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "alpha.md", "markdown")] }),
      ),
      http.get("/api/files/a-id/content", () => contentResponse("---\ntags: [x]\n---\n# Alpha")),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    try {
      render(<App />);
      const preview = await screen.findByRole("region", { name: "Preview" });
      await within(preview).findByRole("heading", { level: 3, name: "Alpha" });

      pressCmdK();
      const dialog = await screen.findByRole("dialog", { name: "Command palette" });
      fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">copy" } });
      fireEvent.click(within(dialog).getByRole("option", { name: /Copy as Rich Text/ }));
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("# Alpha"));

      fireEvent.click(within(preview).getByRole("button", { name: "Copy as rich text" }));
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("executes commands (> rename, > delete, > today's daily note, > theme, Cmd+\\ sidebar toggle)", async () => {
    history.replaceState(null, "", "/?file=a-id");
    const posts: { name: string; content: string }[] = [];
    const expectedToday = todayNoteName();
    const expectedTodayContent = todayNoteInitialContent();

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "alpha.md", "markdown")] }),
      ),
      http.get("/api/files/a-id/content", () => contentResponse("# Alpha")),
      http.post("/api/folders/root-id/files", async ({ request }) => {
        const body = (await request.json()) as { name: string; content: string };
        posts.push(body);
        return HttpResponse.json(node("daily-1", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-daily"' },
        });
      }),
    );

    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { level: 3, name: "Alpha" });

    // `> rename` triggers the inline header filename input.
    pressCmdK();
    let dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">rename" } });
    fireEvent.click(within(dialog).getByRole("option", { name: /Rename current note/ }));
    const renameInput = await screen.findByLabelText("File name");
    expect(renameInput).toHaveValue("alpha");
    fireEvent.keyDown(renameInput, { key: "Escape" });

    // `> delete` opens the Delete confirmation modal.
    pressCmdK();
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">delete" } });
    fireEvent.click(within(dialog).getByRole("option", { name: /Delete current note/ }));
    const deleteDialog = await screen.findByRole("dialog", { name: "Delete note" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Cancel" }));

    // `> dark` switches theme to dark mode.
    pressCmdK();
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">dark" } });
    fireEvent.click(within(dialog).getByRole("option", { name: /Theme: Dark/ }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Cmd+\ toggles sidebar visibility.
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(sidebar).not.toHaveAttribute("hidden");
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(sidebar).toHaveAttribute("hidden");

    // `> today` creates and opens Today's daily note in Editor with heading pre-filled.
    pressCmdK();
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">today" } });
    fireEvent.click(within(dialog).getByRole("option", { name: /Today's note/ }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(
      within(editor).getByRole("heading", { level: 2, name: expectedToday }),
    ).toBeInTheDocument();
    expect(posts).toEqual([{ name: expectedToday, content: expectedTodayContent }]);
  });

  it("jumps to headings via # mode in both Preview and Editor without leaving Editor mode", async () => {
    history.replaceState(null, "", "/?file=a-id");
    const longMd = [
      "# Top Title",
      "",
      "Intro paragraph.",
      "",
      "## Architecture",
      "",
      "Details here.",
      "",
      "### Deep Dive",
      "",
      "More text.",
    ].join("\n");

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "guide.md", "markdown")] }),
      ),
      http.get("/api/files/a-id/content", () => contentResponse(longMd)),
    );

    const scrollSpy = vi.fn();
    const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });

    try {
      render(<App />);
      const preview = await screen.findByRole("region", { name: "Preview" });
      await within(preview).findByRole("heading", { level: 3, name: "Top Title" });

      // In Preview mode, `#` lists headings and scrolls the chosen heading into view.
      pressCmdK();
      let dialog = await screen.findByRole("dialog", { name: "Command palette" });
      let input = within(dialog).getByRole("combobox");
      fireEvent.change(input, { target: { value: "#deep" } });

      const deepOpt = within(dialog).getByRole("option", { name: /Deep Dive/ });
      expect(deepOpt).toHaveTextContent("H3");
      fireEvent.keyDown(input, { key: "Enter" });

      await vi.waitFor(() => {
        expect(scrollSpy).toHaveBeenCalled();
      });

      // Enter Editor mode, open Cmd+K (should stay in Editor!), and jump to `## Architecture` (line 5).
      fireEvent.click(within(preview).getByTestId("editor-canvas"));
      const editor = await screen.findByRole("region", { name: "Editor" });
      await vi.waitFor(() => getEditorView(editor));

      pressCmdK();
      dialog = await screen.findByRole("dialog", { name: "Command palette" });
      expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();

      input = within(dialog).getByRole("combobox");
      fireEvent.change(input, { target: { value: "#arch" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await vi.waitFor(() => {
        const view = getEditorView(editor);
        const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
        expect(cursorLine).toBe(5);
      });
    } finally {
      if (originalScroll) {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });

  it("skips warming the root attachments folder and omits it from folder commands when hidden in Settings", async () => {
    updateSettings({ showAttachmentsFolder: false });
    const fetchedFolders: string[] = [];
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/:id/children", ({ params }) => {
        const id = String(params.id);
        fetchedFolders.push(id);
        if (id === "root-id") {
          return HttpResponse.json({
            nodes: [
              node("att-root", "_attachments", "folder"),
              node("proj-id", "Projects", "folder"),
              node("a-id", "alpha.md", "markdown"),
            ],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");

    await vi.waitFor(() => expect(fetchedFolders).toContain("proj-id"));
    expect(fetchedFolders).not.toContain("att-root");

    fireEvent.change(input, { target: { value: "_attachments" } });
    expect(within(dialog).queryByRole("option", { name: /New note in _attachments/ })).toBeNull();

    fireEvent.change(input, { target: { value: ">_attachments" } });
    expect(within(dialog).queryByRole("option", { name: /New note in _attachments/ })).toBeNull();

    // Turning the setting back on includes the attachments folder in warming and palette commands.
    act(() => updateSettings({ showAttachmentsFolder: true }));
    expect(
      within(dialog).getByRole("option", { name: /New note in _attachments/ }),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(fetchedFolders).toContain("att-root"));
  });

  it("searches frontmatter tags via `tag:` operator and regular local search", async () => {
    await writeCachedFile(
      "work-id",
      "---\ntags:\n  - #work\n  - quarterly\n---\nPlain body.\n",
      "r1",
    );
    await writeCachedFile(
      "home-id",
      "---\ntags: [personal, work-life]\n---\nAnother note.\n",
      "r2",
    );

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [
            node("work-id", "roadmap.md", "markdown"),
            node("home-id", "journal.md", "markdown"),
          ],
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(`# Loaded ${String(params.id)}`),
      ),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /roadmap\.md/ });

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");

    // `tag:` lists all known frontmatter tags with counts.
    fireEvent.change(input, { target: { value: "tag:" } });
    const workTagOption = await within(dialog).findByRole("option", { name: "#work" });
    expect(workTagOption).toHaveTextContent("1 note");
    expect(within(dialog).getByRole("option", { name: "#quarterly" })).toBeInTheDocument();

    // Selecting a tag narrows to `tag:work` and surfaces matching notes (exact first).
    fireEvent.click(workTagOption);
    expect(input).toHaveValue("tag:work");
    const taggedOptions = within(dialog).getAllByRole("option");
    expect(taggedOptions[0]).toHaveTextContent("roadmap.md");
    expect(taggedOptions[0]).toHaveTextContent("#work");
    expect(taggedOptions[1]).toHaveTextContent("journal.md");
    expect(taggedOptions[1]).toHaveTextContent("#work-life");

    // `tag:#quarterly` also works with an optional leading `#`.
    fireEvent.change(input, { target: { value: "tag:#quarterly" } });
    expect(within(dialog).getByRole("option", { name: /roadmap\.md/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /journal\.md/ })).toBeNull();

    // Regular local search (no `tag:` prefix) also matches frontmatter tags offline.
    fireEvent.change(input, { target: { value: "quarterly" } });
    const contentMatch = within(dialog).getByRole("option", { name: /roadmap\.md/ });
    expect(contentMatch).toHaveTextContent("#quarterly");
    expect(contentMatch).toHaveTextContent("Tag");
  });

  it("finds attachments by tag or filename in Cmd+K and tag: mode and opens them selected", async () => {
    await writeCachedFile("work-id", "---\ntags: [Cybercore]\n---\nNotes.\n", "r1");
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("work-id", "work.md", "markdown")] }),
      ),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
      http.get("/api/attachments", () =>
        HttpResponse.json({
          folderId: "att-folder",
          attachments: [
            {
              id: "img-cyber",
              name: "moodboard.png",
              mimeType: "image/png",
              size: 1024,
              modifiedTime: "2026-11-22T10:00:00.000Z",
              createdTime: "2026-11-22T10:00:00.000Z",
              url: "/api/files/img-cyber/blob",
              tags: ["Cybercore", "Y2K aesthetic"],
            },
          ],
        }),
      ),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /work\.md/ });

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");

    // `tag:` lists combined counts for notes and images.
    fireEvent.change(input, { target: { value: "tag:" } });
    const cyberTag = await within(dialog).findByRole("option", { name: /#Cybercore/ });
    expect(cyberTag).toHaveTextContent("1 note · 1 image");
    expect(within(dialog).getByRole("option", { name: /#Y2K aesthetic/ })).toHaveTextContent(
      "1 image",
    );

    // `tag:y2k` surfaces matching attachments.
    fireEvent.change(input, { target: { value: "tag:y2k" } });
    expect(within(dialog).getByRole("option", { name: /moodboard\.png/ })).toBeInTheDocument();

    // Global search also matches by tag and selecting opens Attachments with that image selected.
    fireEvent.change(input, { target: { value: "y2k" } });
    const attOption = within(dialog).getByRole("option", { name: /moodboard\.png/ });
    fireEvent.click(attOption);

    const info = await screen.findByRole("complementary", { name: "Attachment info" });
    expect(within(info).getByRole("heading", { name: "moodboard.png" })).toBeInTheDocument();
    expect(within(info).getByText("#Y2K aesthetic")).toBeInTheDocument();
  });

  it("opens 'New note from template…' from Cmd+K, creates note in chosen folder, and places cursor at {{cursor}}", async () => {
    const posts: { folderId: string; name: string; content: string }[] = [];
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({
            nodes: [
              node("tpl-dir", "Templates", "folder"),
              node("proj-dir", "Projects", "folder"),
              node("a-id", "alpha.md", "markdown"),
            ],
          });
        }
        if (params.id === "tpl-dir") {
          return HttpResponse.json({
            nodes: [node("tpl-spec", "Spec.md", "markdown")],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
      http.get("/api/vault/index", () =>
        HttpResponse.json({
          folders: [
            { id: "tpl-dir", name: "Templates", parentId: "root-id", modifiedTime: MODIFIED },
            { id: "proj-dir", name: "Projects", parentId: "root-id", modifiedTime: MODIFIED },
          ],
          files: [],
        }),
      ),
      http.get("/api/files/tpl-spec/content", () =>
        contentResponse("# {{title}}\nFolder: {{folder}}\n\n- {{cursor}}\n\nTail"),
      ),
      http.get("/api/search", () => HttpResponse.json({ results: [] })),
      http.post("/api/folders/:id/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string; content: string };
        posts.push({ folderId: String(params.id), name: body.name, content: body.content });
        return HttpResponse.json(node("new-spec-id", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-spec"' },
        });
      }),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    // Searchable without `>` as well as with `>`.
    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const paletteInput = within(palette).getByRole("combobox");
    fireEvent.change(paletteInput, { target: { value: "from template" } });
    fireEvent.click(within(palette).getByRole("option", { name: /New note from template…/ }));

    const tplDialog = await screen.findByRole("dialog", { name: "New note from template" });
    const titleInput = await within(tplDialog).findByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "Launch Plan" } });

    const projOption = await within(tplDialog).findByRole("option", { name: "Notes / Projects" });
    fireEvent.click(projOption);

    fireEvent.click(within(tplDialog).getByRole("button", { name: "Create note" }));

    const expectedBody = "# Launch Plan\nFolder: Projects\n\n- \n\nTail";
    const expectedCursor = expectedBody.indexOf("- ") + 2;

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(
      within(editor).getByRole("heading", { level: 2, name: "Launch Plan.md" }),
    ).toBeInTheDocument();
    await vi.waitFor(() => {
      const view = getEditorView(editor);
      expect(view.state.doc.toString()).toBe(expectedBody);
      expect(view.state.selection.main.head).toBe(expectedCursor);
    });
    expect(posts).toEqual([
      { folderId: "proj-dir", name: "Launch Plan.md", content: expectedBody },
    ]);
  });
});
