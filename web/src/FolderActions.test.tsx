import { fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";

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

function signedInWithRoot(nodes = [node("dir-1", "Projects", "folder")]) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes })),
  );
}

describe("folder actions popover and dialogs", () => {
  it("creates a top-level folder from the sidebar header with inline validation and 409 handling", async () => {
    signedInWithRoot([node("dir-1", "Projects", "folder")]);
    const created: { parentId: string; name: string }[] = [];

    server.use(
      http.post("/api/folders/:parentId/folders", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        if (body.name === "Projects") {
          return HttpResponse.json(
            {
              code: "name_exists",
              message: "An item with this name already exists in this folder.",
            },
            { status: 409 },
          );
        }
        created.push({ parentId: String(params.parentId), name: body.name });
        return HttpResponse.json(node("dir-new", body.name, "folder"), { status: 201 });
      }),
    );

    render(<App />);
    await screen.findByText("Projects");

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Folder name");

    // Rejects invalid `/` locally without calling API.
    fireEvent.change(input, { target: { value: "bad/name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent('cannot contain "/"');
    expect(created).toHaveLength(0);

    // Surfaces 409 duplicate error from BFF.
    fireEvent.change(input, { target: { value: "Projects" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");

    // Creates new folder cleanly.
    fireEvent.change(input, { target: { value: "Journal" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Journal")).toBeInTheDocument();
    expect(created).toEqual([{ parentId: "root-id", name: "Journal" }]);
  });

  it("creates a subfolder from the folder popover and reveals it inside the parent", async () => {
    signedInWithRoot([node("dir-1", "Projects", "folder")]);
    server.use(
      http.get("/api/folders/dir-1/children", () => HttpResponse.json({ nodes: [] })),
      http.post("/api/folders/dir-1/folders", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json(node("sub-1", body.name, "folder"), { status: 201 });
      }),
    );

    render(<App />);
    await screen.findByText("Projects");

    fireEvent.click(screen.getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New subfolder" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Projects");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), {
      target: { value: "2026" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await screen.findByText("2026")).toBeInTheDocument();
  });

  it("renames a folder from the folder popover", async () => {
    signedInWithRoot([node("dir-1", "Projects", "folder")]);
    const patches: { id: string; name: string }[] = [];

    server.use(
      http.patch("/api/folders/:id", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        patches.push({ id: String(params.id), name: body.name });
        return HttpResponse.json(node(String(params.id), body.name, "folder"));
      }),
    );

    render(<App />);
    await screen.findByText("Projects");

    fireEvent.click(screen.getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Folder name");
    expect(input).toHaveValue("Projects");

    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(patches).toEqual([{ id: "dir-1", name: "Work" }]);
  });

  it("requires confirmation before deleting a folder and closes an open note inside it", async () => {
    signedInWithRoot([node("dir-1", "Projects", "folder")]);
    const deletedIds: string[] = [];

    server.use(
      http.get("/api/folders/dir-1/children", () =>
        HttpResponse.json({ nodes: [node("note-1", "spec.md", "markdown")] }),
      ),
      http.get(
        "/api/files/note-1/content",
        () =>
          new HttpResponse("# Spec\n", {
            status: 200,
            headers: { ETag: '"etag-1"', "Content-Type": "application/octet-stream" },
          }),
      ),
      http.delete("/api/folders/:id", ({ params }) => {
        deletedIds.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    render(<App />);
    // Expand Projects and open spec.md inside it.
    fireEvent.click(await screen.findByText("Projects"));
    fireEvent.click(await screen.findByText("spec.md"));
    expect(await screen.findByRole("heading", { name: "Spec" })).toBeInTheDocument();

    // Open folder popover -> Delete -> Cancel keeps everything intact.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("All notes and subfolders inside Projects");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deletedIds).toHaveLength(0);
    expect(screen.getByRole("treeitem", { name: /Projects/ })).toBeInTheDocument();

    // Open folder popover -> Delete -> Confirm trashes folder & closes active note.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete folder" }));

    expect(await screen.findByText("No note selected")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(deletedIds).toEqual(["dir-1"]);
  });

  it("opens folder actions as a keyboard-navigable menu", async () => {
    signedInWithRoot([node("dir-1", "Projects", "folder")]);

    render(<App />);
    await screen.findByText("Projects");

    const trigger = screen.getByRole("button", { name: "Actions for Projects" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "New note",
      "New subfolder",
      "Rename",
      "Move to…",
      "Copy path",
      "Delete",
    ]);
    for (const item of items) {
      expect(item).toHaveAttribute("data-slot", "menu-item");
    }
    expect(within(menu).getByRole("separator")).toBeInTheDocument();

    await vi.waitFor(() => expect(items[0]).toHaveAttribute("data-highlighted"));
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    await vi.waitFor(() => expect(items[1]).toHaveAttribute("data-highlighted"));
    expect(items[0]).not.toHaveAttribute("data-highlighted");

    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("opens the actions popover on right-click for both folders and files", async () => {
    signedInWithRoot([
      node("dir-1", "Projects", "folder"),
      node("file-1", "readme.md", "markdown"),
    ]);

    render(<App />);
    const folderLabel = await screen.findByText("Projects");
    const fileLabel = await screen.findByText("readme.md");

    // Right-click on folder opens the folder actions popover (including New note, New subfolder, Rename, Delete).
    fireEvent.contextMenu(folderLabel);
    expect(await screen.findByRole("menuitem", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "New subfolder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();

    // Right-click on file switches the popover to the file actions popover.
    fireEvent.contextMenu(fileLabel);
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "New subfolder" })).not.toBeInTheDocument();
  });

  it.each([
    { name: "Projects", first: "New note", second: "New subfolder" },
    { name: "readme.md", first: "Move to…", second: "Copy path" },
  ])(
    "moves focus into the $name right-click menu and returns it to the row on Escape",
    async ({ name, first, second }) => {
      signedInWithRoot([
        node("dir-1", "Projects", "folder"),
        node("file-1", "readme.md", "markdown"),
      ]);

      render(<App />);
      const label = await screen.findByText(name);
      const row = screen.getByRole("treeitem", { name: new RegExp(name) });

      fireEvent.contextMenu(label);
      const menu = await screen.findByRole("menu");
      const firstItem = within(menu).getByRole("menuitem", { name: first });
      await vi.waitFor(() => expect(document.activeElement).toBe(firstItem));
      expect(firstItem).toHaveAttribute("data-highlighted");

      fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
      const secondItem = within(menu).getByRole("menuitem", { name: second });
      await vi.waitFor(() => expect(secondItem).toHaveAttribute("data-highlighted"));
      expect(document.activeElement).toBe(secondItem);

      fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
      await vi.waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(document.activeElement).toBe(row);
    },
  );

  it("opens the row menu from the keyboard (Shift+F10 or the context-menu key)", async () => {
    signedInWithRoot([node("file-1", "readme.md", "markdown")]);

    render(<App />);
    await screen.findByText("readme.md");
    const row = screen.getByRole("treeitem", { name: /readme\.md/ });
    row.focus();

    // Browsers turn Shift+F10 and the context-menu key into a `contextmenu`
    // event on the focused element.
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu");
    const firstItem = within(menu).getByRole("menuitem", { name: "Move to…" });
    await vi.waitFor(() => expect(document.activeElement).toBe(firstItem));

    fireEvent.keyDown(firstItem, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(row);
  });
});
