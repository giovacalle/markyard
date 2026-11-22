import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { App } from "./App";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  focusManager.setFocused(undefined);
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-01T10:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function refocus() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

function signedInWithRoot(name = "Notes") {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", name, "folder"))),
  );
}

function rateLimited(retryAfter: string) {
  return HttpResponse.json(
    { code: "rate_limited", message: "Busy." },
    { status: 429, headers: { "Retry-After": retryAfter } },
  );
}

function rowNames(label: string): string[] {
  return within(screen.getByRole("tree", { name: label }))
    .getAllByRole("treeitem")
    .map((item) => item.textContent ?? "");
}

describe("file tree of the root folder", () => {
  it("lists folders first, then Markdown files, hiding non-Markdown files and passing the id unchanged", async () => {
    signedInWithRoot();
    const received: string[] = [];
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        received.push(String(params.id));
        return HttpResponse.json({
          nodes: [
            node("1", "b.md", "markdown"),
            node("2", "Zeta", "folder"),
            node("3", "A.md", "markdown"),
            node("4", "alpha", "folder"),
            node("5", "z.pdf", "other"),
          ],
        });
      }),
    );
    render(<App />);

    await screen.findByRole("tree", { name: "Notes" });
    const names = rowNames("Notes");
    expect(names).toHaveLength(4);
    expect(names[0]).toContain("alpha");
    expect(names[1]).toContain("Zeta");
    expect(names[2]).toContain("A.md");
    expect(names[3]).toContain("b.md");
    expect(screen.queryByText("z.pdf")).not.toBeInTheDocument();
    expect(received).toEqual(["root-id"]);
  });

  it("shows a loading status while the folder loads", async () => {
    signedInWithRoot();
    server.use(http.get("/api/folders/:id/children", () => new Promise<never>(() => {})));
    render(<App />);

    expect(await screen.findByText("Loading folder…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an error with a retry that recovers", async () => {
    signedInWithRoot();
    let calls = 0;
    server.use(
      http.get("/api/folders/:id/children", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: "upstream_error", message: "Down." }, { status: 502 })
          : HttpResponse.json({ nodes: [node("1", "a.md", "markdown")] });
      }),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this folder.");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);

    const tree = await screen.findByRole("tree", { name: "Notes" });
    expect(rowNames("Notes")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Focus does not fall to <body> when Retry unmounts (WCAG 2.4.3).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toContainElement(tree);
  });

  it("shows a distinct empty state for a folder without children", async () => {
    signedInWithRoot();
    server.use(http.get("/api/folders/:id/children", () => HttpResponse.json({ nodes: [] })));
    render(<App />);

    expect(await screen.findByText("This folder is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "Notes" })).not.toBeInTheDocument();
  });

  it("retries a rate_limited answer after the delay the BFF gives, without an error flash", async () => {
    signedInWithRoot();
    const calledAt: number[] = [];
    server.use(
      http.get("/api/folders/:id/children", () => {
        calledAt.push(Date.now());
        return calledAt.length === 1
          ? rateLimited("1")
          : HttpResponse.json({ nodes: [node("1", "a.md", "markdown")] });
      }),
    );
    render(<App />);

    await screen.findByText("Loading folder…");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(calledAt).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Loading folder…")).toBeInTheDocument();

    await screen.findByRole("tree", { name: "Notes" }, { timeout: 3000 });
    expect(calledAt).toHaveLength(2);
    expect(calledAt[1] - calledAt[0]).toBeGreaterThanOrEqual(900);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives up on a rate_limited folder after three retries and offers a retry", async () => {
    signedInWithRoot();
    let calls = 0;
    server.use(
      http.get("/api/folders/:id/children", () => {
        calls += 1;
        return rateLimited("0");
      }),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this folder.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(calls).toBe(4);
  });

  it("refetches the list when the window regains focus", async () => {
    signedInWithRoot();
    let extra = false;
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({
          nodes: [node("1", "a.md", "markdown"), ...(extra ? [node("2", "b.md", "markdown")] : [])],
        }),
      ),
    );
    render(<App />);
    await screen.findByRole("tree", { name: "Notes" });
    expect(rowNames("Notes")).toHaveLength(1);

    extra = true;
    refocus();

    await screen.findByText("b.md");
    expect(rowNames("Notes")).toHaveLength(2);
  });

  it("a 401 from the folder returns to the sign-in screen with the ended message", async () => {
    let active = true;
    server.use(
      http.get("/api/session", () =>
        active
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
      http.get("/api/folders/:id/children", () => {
        active = false;
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

    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your session has ended. Sign in again.");
  });

  it("shows an error with a retry when the root folder cannot be loaded", async () => {
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () =>
        HttpResponse.json({ code: "not_found", message: "Not found" }, { status: 404 }),
      ),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load the root folder.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a root folder retry that recovers keeps focus on the folder, not on <body>", async () => {
    let calls = 0;
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: "upstream_error", message: "Down." }, { status: 502 })
          : HttpResponse.json(node("root-id", "Notes", "folder"));
      }),
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({ nodes: [node("1", "a.md", "markdown")] }),
      ),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load the root folder.");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);

    const tree = await screen.findByRole("tree", { name: "Notes" });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toContainElement(tree);
  });
});

describe("lazy tree expansion", () => {
  it("expanding a folder requests its children only then and shows them sorted", async () => {
    signedInWithRoot();
    const received: string[] = [];
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        const id = String(params.id);
        received.push(id);
        if (id === "root-id") {
          return HttpResponse.json({
            nodes: [node("alpha-id", "alpha", "folder"), node("z-id", "z.md", "markdown")],
          });
        }
        if (id === "alpha-id") {
          return HttpResponse.json({
            nodes: [
              node("b-id", "b.md", "markdown"),
              node("zeta-id", "Zeta", "folder"),
              node("a-id", "A.md", "markdown"),
              node("alpha2-id", "alpha2", "folder"),
            ],
          });
        }
        if (id === "alpha2-id") {
          return HttpResponse.json({
            nodes: [node("inner-id", "inner.md", "markdown")],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
    );
    render(<App />);

    await screen.findByRole("tree", { name: "Notes" });
    expect(received).toEqual(["root-id"]);
    expect(screen.queryByRole("treeitem", { name: /inner\.md/ })).not.toBeInTheDocument();

    const alpha = screen.getByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);

    await within(alpha).findByRole("treeitem", { name: /b\.md/ });
    expect(received).toEqual(["root-id", "alpha-id"]);
    const alphaChildren = within(alpha)
      .getAllByRole("treeitem")
      .map((item) => item.textContent ?? "");
    expect(alphaChildren).toHaveLength(4);
    expect(alphaChildren[0]).toContain("alpha2");
    expect(alphaChildren[1]).toContain("Zeta");
    expect(alphaChildren[2]).toContain("A.md");
    expect(alphaChildren[3]).toContain("b.md");

    const alpha2 = within(alpha).getByRole("treeitem", { name: /alpha2/ });
    fireEvent.click(alpha2);

    expect(await within(alpha2).findByRole("treeitem", { name: /inner\.md/ })).toBeInTheDocument();
    expect(received).toEqual(["root-id", "alpha-id", "alpha2-id"]);
  });

  it("collapsing and expanding again keeps the children", async () => {
    signedInWithRoot();
    let alphaRequests = 0;
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({ nodes: [node("alpha-id", "alpha", "folder")] });
        }
        if (params.id === "alpha-id") {
          alphaRequests += 1;
          return HttpResponse.json({ nodes: [node("inner-id", "inner.md", "markdown")] });
        }
        return HttpResponse.json({ nodes: [] });
      }),
    );
    render(<App />);

    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);
    await within(alpha).findByRole("treeitem", { name: /inner\.md/ });
    expect(alphaRequests).toBe(1);

    fireEvent.click(alpha);
    await waitFor(() => {
      expect(screen.queryByRole("treeitem", { name: /inner\.md/ })).not.toBeInTheDocument();
    });

    fireEvent.click(alpha);
    expect(await within(alpha).findByRole("treeitem", { name: /inner\.md/ })).toBeInTheDocument();
    expect(alphaRequests).toBe(1);
  });

  it("window focus refetches every loaded folder", async () => {
    signedInWithRoot();
    let rootRequests = 0;
    let alphaRequests = 0;
    let extra = false;
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          rootRequests += 1;
          return HttpResponse.json({
            nodes: [
              node("alpha-id", "alpha", "folder"),
              ...(extra ? [node("new-root-id", "new-root.md", "markdown")] : []),
            ],
          });
        }
        if (params.id === "alpha-id") {
          alphaRequests += 1;
          return HttpResponse.json({
            nodes: [
              node("inner-id", "inner.md", "markdown"),
              ...(extra ? [node("new-inner-id", "new-inner.md", "markdown")] : []),
            ],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
    );
    render(<App />);

    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);
    await within(alpha).findByRole("treeitem", { name: /inner\.md/ });
    expect(rootRequests).toBe(1);
    expect(alphaRequests).toBe(1);

    fireEvent.click(alpha);
    await waitFor(() => {
      expect(screen.queryByRole("treeitem", { name: /inner\.md/ })).not.toBeInTheDocument();
    });

    extra = true;
    refocus();

    await waitFor(() => {
      expect(rootRequests).toBe(2);
      expect(alphaRequests).toBe(2);
    });
    expect(await screen.findByRole("treeitem", { name: /new-root\.md/ })).toBeInTheDocument();

    fireEvent.click(alpha);
    expect(
      await within(alpha).findByRole("treeitem", { name: /new-inner\.md/ }),
    ).toBeInTheDocument();
    expect(alphaRequests).toBe(2);
  });

  it("shows a loading status inside an expanding folder while its children load", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({
            nodes: [node("alpha-id", "alpha", "folder"), node("z-id", "z.md", "markdown")],
          });
        }
        return new Promise<never>(() => {});
      }),
    );
    render(<App />);

    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);

    expect(await within(alpha).findByRole("status")).toHaveTextContent("Loading folder…");
    expect(screen.getByRole("treeitem", { name: /z\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an error and Retry inside a failed folder that recovers without collapsing or losing focus", async () => {
    signedInWithRoot();
    let alphaCalls = 0;
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({
            nodes: [node("alpha-id", "alpha", "folder"), node("z-id", "z.md", "markdown")],
          });
        }
        alphaCalls += 1;
        return alphaCalls === 1
          ? HttpResponse.json({ code: "upstream_error", message: "Down." }, { status: 502 })
          : HttpResponse.json({ nodes: [node("inner-id", "inner.md", "markdown")] });
      }),
    );
    render(<App />);

    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);

    expect(await within(alpha).findByRole("alert")).toHaveTextContent(
      "Unable to load this folder.",
    );
    expect(screen.getByRole("treeitem", { name: /z\.md/ })).toBeInTheDocument();

    const retry = within(alpha).getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.keyDown(retry, { key: "Enter" });
    expect(alpha).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(retry);

    fireEvent.keyDown(retry, { key: " " });
    expect(alpha).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(retry);

    fireEvent.keyDown(retry, { key: "ArrowDown" });
    expect(alpha).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);

    expect(await within(alpha).findByRole("treeitem", { name: /inner\.md/ })).toBeInTheDocument();
    expect(within(alpha).queryByRole("alert")).not.toBeInTheDocument();
    expect(alpha).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(alpha);
  });

  it("shows an empty state inside an empty folder", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({
            nodes: [node("alpha-id", "alpha", "folder"), node("z-id", "z.md", "markdown")],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
    );
    render(<App />);

    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);

    expect(await within(alpha).findByText("This folder is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /z\.md/ })).toBeInTheDocument();
  });

  it("a 401 from an expanded folder returns to the sign-in screen with the ended message", async () => {
    let active = true;
    server.use(
      http.get("/api/session", () =>
        active
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
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({ nodes: [node("alpha-id", "alpha", "folder")] });
        }
        active = false;
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

    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);

    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your session has ended. Sign in again.");
  });

  it("hides nodes of kind other and treats a folder with only other files as empty", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({
            nodes: [
              node("only-other", "Photos", "folder"),
              node("doc-id", "a.md", "markdown"),
              node("pdf-id", "z.pdf", "other"),
            ],
          });
        }
        return HttpResponse.json({
          nodes: [node("img-id", "photo.jpg", "other")],
        });
      }),
    );
    render(<App />);

    expect(await screen.findByRole("treeitem", { name: /a\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /z\.pdf/ })).not.toBeInTheDocument();

    const photos = screen.getByRole("treeitem", { name: /Photos/ });
    fireEvent.click(photos);
    expect(await within(photos).findByText("This folder is empty.")).toBeInTheDocument();
    expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
  });

  it("flags visible siblings sharing a name as duplicates", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({
          nodes: [
            node("dup-folder", "notes.md", "folder"),
            node("dup-md", "notes.md", "markdown"),
            node("dup-other", "notes.md", "other"),
            node("unique-id", "unique.md", "markdown"),
          ],
        }),
      ),
    );
    render(<App />);

    await screen.findByRole("tree", { name: "Notes" });
    const duplicates = screen.getAllByRole("treeitem", { name: /notes\.md/ });
    expect(duplicates).toHaveLength(2);
    for (const row of duplicates) {
      expect(within(row).getByText("Duplicate name")).toBeInTheDocument();
    }

    const unique = screen.getByRole("treeitem", { name: /unique\.md/ });
    expect(within(unique).queryByText("Duplicate name")).not.toBeInTheDocument();
  });

  it("supports keyboard navigation, expansion, collapse, and activation", async () => {
    signedInWithRoot();
    const received: string[] = [];
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        const id = String(params.id);
        received.push(id);
        if (id === "root-id") {
          return HttpResponse.json({
            nodes: [node("alpha-id", "alpha", "folder"), node("z-id", "z.md", "markdown")],
          });
        }
        if (id === "alpha-id") {
          return HttpResponse.json({
            nodes: [node("inner-id", "inner.md", "markdown")],
          });
        }
        return HttpResponse.json({ nodes: [] });
      }),
    );
    render(<App />);

    await screen.findByRole("tree", { name: "Notes" });
    const alpha = screen.getByRole("treeitem", { name: /alpha/ });
    const zFile = screen.getByRole("treeitem", { name: /z\.md/ });

    alpha.focus();
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(document.activeElement).toBe(zFile);

    fireEvent.keyDown(zFile, { key: "ArrowUp" });
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    const inner = await within(alpha).findByRole("treeitem", { name: /inner\.md/ });
    expect(received).toEqual(["root-id", "alpha-id"]);
    expect(alpha).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement).toBe(inner);

    fireEvent.keyDown(inner, { key: "Enter" });
    expect(inner).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(inner, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: "ArrowLeft" });
    expect(alpha).toHaveAttribute("aria-expanded", "false");
  });

  it("drops the browser default outline on treeitem rows so only the label focus ring shows", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", () =>
        HttpResponse.json({
          nodes: [node("alpha-id", "alpha", "folder"), node("z-id", "z.md", "markdown")],
        }),
      ),
    );
    render(<App />);

    await screen.findByRole("tree", { name: "Notes" });
    for (const item of screen.getAllByRole("treeitem")) {
      expect(item).toHaveClass("outline-none");
    }
  });

  it("remembers expanded folders (including nested ones) across reloads", async () => {
    signedInWithRoot();
    server.use(
      http.get("/api/folders/:id/children", ({ params }) => {
        if (params.id === "root-id") {
          return HttpResponse.json({ nodes: [node("alpha-id", "alpha", "folder")] });
        }
        if (params.id === "alpha-id") {
          return HttpResponse.json({ nodes: [node("nested-id", "nested", "folder")] });
        }
        if (params.id === "nested-id") {
          return HttpResponse.json({ nodes: [node("leaf-id", "leaf.md", "markdown")] });
        }
        return HttpResponse.json({ nodes: [] });
      }),
    );

    const first = render(<App />);
    const alpha = await screen.findByRole("treeitem", { name: /alpha/ });
    fireEvent.click(alpha);
    const nested = await within(alpha).findByRole("treeitem", { name: /nested/ });
    fireEvent.click(nested);
    expect(await within(nested).findByRole("treeitem", { name: /leaf\.md/ })).toBeInTheDocument();
    first.unmount();

    // Reopening the app restores both expanded folders automatically.
    const second = render(<App />);
    expect(await screen.findByRole("treeitem", { name: /leaf\.md/ })).toBeInTheDocument();

    // Collapsing alpha persists that it is closed on the next reload.
    fireEvent.click(screen.getByRole("treeitem", { name: /alpha/ }));
    await waitFor(() => {
      expect(screen.queryByRole("treeitem", { name: /leaf\.md/ })).not.toBeInTheDocument();
    });
    second.unmount();

    render(<App />);
    await screen.findByRole("treeitem", { name: /alpha/ });
    expect(screen.queryByRole("treeitem", { name: /nested/ })).not.toBeInTheDocument();
  });
});
