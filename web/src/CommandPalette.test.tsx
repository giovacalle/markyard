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
  todayNoteInitialContent,
  todayNoteName,
} from "./commandSearch";
import { clearLocalCache, writeCachedFile } from "./localCache";

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

  it("extracts clean full-text snippets skipping frontmatter", () => {
    const md = "---\ntags: secret\n---\nIntro line\nWe should ship the rocket launch tomorrow.\n";
    expect(findContentSnippet(md, "secret")).toBeNull();
    expect(findContentSnippet(md, "rocket launch")).toEqual({
      before: "We should ship the ",
      match: "rocket launch",
      after: " tomorrow.",
      line: 5,
    });
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
});
