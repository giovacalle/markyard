import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import type { DriveNode } from "./api";
import { ancestorIdsFromPath } from "./treeCache";

const server = setupServer();
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const scrolled: Element[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      scrolled.push(this);
    },
  });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  scrolled.length = 0;
});

afterAll(() => {
  server.close();
  if (originalScroll) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  } else {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: DriveNode["kind"]): DriveNode {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function pressCmdK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

/** The palette row for deep.md in Projects / drive-notes (not "Create deep.md"). */
async function findNoteOption(dialog: HTMLElement): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const option = within(dialog)
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Projects / drive-notes"));
    if (option === undefined) throw new Error("note option not shown yet");
    return option;
  });
}

function nestedDrive(search: { node: DriveNode; path: string[] }[] = []) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({
        nodes: [node("projects", "Projects", "folder"), node("top", "top.md", "markdown")],
      }),
    ),
    http.get("/api/folders/projects/children", () =>
      HttpResponse.json({ nodes: [node("drive-notes", "drive-notes", "folder")] }),
    ),
    http.get("/api/folders/drive-notes/children", () =>
      HttpResponse.json({ nodes: [node("deep", "deep.md", "markdown")] }),
    ),
    http.get("/api/search", () => HttpResponse.json({ results: search })),
    http.get(
      "/api/files/:id/content",
      ({ params }) =>
        new HttpResponse(`# Note ${String(params.id)}`, {
          headers: { "Content-Type": "application/octet-stream", ETag: '"e1"' },
        }),
    ),
  );
}

describe("reveal the open note in the file tree", () => {
  it("expands unloaded folders along a Drive search hit's path, selects the note and scrolls to it", async () => {
    nestedDrive([{ node: node("deep", "deep.md", "markdown"), path: ["Projects", "drive-notes"] }]);
    render(<App />);
    const projects = await screen.findByRole("treeitem", { name: /Projects/ });
    expect(projects).toHaveAttribute("aria-expanded", "false");

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "deep" } });
    fireEvent.click(await findNoteOption(dialog));

    const deep = await screen.findByRole("treeitem", { name: /deep\.md/ });
    expect(projects).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /drive-notes/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(deep).toHaveAttribute("aria-selected", "true");
    await vi.waitFor(() => expect(scrolled).toContain(deep));
  });

  it("re-expands a collapsed folder from the loaded tree when the note is opened from Cmd+K", async () => {
    nestedDrive();
    render(<App />);
    const projects = await screen.findByRole("treeitem", { name: /Projects/ });
    fireEvent.click(within(projects).getByText("Projects"));
    const driveNotes = await screen.findByRole("treeitem", { name: /drive-notes/ });
    fireEvent.click(within(driveNotes).getByText("drive-notes"));
    await screen.findByRole("treeitem", { name: /deep\.md/ });
    // Collapse both again: the listings stay cached.
    fireEvent.click(within(driveNotes).getByText("drive-notes"));
    fireEvent.click(within(projects).getByText("Projects"));
    expect(projects).toHaveAttribute("aria-expanded", "false");

    pressCmdK();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "deep" } });
    fireEvent.click(await findNoteOption(dialog));

    await vi.waitFor(() => expect(projects).toHaveAttribute("aria-expanded", "true"));
    expect(driveNotes).toHaveAttribute("aria-expanded", "true");
    const deep = screen.getByRole("treeitem", { name: /deep\.md/ });
    expect(deep).toHaveAttribute("aria-selected", "true");
    await vi.waitFor(() => expect(scrolled).toContain(deep));
  });

  it("does not scroll the tree when the note is picked in the tree itself", async () => {
    nestedDrive();
    render(<App />);
    const top = await screen.findByRole("treeitem", { name: /top\.md/ });
    fireEvent.click(within(top).getByText("top.md"));
    await screen.findByRole("region", { name: "Preview" });
    expect(top).toHaveAttribute("aria-selected", "true");
    expect(scrolled).not.toContain(top);
  });
});

describe("ancestorIdsFromPath", () => {
  it("follows the same-named folder that actually holds the note", async () => {
    const listings: Record<string, DriveNode[]> = {
      root: [node("a1", "A", "folder"), node("a2", "A", "folder")],
      a1: [node("x", "x.md", "markdown")],
      a2: [node("target", "t.md", "markdown")],
    };
    const load = async (id: string) => listings[id] ?? [];
    expect(await ancestorIdsFromPath("root", ["A"], "target", load)).toEqual(["a2"]);
    expect(await ancestorIdsFromPath("root", [], "target", load)).toBeNull();
    expect(await ancestorIdsFromPath("root", ["B"], "target", load)).toBeNull();
  });
});
