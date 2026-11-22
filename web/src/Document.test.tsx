import { fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { MAX_PREVIEW_BYTES } from "./components/DocumentView";

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

function signedInWithRoot(name = "Notes") {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", name, "folder"))),
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

describe("open and preview a Markdown file", () => {
  it("opens a markdown node directly in Preview without a Preview button, renders GFM, and switches to Editor on click", async () => {
    signedInWithRoot();
    const contentCalls: string[] = [];
    const markdown = [
      "# Heading One",
      "",
      "- first item",
      "- second item",
      "",
      "| Col A | Col B |",
      "| --- | --- |",
      "| val 1 | val 2 |",
      "",
      "- [x] done task",
      "- [ ] **open** task",
      "  - [ ] child task",
      "",
      "```ts",
      "const x = 42;",
      "```",
    ].join("\n");

    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({ nodes: [node("doc-id", "a.md", "markdown")] }),
      ),
      http.get("/api/files/:id/content", ({ params }) => {
        contentCalls.push(String(params.id));
        return contentResponse(markdown);
      }),
    );

    render(<App />);

    const item = await screen.findByRole("treeitem", { name: /a\.md/ });
    fireEvent.click(item);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(within(preview).queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Heading One" }),
    ).toBeInTheDocument();
    expect(within(preview).getByText("first item")).toBeInTheDocument();
    expect(within(preview).getByRole("table")).toBeInTheDocument();
    expect(within(preview).getByText("val 1")).toBeInTheDocument();
    const doneCheckbox = within(preview).getByRole("checkbox", { name: "done task" });
    const openCheckbox = within(preview).getByRole("checkbox", { name: "open task" });
    const childCheckbox = within(preview).getByRole("checkbox", { name: "child task" });
    expect(within(preview).getAllByRole("checkbox")).toHaveLength(3);
    expect(doneCheckbox).toBeChecked();
    expect(openCheckbox).not.toBeChecked();
    expect(childCheckbox).not.toBeChecked();
    const code = preview.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain("const x = 42;");

    // Clicking the rendered note switches to Editor; pressing Escape returns to Preview.
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(within(editor).queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("region", { name: "Preview" })).toBeInTheDocument();

    expect(window.location.search).toBe("?file=doc-id");
    expect(contentCalls).toEqual(["doc-id"]);
  });

  it("hides YAML frontmatter from the rendered preview, even with a leading BOM and Enter activation", async () => {
    signedInWithRoot();
    const markdown = ["\uFEFF---", "title: Secret", "tags: [a, b]", "---", "# Body"].join("\n");
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({ nodes: [node("doc-id", "a.md", "markdown")] }),
      ),
      http.get("/api/files/:id/content", () => contentResponse(markdown)),
    );

    render(<App />);
    const item = await screen.findByRole("treeitem", { name: /a\.md/ });
    item.focus();
    fireEvent.keyDown(item, { key: "Enter" });

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Body" }),
    ).toBeInTheDocument();
    // Raw YAML never renders; its properties show as chips above the body instead.
    expect(within(preview).queryByText(/title:/)).not.toBeInTheDocument();
    expect(preview.querySelector(".markdown-preview")).not.toHaveTextContent("Secret");
    const properties = within(preview).getByRole("group", { name: "Properties" });
    expect(within(properties).getByText("#a")).toBeInTheDocument();
    expect(within(properties).getByText("#b")).toBeInTheDocument();
    expect(within(properties).getByText("title").nextElementSibling).toHaveTextContent("Secret");
    expect(window.location.search).toBe("?file=doc-id");
  });

  it("drops raw HTML and never executes scripts or event handlers", async () => {
    signedInWithRoot();
    const markdown = [
      "# Safe",
      "",
      "<script>window.__pwned=1</script>",
      '<img src="x" onerror="window.__pwned=1">',
      '<div onclick="window.__pwned=1">x</div>',
    ].join("\n");
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({ nodes: [node("doc-id", "a.md", "markdown")] }),
      ),
      http.get("/api/files/:id/content", () => contentResponse(markdown)),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.md/ }));

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Safe" }),
    ).toBeInTheDocument();
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.querySelector("[onclick]")).toBeNull();
    expect(within(preview).queryByText(/<script>|onerror|onclick/)).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("opens the document on direct load of ?file=<id> without expanding the tree", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    const requestedFolders: string[] = [];
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        requestedFolders.push(String(params.id));
        return HttpResponse.json({
          nodes: [node("sub-id", "Subfolder", "folder")],
        });
      }),
      http.get("/api/files/:id/content", ({ params }) => {
        expect(params.id).toBe("doc-id");
        return contentResponse("# Direct Note");
      }),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Direct Note" }),
    ).toBeInTheDocument();

    const folder = await screen.findByRole("treeitem", { name: /Subfolder/ });
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(requestedFolders).toEqual(["root-id"]);
  });

  it("shows a loading status while file content loads", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => new Promise<never>(() => {})),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(await within(preview).findByRole("status")).toHaveTextContent("Loading note…");
  });

  it("shows distinct messages for not found, too large, and invalid UTF-8", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({
          nodes: [
            node("missing-id", "missing.md", "markdown"),
            node("big-id", "big.md", "markdown"),
            node("bad-utf8-id", "bad.md", "markdown"),
          ],
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) => {
        if (params.id === "missing-id") {
          return HttpResponse.json({ code: "not_found", message: "Not found" }, { status: 404 });
        }
        if (params.id === "big-id") {
          return HttpResponse.json({ code: "too_large", message: "Too large" }, { status: 413 });
        }
        return contentResponse(new Uint8Array([0x41, 0xc3, 0x28]));
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("treeitem", { name: /missing\.md/ }));
    const docRegion = await screen.findByRole("region", { name: "Preview" });
    expect(await within(docRegion).findByRole("alert")).toHaveTextContent(
      "This note could not be found. It may have been deleted.",
    );

    fireEvent.click(screen.getByRole("treeitem", { name: /big\.md/ }));
    expect(await within(docRegion).findByRole("alert")).toHaveTextContent(
      "This file is larger than 10 MB and cannot be opened.",
    );

    fireEvent.click(screen.getByRole("treeitem", { name: /bad\.md/ }));
    expect(await within(docRegion).findByRole("alert")).toHaveTextContent(
      "This file is not valid UTF-8 text and cannot be opened.",
    );
  });

  it("shows a retryable error on 502 and recovers when retried", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    let calls = 0;
    server.use(
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: "upstream_error", message: "Down." }, { status: 502 })
          : contentResponse("# Recovered");
      }),
    );

    render(<App />);

    const docRegion = await screen.findByRole("region", { name: "Preview" });
    expect(await within(docRegion).findByRole("alert")).toHaveTextContent(
      "Unable to load this note.",
    );
    const retry = within(docRegion).getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Recovered" }),
    ).toBeInTheDocument();
    expect(within(preview).queryByRole("alert")).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("returns to sign-in when loading file content gets 401 session_ended", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    let signedIn = true;
    server.use(
      http.get("/api/session", () =>
        signedIn
          ? HttpResponse.json({ email: "owner@example.com" })
          : HttpResponse.json(
              {
                code: "unauthenticated",
                message: "Your session has ended. Sign in again.",
                reason: "session_ended",
              },
              { status: 401 },
            ),
      ),
      http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => {
        signedIn = false;
        return HttpResponse.json(
          {
            code: "unauthenticated",
            message: "Your session has ended. Sign in again.",
            reason: "session_ended",
          },
          { status: 401 },
        );
      }),
    );

    render(<App />);

    expect(await screen.findByRole("region", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your session has ended. Sign in again.");
  });

  it("does not request content or change URL when activating a folder and hides other nodes", async () => {
    signedInWithRoot();
    const contentCalls: string[] = [];
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({
            nodes: [node("folder-id", "Docs", "folder"), node("pdf-id", "z.pdf", "other")],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
      http.get("/api/files/:id/content", ({ params }) => {
        contentCalls.push(String(params.id));
        return contentResponse("nope");
      }),
    );

    render(<App />);

    const folder = await screen.findByRole("treeitem", { name: /Docs/ });
    expect(screen.queryByRole("treeitem", { name: /z\.pdf/ })).not.toBeInTheDocument();

    fireEvent.click(folder);
    fireEvent.keyDown(folder, { key: "Enter" });

    expect(contentCalls).toEqual([]);
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument();
  });

  it("shifts Markdown heading levels below the Preview h2 and clamps deep headings to h6", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    const markdown = [
      "# Level 1",
      "## Level 2",
      "### Level 3",
      "#### Level 4",
      "##### Level 5",
      "###### Level 6",
    ].join("\n\n");
    server.use(
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => contentResponse(markdown)),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Level 1" }),
    ).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { level: 4, name: "Level 2" })).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { level: 5, name: "Level 3" })).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { level: 6, name: "Level 4" })).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { level: 6, name: "Level 5" })).toBeInTheDocument();
    expect(within(preview).getByRole("heading", { level: 6, name: "Level 6" })).toBeInTheDocument();
    expect(within(preview).queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("renders formatted Markdown up to MAX_PREVIEW_BYTES (65,536 UTF-8 bytes)", async () => {
    expect(MAX_PREVIEW_BYTES).toBe(65_536);
    history.replaceState(null, "", "/?file=boundary-id");
    signedInWithRoot();
    const header = "# Boundary\n\n";
    const body = header + "a".repeat(65_536 - new TextEncoder().encode(header).byteLength);
    expect(new TextEncoder().encode(body).byteLength).toBe(65_536);

    server.use(
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => contentResponse(body)),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { level: 3, name: "Boundary" }),
    ).toBeInTheDocument();
    expect(within(preview).queryByText(/larger than 64 KB/i)).not.toBeInTheDocument();
  });

  it("falls back to plain text above MAX_PREVIEW_BYTES (65,537 UTF-8 bytes) without parsing Markdown", async () => {
    history.replaceState(null, "", "/?file=oversized-id");
    signedInWithRoot();
    const header = "# Too Big\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n";
    const body = header + "a".repeat(65_537 - new TextEncoder().encode(header).byteLength);
    expect(new TextEncoder().encode(body).byteLength).toBe(65_537);

    server.use(
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => contentResponse(body)),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    const notice = await within(preview).findByText(
      "This note is larger than 64 KB, so it is shown as plain text.",
    );
    expect(notice).toHaveAttribute("role", "status");
    const pre = preview.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(body);
    expect(within(preview).queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(within(preview).queryByRole("table")).not.toBeInTheDocument();
  });

  it("measures preview size in UTF-8 bytes rather than UTF-16 code units", async () => {
    history.replaceState(null, "", "/?file=multibyte-id");
    signedInWithRoot();
    const header = "# Multi\n\n";
    // Each "é" is 1 UTF-16 code unit but 2 UTF-8 bytes.
    const body = header + "é".repeat(32_765);
    expect(body.length).toBeLessThan(65_536);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);

    server.use(
      http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })),
      http.get("/api/files/:id/content", () => contentResponse(body)),
    );

    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    const notice = await within(preview).findByText(
      "This note is larger than 64 KB, so it is shown as plain text.",
    );
    expect(notice).toHaveAttribute("role", "status");
    expect(preview.querySelector("pre")?.textContent).toBe(body);
    expect(within(preview).queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("scrolls the document region into view only on narrow viewports without stealing focus from the file tree", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({
          nodes: [node("doc-1", "one.md", "markdown"), node("doc-2", "two.md", "markdown")],
        }),
      ),
      http.get("/api/files/:id/content", ({ params }) =>
        contentResponse(`# Note ${String(params.id)}`),
      ),
    );

    const originalScrollDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
    const scrolledTargets: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolledTargets.push(this);
    });
    let narrowViewport = false;
    const matchMedia = vi.fn((query: string) => ({
      matches: narrowViewport && query === "(max-width: 47.99rem)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: matchMedia,
    });

    try {
      render(<App />);

      const firstItem = await screen.findByRole("treeitem", { name: /one\.md/ });
      firstItem.focus();
      fireEvent.keyDown(firstItem, { key: "Enter" });

      const docRegion = await screen.findByRole("region", { name: "Preview" });
      await within(docRegion).findByRole("heading", { level: 2, name: "one.md" });
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(firstItem);

      narrowViewport = true;
      const secondItem = screen.getByRole("treeitem", { name: /two\.md/ });
      secondItem.focus();
      fireEvent.keyDown(secondItem, { key: "Enter" });

      await within(docRegion).findByRole("heading", { level: 2, name: "two.md" });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(scrolledTargets).toContain(docRegion);
      expect(document.activeElement).toBe(secondItem);
    } finally {
      if (originalScrollDescriptor) {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
      if (originalMatchMediaDescriptor) {
        Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
      } else {
        delete (window as { matchMedia?: unknown }).matchMedia;
      }
    }
  });

  it("shows an alert inside Preview without blanking the app if the Preview chunk fails to load", async () => {
    history.replaceState(null, "", "/?file=doc-id");
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({ nodes: [node("doc-id", "a.md", "markdown")] }),
      ),
      http.get("/api/files/:id/content", () => contentResponse("# Hello")),
    );

    vi.resetModules();
    vi.doMock("./components/Preview", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });

    try {
      const { App: FreshApp } = await import("./App");
      render(<FreshApp />);

      const preview = await screen.findByRole("region", { name: "Preview" });
      expect(await within(preview).findByRole("alert")).toHaveTextContent(
        "Unable to load the preview. Reload the page and try again.",
      );
      expect(screen.getByRole("region", { name: "Account" })).toBeInTheDocument();
      expect(await screen.findByRole("tree", { name: "Notes" })).toBeInTheDocument();
    } finally {
      vi.doUnmock("./components/Preview");
      vi.resetModules();
    }
  });
});
