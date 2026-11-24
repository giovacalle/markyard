import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { updateSettings } from "./settings";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

interface Patch {
  kind: "files" | "folders";
  id: string;
  parentId: string;
}

/** Notes/{Projects/{Sub/, b.md}, Archive/, a.md}; records every move PATCH. */
function vault(respond?: (patch: Patch) => Response | undefined): Patch[] {
  const patches: Patch[] = [];
  const handle =
    (kind: Patch["kind"]) =>
    async ({ params, request }: { params: Record<string, unknown>; request: Request }) => {
      const body = (await request.json()) as { parentId: string };
      const patch = { kind, id: String(params.id), parentId: body.parentId };
      patches.push(patch);
      const custom = respond?.(patch);
      if (custom !== undefined) {
        return custom;
      }
      const names: Record<string, string> = {
        "note-a": "a.md",
        "note-b": "b.md",
        projects: "Projects",
        sub: "Sub",
      };
      return HttpResponse.json(
        node(patch.id, names[patch.id] ?? patch.id, kind === "files" ? "markdown" : "folder"),
        { headers: kind === "files" ? { ETag: '"moved"' } : {} },
      );
    };
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({
        nodes: [
          node("projects", "Projects", "folder"),
          node("archive", "Archive", "folder"),
          node("note-a", "a.md", "markdown"),
        ],
      }),
    ),
    http.get("/api/folders/projects/children", () =>
      HttpResponse.json({
        nodes: [node("sub", "Sub", "folder"), node("note-b", "b.md", "markdown")],
      }),
    ),
    http.get("/api/folders/sub/children", () => HttpResponse.json({ nodes: [] })),
    http.get("/api/folders/archive/children", () => HttpResponse.json({ nodes: [] })),
    http.get("/api/vault/index", () =>
      HttpResponse.json({ code: "drive_error", message: "Unavailable" }, { status: 502 }),
    ),
    http.get("/api/changes/start-token", () => HttpResponse.json({ startPageToken: "t1" })),
    http.get("/api/changes", () =>
      HttpResponse.json({ nextPageToken: "t1", hasMore: false, changes: [] }),
    ),
    http.get(
      "/api/files/:id/content",
      () => new HttpResponse("# Hi", { headers: { ETag: '"r1"' } }),
    ),
    http.patch("/api/files/:id", handle("files")),
    http.patch("/api/folders/:id", handle("folders")),
  );
  return patches;
}

function row(name: string): HTMLElement {
  const label = screen.getByText(name).closest<HTMLElement>("[draggable]");
  if (label === null) {
    throw new Error(`No draggable row for ${name}`);
  }
  return label;
}

function dataTransfer() {
  return { setData: () => undefined, effectAllowed: "all", dropEffect: "none" };
}

async function openMovePicker(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole("button", { name: "Move to…" }));
  return screen.findByRole("dialog", { name: "Move to…" });
}

function optionPaths(dialog: HTMLElement): string[] {
  return within(dialog)
    .queryAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("moving notes and folders", () => {
  it("moves a note from its popover, leaving only valid destinations to pick", async () => {
    const patches = vault();
    render(<App />);
    // Archive's (empty) listing is loaded: the move must show up in it without a refetch.
    fireEvent.click(await screen.findByText("Archive"));
    await screen.findByText("This folder is empty.");

    const dialog = await openMovePicker("a.md");
    // Its current folder (the root) is not offered.
    expect(optionPaths(dialog)).toEqual(["Notes / Archive", "Notes / Projects"]);

    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "arch" } });
    expect(optionPaths(dialog)).toEqual(["Notes / Archive"]);
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patches).toEqual([{ kind: "files", id: "note-a", parentId: "archive" }]);
    expect(screen.queryByText("This folder is empty.")).not.toBeInTheDocument();
    const archiveGroup = row("Archive").closest<HTMLElement>('[role="treeitem"]');
    expect(within(archiveGroup!).getByText("a.md")).toBeInTheDocument();
    expect(screen.getAllByText("a.md")).toHaveLength(1);
  });

  it("never offers a folder itself, its subfolders, or its current parent", async () => {
    vault();
    render(<App />);
    fireEvent.click(await screen.findByText("Projects"));
    await screen.findByText("Sub");

    const dialog = await openMovePicker("Projects");
    expect(optionPaths(dialog)).toEqual(["Notes / Archive"]);

    fireEvent.click(within(dialog).getByRole("option", { name: "Notes / Archive" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("explains a name clash (409) and a refused move (400) inside the picker", async () => {
    let attempt = 0;
    vault(() => {
      attempt += 1;
      return attempt === 1
        ? HttpResponse.json(
            { code: "name_exists", message: "An item with this name already exists." },
            { status: 409 },
          )
        : HttpResponse.json(
            { code: "invalid_move", message: "A folder cannot move into itself." },
            { status: 400 },
          );
    });
    render(<App />);
    await screen.findByText("a.md");

    const dialog = await openMovePicker("a.md");
    fireEvent.click(within(dialog).getByRole("option", { name: "Notes / Archive" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "An item with this name already exists in that folder.",
    );

    fireEvent.click(within(dialog).getByRole("option", { name: "Notes / Projects" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "cannot be moved into itself or one of its subfolders",
    );
    // Nothing moved locally.
    expect(within(screen.getByRole("tree")).getByText("a.md")).toBeInTheDocument();
  });

  it("moves a note by dragging it onto a folder row", async () => {
    const patches = vault();
    render(<App />);
    await screen.findByText("a.md");

    const transfer = dataTransfer();
    fireEvent.dragStart(row("a.md"), { dataTransfer: transfer });
    const target = row("Archive");
    // dragOver is accepted (default prevented) only for a valid target.
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(false);
    expect(target).toHaveAttribute("data-drop-target", "true");
    fireEvent.drop(target, { dataTransfer: transfer });

    await vi.waitFor(() =>
      expect(patches).toEqual([{ kind: "files", id: "note-a", parentId: "archive" }]),
    );
    await vi.waitFor(() => expect(screen.queryByText("a.md")).not.toBeInTheDocument());
  });

  it("refuses drops onto the current folder and onto a folder's own subfolder", async () => {
    const patches = vault();
    render(<App />);
    fireEvent.click(await screen.findByText("Projects"));
    await screen.findByText("Sub");

    // b.md lives in Projects: dropping on Projects or on its sibling b.md row is a no-op.
    const transfer = dataTransfer();
    fireEvent.dragStart(row("b.md"), { dataTransfer: transfer });
    expect(fireEvent.dragOver(row("Projects"), { dataTransfer: transfer })).toBe(true);
    expect(row("Projects")).not.toHaveAttribute("data-drop-target");
    fireEvent.drop(row("Projects"), { dataTransfer: transfer });
    fireEvent.dragEnd(row("b.md"));

    // A folder cannot land inside itself.
    fireEvent.dragStart(row("Projects"), { dataTransfer: transfer });
    expect(fireEvent.dragOver(row("Sub"), { dataTransfer: transfer })).toBe(true);
    fireEvent.drop(row("Sub"), { dataTransfer: transfer });
    fireEvent.dragEnd(row("Projects"));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(patches).toEqual([]);
  });

  it("moves the open note from Cmd+K", async () => {
    const patches = vault();
    history.replaceState(null, "", "/?file=note-a");
    render(<App />);
    await screen.findByRole("region", { name: "Preview" });
    await screen.findAllByText("a.md");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const palette = await screen.findByRole("dialog");
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "move current" } });
    fireEvent.click(await within(palette).findByRole("option", { name: /Move current note to/ }));

    const dialog = await screen.findByRole("dialog", { name: "Move to…" });
    fireEvent.click(within(dialog).getByRole("option", { name: "Notes / Projects" }));
    await vi.waitFor(() =>
      expect(patches).toEqual([{ kind: "files", id: "note-a", parentId: "projects" }]),
    );
  });

  it("includes the root attachments folder by default and excludes it when hidden in Settings", async () => {
    vault();
    server.use(
      http.get("/api/vault/index", () =>
        HttpResponse.json({
          rootId: "root-id",
          folders: [
            { id: "projects", name: "Projects", parentId: "root-id", modifiedTime: MODIFIED },
            { id: "archive", name: "Archive", parentId: "root-id", modifiedTime: MODIFIED },
            { id: "att-root", name: "_attachments", parentId: "root-id", modifiedTime: MODIFIED },
            { id: "att-sub", name: "2026", parentId: "att-root", modifiedTime: MODIFIED },
            {
              id: "nested-att",
              name: "_attachments",
              parentId: "projects",
              modifiedTime: MODIFIED,
            },
          ],
          files: [{ id: "note-a", name: "a.md", parentId: "root-id", modifiedTime: MODIFIED }],
          truncated: false,
        }),
      ),
    );
    render(<App />);
    await screen.findByText("a.md");

    const dialog = await openMovePicker("a.md");
    await vi.waitFor(() =>
      expect(optionPaths(dialog)).toEqual([
        "Notes / _attachments",
        "Notes / _attachments / 2026",
        "Notes / Archive",
        "Notes / Projects",
        "Notes / Projects / _attachments",
      ]),
    );

    act(() => updateSettings({ showAttachmentsFolder: false }));
    await vi.waitFor(() =>
      expect(optionPaths(dialog)).toEqual([
        "Notes / Archive",
        "Notes / Projects",
        "Notes / Projects / _attachments",
      ]),
    );
  });
});
