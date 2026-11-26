import { EditorView } from "@codemirror/view";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { ConflictMerge } from "./components/ConflictMerge";
import { Editor } from "./components/Editor";
import { RevisionDiff } from "./components/RevisionDiff";
import { mountSvgInShadow } from "./cspSafeSvg";
import {
  adoptUserSheet,
  compileCustomCss,
  customCssDisabledByQuery,
  extractCssBlocks,
  getCustomCssSheet,
  getCustomCssStatusText,
  resetCustomCssForTests,
  setCustomCss,
} from "./customCss";
import {
  clearLocalCache,
  clearVaultCache,
  customCssCacheToken,
  readCachedCustomCss,
  updateChangesState,
  writeCachedCustomCss,
  writeCachedFile,
  writeCachedFolder,
  writeCachedRoot,
  writeCachedSession,
} from "./localCache";
import { updateSettings } from "./settings";
import { clearSelfWrites } from "./selfWrites";
import { childrenKey } from "./treeCache";
import { readRootFolderNotes } from "./vaultDocuments";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  clearSelfWrites();
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown", modifiedTime = MODIFIED) {
  return { id, name, kind, modifiedTime };
}

function markdown(text: string, etag: string) {
  return new HttpResponse(text, {
    headers: { "Content-Type": "application/octet-stream", ETag: `"${etag}"` },
  });
}

function sheetCssText(): string {
  const sheet = getCustomCssSheet();
  if (sheet === null) {
    return "";
  }
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
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

describe("extractCssBlocks and compileCustomCss", () => {
  it("extracts only exact css fenced blocks in document order", () => {
    const md = [
      "# Styles",
      "",
      "```css",
      ".a { color: red; }",
      "```",
      "",
      "```css2",
      ".ignored-1 { color: green; }",
      "```",
      "",
      "```scss",
      ".ignored-2 { color: yellow; }",
      "```",
      "",
      "```CSS x",
      ".ignored-3 { color: pink; }",
      "```",
      "",
      "```CSS",
      ".ignored-4 { color: purple; }",
      "```",
      "",
      "~~~  css  ",
      ".b { color: blue; }",
      "~~~",
      "",
      "````markdown",
      "```css",
      ".nested-ignored { color: orange; }",
      "```",
      "````",
      "",
      "````css",
      "/* fence with 3 backticks inside stays in block */",
      "```",
      ".c { color: teal; }",
      "````",
    ].join("\n");

    expect(extractCssBlocks(md)).toEqual([
      ".a { color: red; }",
      ".b { color: blue; }",
      "/* fence with 3 backticks inside stays in block */\n```\n.c { color: teal; }",
    ]);
  });

  it("concatenates notes in localeCompare name order and blocks in document order", () => {
    const css = compileCustomCss([
      { name: "z.md", text: "```css\n.z { opacity: 0.5; }\n```" },
      {
        name: "a.md",
        text: "```css\n.a1 { color: red; }\n```\n\n```css\n.a2 { color: blue; }\n```",
      },
      { name: "m.md", text: "No css blocks here." },
    ]);

    expect(css).toBe(".a1 { color: red; }\n\n.a2 { color: blue; }\n\n.z { opacity: 0.5; }");
  });
});

describe("shared constructable sheet and shadow roots", () => {
  it("adopts the shared sheet last on document and all four shadow-root hosts and updates in place", async () => {
    setCustomCss(".x { color: red; }");
    const sheet = getCustomCssSheet();
    expect(sheet).not.toBeNull();
    expect(document.adoptedStyleSheets.at(-1)).toBe(sheet);

    const { unmount: unmountEditor } = render(<Editor initialText="# Hi" onChange={vi.fn()} />);
    const { unmount: unmountMerge } = render(
      <ConflictMerge mine={"a\n"} remote={"b\n"} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    const { unmount: unmountDiff } = render(<RevisionDiff current={"a\n"} revision={"b\n"} />);
    const svgHost = document.createElement("div");
    document.body.append(svgHost);
    mountSvgInShadow(svgHost, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "");

    try {
      const roots = await vi.waitFor(() => {
        const editorShadow = screen.getByTestId("editor-host").shadowRoot;
        const mergeShadow = screen.getByTestId("merge-host").shadowRoot;
        const diffShadow = screen.getByTestId("revision-diff-host").shadowRoot;
        const svgShadow = svgHost.shadowRoot;
        if (!editorShadow || !mergeShadow || !diffShadow || !svgShadow) {
          throw new Error("Shadow root not mounted yet");
        }
        return [editorShadow, mergeShadow, diffShadow, svgShadow] as const;
      });

      for (const root of roots) {
        expect(root.adoptedStyleSheets.at(-1)).toBe(sheet);
      }
      expect(sheet!.cssRules[0]?.cssText).toContain("red");

      setCustomCss(".y { color: blue; }");
      expect(getCustomCssSheet()).toBe(sheet);
      expect(document.adoptedStyleSheets.at(-1)).toBe(sheet);
      for (const root of roots) {
        expect(root.adoptedStyleSheets.at(-1)).toBe(sheet);
      }
      expect(sheet!.cssRules[0]?.cssText).toContain("blue");
    } finally {
      unmountEditor();
      unmountMerge();
      unmountDiff();
      svgHost.remove();
    }
  });

  it("lets unlayered user rules beat layered app rules without !important", () => {
    const appSheet = new CSSStyleSheet();
    appSheet.replaceSync("@layer components { .markdown-preview h1 { color: rgb(0, 0, 255); } }");
    document.adoptedStyleSheets = [appSheet];

    const container = document.createElement("div");
    container.className = "markdown-preview";
    const heading = document.createElement("h1");
    heading.textContent = "Title";
    container.append(heading);
    document.body.append(container);

    try {
      expect(getComputedStyle(heading).color).toBe("rgb(0, 0, 255)");
      setCustomCss(".markdown-preview h1 { color: rgb(255, 0, 0); }");
      expect(getComputedStyle(heading).color).toBe("rgb(255, 0, 0)");
    } finally {
      container.remove();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== appSheet);
    }
  });

  it("stays unadopted and empty when disabled by ?nocss=1", () => {
    history.replaceState(null, "", "/?nocss=1");
    resetCustomCssForTests();

    expect(customCssDisabledByQuery()).toBe(true);
    setCustomCss(".x { color: red; }");

    const sheet = getCustomCssSheet();
    expect(sheet === null || sheet.cssRules.length === 0).toBe(true);
    expect(sheet === null || !document.adoptedStyleSheets.includes(sheet)).toBe(true);

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    adoptUserSheet(shadow);
    expect(shadow.adoptedStyleSheets).toHaveLength(0);
    expect(getCustomCssStatusText()).toBe("Disabled for this load by ?nocss=1");
  });
});

describe("test-setup custom CSS isolation", () => {
  it("applies custom CSS in the first test", () => {
    setCustomCss(".leak-check { color: red; }");
    const sheet = getCustomCssSheet()!;
    expect(sheet.cssRules.length).toBe(1);
    expect(document.adoptedStyleSheets).toContain(sheet);
  });

  it("starts with an empty, unadopted sheet in the next test", () => {
    const sheet = getCustomCssSheet()!;
    expect(sheet.cssRules.length).toBe(0);
    expect(document.adoptedStyleSheets).not.toContain(sheet);
  });
});

describe("custom CSS cache generation fencing", () => {
  it("drops stale writes after clearLocalCache and clearVaultCache", async () => {
    const token1 = customCssCacheToken();
    await clearLocalCache();
    await writeCachedCustomCss({ css: ".stale { color: red; }", notes: ["look.md"] }, token1);
    expect(await readCachedCustomCss()).toBeUndefined();

    const token2 = customCssCacheToken();
    await clearVaultCache();
    await writeCachedCustomCss({ css: ".stale2 { color: blue; }", notes: ["look.md"] }, token2);
    expect(await readCachedCustomCss()).toBeUndefined();
  });

  it("drops an in-flight style note compile write when clearLocalCache runs before it settles", async () => {
    let releaseContent!: () => void;
    const contentBlocked = new Promise<void>((resolve) => {
      releaseContent = resolve;
    });
    let contentRequested!: () => void;
    const contentStarted = new Promise<void>((resolve) => {
      contentRequested = resolve;
    });

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("styles-dir", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-dir/children", () =>
        HttpResponse.json({ nodes: [node("look-id", "look.md", "markdown")] }),
      ),
      http.get("/api/files/look-id/content", async () => {
        contentRequested();
        await contentBlocked;
        return markdown("```css\n.delayed { color: red; }\n```", "e1");
      }),
    );

    render(<App />);
    await contentStarted;
    await clearLocalCache();
    releaseContent();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(await readCachedCustomCss()).toBeUndefined();
  });
});

describe("custom CSS live loading, updates, offline safety and vault switches", () => {
  it("loads _styles/look.md, updates live after editing and saving, creates no style elements, and clears on unmount", async () => {
    const nonUiSdkStyleCountBefore = document.querySelectorAll('style:not([id^="ui-sdk-"])').length;
    let savedText = "```css\n.markdown-preview h1 { color: rgb(255, 0, 0); }\n```";

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("styles-dir", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-dir/children", () =>
        HttpResponse.json({ nodes: [node("look-id", "look.md", "markdown")] }),
      ),
      http.get("/api/files/look-id/content", () => markdown(savedText, "e1")),
      http.put("/api/files/look-id/content", async ({ request }) => {
        savedText = await request.text();
        return HttpResponse.json(
          { id: "look-id", modifiedTime: MODIFIED },
          { headers: { ETag: '"e2"' } },
        );
      }),
    );

    const { unmount } = render(<App />);
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(255, 0, 0)");
    });
    expect(document.querySelectorAll('style:not([id^="ui-sdk-"])').length).toBe(
      nonUiSdkStyleCountBefore,
    );
    expect(
      Array.from(document.querySelectorAll("style"), (el) => el.textContent ?? "").join("\n"),
    ).not.toContain("markdown-preview");

    // Open _styles/look.md, edit it, and save through Editor + SyncQueue.
    fireEvent.click(await screen.findByRole("treeitem", { name: /_styles/ }));
    fireEvent.click(await screen.findByRole("treeitem", { name: /look\.md/ }));
    const preview = await screen.findByRole("region", { name: "Preview" });
    fireEvent.click(await within(preview).findByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    const view = await getEditorView(editor);

    act(() => {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: "```css\n.markdown-preview h1 { color: rgb(0, 128, 0); }\n```",
        },
      });
    });
    pressSave();

    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(0, 128, 0)");
    });
    expect(sheetCssText()).not.toContain("rgb(255, 0, 0)");
    expect(document.querySelectorAll('style:not([id^="ui-sdk-"])').length).toBe(
      nonUiSdkStyleCountBefore,
    );
    expect(
      Array.from(document.querySelectorAll("style"), (el) => el.textContent ?? "").join("\n"),
    ).not.toContain("markdown-preview");

    unmount();
    expect(getCustomCssSheet()!.cssRules.length).toBe(0);
  });

  it("never wipes boot-cached CSS while offline before the styles folder is listed", async () => {
    const bootCss = ".boot-rule { color: rgb(10, 20, 30); }";
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("styles-dir", "_styles", "folder")]);
    await writeCachedCustomCss(
      { css: bootCss, notes: ["look.md"], updatedAt: 1234 },
      customCssCacheToken(),
    );
    setCustomCss(bootCss);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

    server.use(
      http.get("/api/session", () => HttpResponse.error()),
      http.get("/api/root", () => HttpResponse.error()),
      http.get("/api/folders/root-id/children", () => HttpResponse.error()),
    );

    render(<App />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(sheetCssText()).toContain("rgb(10, 20, 30)");
    expect(await readCachedCustomCss()).toMatchObject({ css: bootCss, updatedAt: 1234 });
  });

  it("keeps boot-cached CSS and cache row when a listed style note fails to fetch with 500", async () => {
    const bootCss = ".rule-a { color: rgb(11, 22, 33); }";
    await writeCachedCustomCss(
      { css: bootCss, notes: ["look.md"], updatedAt: 4321 },
      customCssCacheToken(),
    );
    setCustomCss(bootCss);

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({ nodes: [node("styles-dir", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-dir/children", () =>
        HttpResponse.json({ nodes: [node("look-id", "look.md", "markdown")] }),
      ),
      http.get("/api/files/look-id/content", () => new HttpResponse(null, { status: 500 })),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /_styles/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(sheetCssText()).toContain("rgb(11, 22, 33)");
    expect(await readCachedCustomCss()).toMatchObject({ css: bootCss, updatedAt: 4321 });
  });

  it("keeps boot-cached CSS and cache row when offline with an uncached listed style note", async () => {
    const bootCss = ".rule-a { color: rgb(44, 55, 66); }";
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [node("styles-dir", "_styles", "folder")]);
    await writeCachedFolder("styles-dir", [node("look-id", "look.md", "markdown")]);
    await writeCachedCustomCss(
      { css: bootCss, notes: ["look.md"], updatedAt: 5678 },
      customCssCacheToken(),
    );
    setCustomCss(bootCss);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });

    server.use(
      http.get("/api/session", () => HttpResponse.error()),
      http.get("/api/root", () => HttpResponse.error()),
      http.get("/api/folders/root-id/children", () => HttpResponse.error()),
      http.get("/api/folders/styles-dir/children", () => HttpResponse.error()),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /_styles/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(sheetCssText()).toContain("rgb(44, 55, 66)");
    expect(await readCachedCustomCss()).toMatchObject({ css: bootCss, updatedAt: 5678 });
  });

  it("falls back to the local copy when a forced fetch returns 500", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["root"], node("root-id", "Notes", "folder"));
    queryClient.setQueryData(childrenKey("root-id"), [node("styles-dir", "_styles", "folder")]);
    queryClient.setQueryData(childrenKey("styles-dir"), [node("look-id", "look.md", "markdown")]);
    await writeCachedFile("look-id", "```css\n.local-rule { color: rgb(1, 2, 3); }\n```", '"r1"');

    server.use(
      http.get("/api/files/look-id/content", () => new HttpResponse(null, { status: 500 })),
    );

    const result = await readRootFolderNotes(queryClient, "_styles", {
      forceIds: new Set(["look-id"]),
    });
    expect(result.state).toBe("known");
    expect(compileCustomCss(result.notes)).toContain("rgb(1, 2, 3)");
  });

  it("skips persisted Drive changes after hydrate and force-fetches only unseen style note changes", async () => {
    await writeCachedSession("owner@example.com");
    await writeCachedRoot(node("root-id", "Notes", "folder"));
    await writeCachedFolder("root-id", [
      node("styles-dir", "_styles", "folder"),
      node("other-id", "other.md", "markdown"),
    ]);
    await writeCachedFolder("styles-dir", [node("look-id", "look.md", "markdown")]);
    await writeCachedFile("look-id", "```css\n.v1 { color: rgb(1, 1, 1); }\n```", '"r1"');
    await updateChangesState({
      startPageToken: "t1",
      recent: [
        {
          id: "look-id",
          name: "look.md",
          parentId: "styles-dir",
          time: "2026-11-20T12:00:00.000Z",
        },
      ],
    });

    let lookRequests = 0;
    let otherRequests = 0;
    let queuedChanges: unknown[] = [];
    let poll = 0;

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [
            node("styles-dir", "_styles", "folder"),
            node("other-id", "other.md", "markdown"),
          ],
        }),
      ),
      http.get("/api/folders/styles-dir/children", () =>
        HttpResponse.json({ nodes: [node("look-id", "look.md", "markdown")] }),
      ),
      http.get("/api/changes", () => {
        const changes = queuedChanges;
        queuedChanges = [];
        poll += 1;
        return HttpResponse.json({ nextPageToken: `t${poll + 1}`, hasMore: false, changes });
      }),
      http.get("/api/files/look-id/content", () => {
        lookRequests += 1;
        return markdown("```css\n.v2 { color: rgb(2, 2, 2); }\n```", "r2");
      }),
      http.get("/api/files/other-id/content", () => {
        otherRequests += 1;
        return markdown("# Other", "o1");
      }),
    );

    render(<App />);
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(1, 1, 1)");
    });
    await vi.waitFor(() => {
      expect(poll).toBeGreaterThanOrEqual(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(lookRequests).toBe(0);
    expect(otherRequests).toBe(0);

    // Queue a new Drive change for look.md and trigger a poll via window focus.
    queuedChanges = [
      {
        fileId: "look-id",
        removed: false,
        time: "2026-11-20T13:00:00.000Z",
        node: node("look-id", "look.md", "markdown", "2026-11-20T13:00:00.000Z"),
        parentIds: ["styles-dir"],
      },
      {
        fileId: "other-id",
        removed: false,
        time: "2026-11-20T13:00:00.000Z",
        node: node("other-id", "other.md", "markdown", "2026-11-20T13:00:00.000Z"),
        parentIds: ["root-id"],
      },
    ];
    const pollsBefore = poll;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await vi.waitFor(() => {
      expect(poll).toBeGreaterThan(pollsBefore);
    });
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(2, 2, 2)");
    });
    expect(lookRequests).toBe(1);
    expect(otherRequests).toBe(0);
  });

  it("switches live when stylesFolder setting changes without remounting", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/root-id/children", () =>
        HttpResponse.json({
          nodes: [node("styles-dir", "_styles", "folder"), node("theme-dir", "theme", "folder")],
        }),
      ),
      http.get("/api/folders/styles-dir/children", () =>
        HttpResponse.json({ nodes: [node("a-id", "a.md", "markdown")] }),
      ),
      http.get("/api/folders/theme-dir/children", () =>
        HttpResponse.json({ nodes: [node("b-id", "b.md", "markdown")] }),
      ),
      http.get("/api/files/a-id/content", () =>
        markdown("```css\n.from-styles { color: rgb(100, 0, 0); }\n```", "e1"),
      ),
      http.get("/api/files/b-id/content", () =>
        markdown("```css\n.from-theme { color: rgb(0, 0, 100); }\n```", "e2"),
      ),
    );

    render(<App />);
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(100, 0, 0)");
    });

    act(() => {
      updateSettings({ stylesFolder: "theme" });
    });

    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(0, 0, 100)");
    });
    expect(sheetCssText()).not.toContain("rgb(100, 0, 0)");
  });

  it("replaces custom CSS when switching to a vault with different styles", async () => {
    let activeRoot = node("root-a", "Vault A", "folder");

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(activeRoot)),
      http.get("/api/drive/folders", () =>
        HttpResponse.json({
          parent: { id: "root", name: "My Drive" },
          folders: [node("root-a", "Vault A", "folder"), node("root-b", "Vault B", "folder")],
        }),
      ),
      http.put("/api/vault/root", () => {
        activeRoot = node("root-b", "Vault B", "folder");
        return HttpResponse.json({ root: activeRoot });
      }),
      http.get("/api/folders/root-a/children", () =>
        HttpResponse.json({ nodes: [node("styles-a", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-a/children", () =>
        HttpResponse.json({ nodes: [node("note-a", "a.md", "markdown")] }),
      ),
      http.get("/api/files/note-a/content", () =>
        markdown("```css\n.vault-a { color: rgb(111, 0, 0); }\n```", "ea"),
      ),
      http.get("/api/folders/root-b/children", () =>
        HttpResponse.json({ nodes: [node("styles-b", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-b/children", () =>
        HttpResponse.json({ nodes: [node("note-b", "b.md", "markdown")] }),
      ),
      http.get("/api/files/note-b/content", () =>
        markdown("```css\n.vault-b { color: rgb(0, 111, 0); }\n```", "eb"),
      ),
    );

    render(<App />);
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(111, 0, 0)");
    });

    fireEvent.click(await screen.findByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Vault" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change vault…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose vault folder" });
    fireEvent.click(await within(picker).findByRole("option", { name: /Vault B/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "Use “Vault B”" }));

    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(0, 111, 0)");
    });
    expect(sheetCssText()).not.toContain("rgb(111, 0, 0)");
  });

  it("empties custom CSS when switching to a vault with no _styles folder", async () => {
    let activeRoot = node("root-a", "Vault A", "folder");

    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => HttpResponse.json(activeRoot)),
      http.get("/api/drive/folders", () =>
        HttpResponse.json({
          parent: { id: "root", name: "My Drive" },
          folders: [node("root-a", "Vault A", "folder"), node("root-b", "Vault B", "folder")],
        }),
      ),
      http.put("/api/vault/root", () => {
        activeRoot = node("root-b", "Vault B", "folder");
        return HttpResponse.json({ root: activeRoot });
      }),
      http.get("/api/folders/root-a/children", () =>
        HttpResponse.json({ nodes: [node("styles-a", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-a/children", () =>
        HttpResponse.json({ nodes: [node("note-a", "a.md", "markdown")] }),
      ),
      http.get("/api/files/note-a/content", () =>
        markdown("```css\n.vault-a { color: rgb(111, 0, 0); }\n```", "ea"),
      ),
      http.get("/api/folders/root-b/children", () =>
        HttpResponse.json({ nodes: [node("doc-b", "hello.md", "markdown")] }),
      ),
    );

    render(<App />);
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(111, 0, 0)");
    });

    fireEvent.click(await screen.findByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Vault" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change vault…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose vault folder" });
    fireEvent.click(await within(picker).findByRole("option", { name: /Vault B/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "Use “Vault B”" }));

    await vi.waitFor(() => {
      expect(getCustomCssSheet()!.cssRules.length).toBe(0);
    });
  });

  it("keeps custom CSS applied without flashing empty when clearing local cache on the same vault", async () => {
    server.use(
      http.get("/api/session", () =>
        HttpResponse.json({ email: "owner@example.com", cloudSync: true }),
      ),
      http.get("/api/state", () =>
        HttpResponse.json({ enabled: true, state: { theme: "light" }, updatedAt: 5000 }),
      ),
      http.put("/api/state", async ({ request }) =>
        HttpResponse.json({ enabled: true, ...((await request.json()) as object) }),
      ),
      http.get("/api/root", () => HttpResponse.json(node("root-a", "Vault A", "folder"))),
      http.get("/api/folders/root-a/children", () =>
        HttpResponse.json({ nodes: [node("styles-a", "_styles", "folder")] }),
      ),
      http.get("/api/folders/styles-a/children", () =>
        HttpResponse.json({ nodes: [node("note-a", "look.md", "markdown")] }),
      ),
      http.get("/api/files/note-a/content", () =>
        markdown("```css\n.same-vault { color: rgb(200, 10, 10); }\n```", "ea"),
      ),
    );

    render(<App />);
    await vi.waitFor(() => {
      expect(sheetCssText()).toContain("rgb(200, 10, 10)");
    });

    const replaceSpy = vi.spyOn(getCustomCssSheet()!, "replaceSync");

    fireEvent.click(await screen.findByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Sync & Storage" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear local cache" }));
    const confirm = within(dialog).getByRole("group", { name: "Confirm clearing the local cache" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Clear cache" }));

    await within(dialog).findByText("Local cache cleared.");
    await vi.waitFor(async () => {
      expect(await readCachedCustomCss()).toBeDefined();
    });
    expect(replaceSpy).not.toHaveBeenCalledWith("");
    expect(sheetCssText()).toContain("rgb(200, 10, 10)");
  });
});
