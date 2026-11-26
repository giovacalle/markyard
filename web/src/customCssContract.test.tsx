import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { AttachmentsPanel } from "./components/AttachmentsView";
import { Editor } from "./components/Editor";
import { SettingsDialog } from "./components/SettingsDialog";
import { TasksPanel } from "./components/TasksView";
import type { VaultDocument } from "./vaultDocuments";

const DOCUMENTED_VARIABLES = [
  "--markyard-font-ui",
  "--markyard-font-text",
  "--markyard-font-mono",
  "--markyard-text-size",
  "--markyard-line-height",
  "--markyard-text-width",
  "--markyard-accent",
] as const;

const DOCUMENTED_REGIONS = [
  "sidebar",
  "note-header",
  "preview",
  "editor",
  "info-drawer",
  "tasks",
  "attachments",
  "palette",
  "settings",
] as const;

const RAW_SOURCES = import.meta.glob<string>(
  [
    "./App.tsx",
    "./components/Editor.tsx",
    "./components/DocumentView.tsx",
    "./components/InfoDrawer.tsx",
    "./components/TasksView.tsx",
    "./components/AttachmentsView.tsx",
    "./components/CommandPalette.tsx",
    "./components/SettingsDialog.tsx",
  ],
  { query: "?raw", eager: true, import: "default" },
);

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function readRepoDoc(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function sourceOf(key: string): string {
  if (key === "./index.css") {
    return readRepoDoc("web/src/index.css");
  }
  const text = RAW_SOURCES[key];
  if (text === undefined || text.length === 0) {
    throw new Error(`Missing raw source for ${key}`);
  }
  return text;
}

function extractCssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) {
    throw new Error(`CSS block not found for selector: ${selector}`);
  }
  return match[1];
}

function shadowCssText(shadowRoot: ShadowRoot | null): string {
  if (shadowRoot === null) {
    return "";
  }
  const sheetText = Array.from(shadowRoot.adoptedStyleSheets)
    .map((sheet) =>
      Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n"),
    )
    .join("\n");
  const tagText = Array.from(shadowRoot.querySelectorAll("style"))
    .map((el) => el.textContent ?? "")
    .join("\n");
  return `${sheetText}\n${tagText}`;
}

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  document.documentElement.style.removeProperty("--markyard-text-size");
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-26T10:00:00.000Z";

function openNote(
  text = "# Contract\n\nBody text with [link](https://example.com) and [[Other]].\n",
) {
  history.replaceState(null, "", "/?file=doc-id");
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () =>
      HttpResponse.json({ id: "root-id", name: "Notes", kind: "folder", modifiedTime: MODIFIED }),
    ),
    http.get("/api/folders/:id/children", () =>
      HttpResponse.json({
        nodes: [
          { id: "doc-id", name: "contract.md", kind: "markdown", modifiedTime: MODIFIED },
          { id: "other-id", name: "Other.md", kind: "markdown", modifiedTime: MODIFIED },
        ],
      }),
    ),
    http.get("/api/changes/start-token", () => HttpResponse.json({ token: "tok-1" })),
    http.get(
      "/api/files/:id/content",
      () =>
        new HttpResponse(text, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream", ETag: '"etag-1"' },
        }),
    ),
  );
  render(<App />);
  return screen.findByRole("region", { name: "Preview" });
}

describe("Custom CSS contract — source surface (C1a, C6, C7, C10)", () => {
  it("reads every documented --markyard-* variable without defining any on :root or components", () => {
    const scannedEntries: [string, string][] = [
      ["./index.css", sourceOf("./index.css")],
      ...Object.entries(RAW_SOURCES),
    ];
    for (const [file, content] of scannedEntries) {
      expect(content.length, `${file} must be non-empty`).toBeGreaterThan(0);
    }

    const allSources = scannedEntries.map(([, content]) => content).join("\n");

    for (const variable of DOCUMENTED_VARIABLES) {
      expect(allSources).toContain(`var(${variable}`);
    }

    for (const [file, content] of scannedEntries) {
      expect(content, `${file} must leave --markyard-* unset`).not.toMatch(
        /--markyard-[a-z-]+\s*:/,
      );
    }
  });

  it("declares every documented data-region hook in its owning component", () => {
    expect(sourceOf("./App.tsx")).toContain('data-region="sidebar"');
    expect(sourceOf("./components/InfoDrawer.tsx")).toContain('data-region="info-drawer"');
    expect(sourceOf("./components/TasksView.tsx")).toContain('data-region="tasks"');
    expect(sourceOf("./components/AttachmentsView.tsx")).toContain('data-region="attachments"');
    expect(sourceOf("./components/CommandPalette.tsx")).toContain('data-region="palette"');
    expect(sourceOf("./components/SettingsDialog.tsx")).toContain('data-region="settings"');

    const documentView = sourceOf("./components/DocumentView.tsx");
    const noteHeaderMatches = documentView.match(/data-region="note-header"/g) ?? [];
    expect(noteHeaderMatches).toHaveLength(2);

    const modeRegionMatches =
      documentView.match(/data-region=\{[^}]*"preview"[^}]*"editor"[^}]*\}/g) ?? [];
    expect(modeRegionMatches).toHaveLength(2);
  });

  it("routes preview body, wikilinks and html UI font through the documented variables", () => {
    const css = sourceOf("./index.css");

    const previewBlock = extractCssBlock(css, ".markdown-preview");
    expect(previewBlock).toContain("var(--markyard-text-size");
    expect(previewBlock).toContain("var(--markyard-font-text");
    expect(previewBlock).toContain("var(--markyard-line-height");

    const wikilinkBlock = extractCssBlock(css, ".markdown-preview .wikilink");
    expect(wikilinkBlock).toContain("var(--markyard-accent");
    expect(wikilinkBlock).not.toContain("text-blue-700");
    expect(wikilinkBlock).not.toContain("dark:text-blue-300");

    expect(css).toContain("var(--markyard-font-ui, var(--default-font-family, ui-sans-serif");
  });
});

describe("Custom CSS contract — rendered regions & nesting (C1b, C1c, C2)", () => {
  it("tags sidebar, preview document-column, note-header, info-drawer, editor and palette with correct nesting", async () => {
    const previewSection = await openNote();
    await within(previewSection).findByRole("button", { name: "Document info" });

    // Preview region sits on document-column div, not on the outer <section>.
    expect(previewSection).not.toHaveAttribute("data-region");
    const previewCol = document.querySelector<HTMLElement>('[data-region="preview"]');
    expect(previewCol).not.toBeNull();
    expect(previewCol?.tagName).toBe("DIV");
    expect(previewCol).toHaveAttribute("data-slot", "document-column");

    // Sidebar and note-header exist.
    expect(document.querySelector('[data-region="sidebar"]')).not.toBeNull();
    const noteHeader = document.querySelector<HTMLElement>('[data-region="note-header"]');
    expect(noteHeader).not.toBeNull();
    expect(previewCol?.contains(noteHeader)).toBe(true);

    // Open Info drawer: sibling outside preview/editor.
    fireEvent.click(screen.getByRole("button", { name: "Document info" }));
    const drawer = await screen.findByRole("complementary", { name: "Document info" });
    expect(drawer).toHaveAttribute("data-region", "info-drawer");
    expect(document.querySelector('[data-region="info-drawer"]')).toBe(drawer);
    expect(previewCol?.contains(drawer)).toBe(false);

    // Switch to Edit mode with Info drawer still open.
    fireEvent.click(screen.getByTestId("editor-canvas"));
    await screen.findByRole("region", { name: "Editor" });
    const editorCol = document.querySelector<HTMLElement>('[data-region="editor"]');
    expect(editorCol).not.toBeNull();
    expect(document.querySelector('[data-region="preview"]')).toBeNull();
    expect(editorCol?.contains(noteHeader)).toBe(true);
    expect(editorCol?.contains(drawer)).toBe(false);

    // Open Command Palette via Cmd+K.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => {
      expect(document.querySelector('[data-region="palette"]')).not.toBeNull();
    });
  });

  it("tags the not-loaded branch wrapper with preview/editor and keeps note-header inside it", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () =>
        HttpResponse.json({ id: "root-id", name: "Notes", kind: "folder", modifiedTime: MODIFIED }),
      ),
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/changes/start-token", () => HttpResponse.json({ token: "tok-1" })),
      http.get("/api/files/:id/content", () => new Promise<never>(() => {})),
    );

    render(<App />);

    const section = await screen.findByRole("region", { name: "Preview" });
    expect(section).not.toHaveAttribute("data-region");

    const status = await within(section).findByRole("status");
    expect(status).toHaveTextContent("Loading note…");

    const previewWrapper = document.querySelector<HTMLElement>('[data-region="preview"]');
    expect(previewWrapper).not.toBeNull();
    expect(previewWrapper?.contains(status)).toBe(true);

    const header = section.querySelector<HTMLElement>('[data-region="note-header"]');
    if (header !== null) {
      expect(previewWrapper?.contains(header)).toBe(true);
    }
  });

  it("tags Settings, Tasks and Attachments regions when rendered", async () => {
    const sampleDocs: VaultDocument[] = [
      {
        id: "d1",
        name: "Plan.md",
        path: [],
        folderId: "root-id",
        text: "- [ ] item\n",
        revision: "r1",
      },
    ];

    const settingsRender = render(
      <SettingsDialog
        open
        onClose={vi.fn()}
        vaultName="Notes"
        onChangeVault={vi.fn()}
        theme="system"
        onThemeChange={vi.fn()}
        vaultPinned={false}
        pendingSyncCount={0}
        onClearCache={vi.fn(async () => undefined)}
      />,
    );
    expect(document.querySelector('[data-region="settings"]')).not.toBeNull();
    settingsRender.unmount();

    const tasksRender = render(
      <QueryClientProvider client={new QueryClient()}>
        <TasksPanel docs={sampleDocs} vaultPinned={false} onToggle={vi.fn()} onOpenNote={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(document.querySelector('[data-region="tasks"]')).not.toBeNull();
    tasksRender.unmount();

    server.use(http.get("/api/attachments", () => HttpResponse.json({ attachments: [] })));
    const attachmentsRender = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AttachmentsPanel
          docs={sampleDocs}
          vaultPinned={false}
          offline={false}
          readOnly={false}
          onOpenNote={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(document.querySelector('[data-region="attachments"]')).not.toBeNull();
    attachmentsRender.unmount();
  });

  it("wires --markyard-font-text, --markyard-text-size and --markyard-line-height into the Editor shadow root", async () => {
    render(<Editor initialText={"# Heading\n\nBody text"} onChange={vi.fn()} />);

    const host = screen.getByTestId("editor-host");
    await waitFor(() => {
      expect(host.shadowRoot).not.toBeNull();
    });

    const cssText = shadowCssText(host.shadowRoot);
    expect(cssText).toContain("var(--markyard-font-text");
    expect(cssText).toContain("var(--markyard-text-size");
    expect(cssText).toContain("var(--markyard-line-height");

    // Verify variable override reaches the editor root when the engine resolves CSS variables.
    document.documentElement.style.setProperty("--markyard-text-size", "22px");
    const cmEditor = host.shadowRoot?.querySelector<HTMLElement>(".cm-editor");
    expect(cmEditor).not.toBeNull();
    const computedFontSize = cmEditor ? getComputedStyle(cmEditor).fontSize : "";
    // jsdom may leave unresolved var(...) strings verbatim; real browser resolution is proven in E3/E6.
    expect(
      computedFontSize === "22px" || computedFontSize.includes("var(--markyard-text-size"),
    ).toBe(true);
  });
});

describe("Custom CSS contract — documentation (C3, C5, C8, C9)", () => {
  it("documents every variable, region, .dark mode, per-device scope and README link", () => {
    const doc = readRepoDoc("docs/custom-css.md");
    const readme = readRepoDoc("README.md");

    expect(readme).toContain("docs/custom-css.md");

    for (const variable of DOCUMENTED_VARIABLES) {
      expect(doc).toContain(variable);
    }
    for (const region of DOCUMENTED_REGIONS) {
      expect(doc).toContain(region);
    }
    expect(doc).toContain(".dark");
    expect(doc).toMatch(/per-device/i);
  });

  it("documents CodeMirror and KaTeX specificity limits without unqualified any-specificity claims", () => {
    const doc = readRepoDoc("docs/custom-css.md");

    expect(doc).toMatch(/CodeMirror/);
    expect(doc).toMatch(/KaTeX/);
    expect(doc).toMatch(/--cm-/);

    const paragraphs = doc.split(/\r?\n\r?\n/);
    for (const paragraph of paragraphs) {
      if (/any specificity/i.test(paragraph)) {
        expect(paragraph).toMatch(/CodeMirror/);
        expect(paragraph).toMatch(/layer/i);
      }
    }
  });

  it("documents exact preview/note-header and info-drawer nesting on dedicated lines", () => {
    const lines = readRepoDoc("docs/custom-css.md").split(/\r?\n/);

    expect(
      lines.some(
        (line) =>
          line.includes('data-region="preview"') &&
          line.includes("note-header") &&
          !line.includes("info-drawer") &&
          /(contain|inside)/i.test(line),
      ),
    ).toBe(true);

    expect(lines.some((line) => line.includes("info-drawer") && /outside/i.test(line))).toBe(true);

    for (const line of lines) {
      if (line.includes("info-drawer")) {
        expect(line).not.toMatch(/inside|contain/i);
      }
      expect(line).not.toMatch(/not nested/i);
    }
  });
});
