import { fireEvent, render, screen, within } from "@testing-library/react";
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
    fireEvent.click(await screen.findByRole("button", { name: "New subfolder" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("All notes and subfolders inside Projects");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deletedIds).toHaveLength(0);
    expect(screen.getByText("Projects")).toBeInTheDocument();

    // Open folder popover -> Delete -> Confirm trashes folder & closes active note.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete folder" }));

    expect(await screen.findByText("No note selected")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(deletedIds).toEqual(["dir-1"]);
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
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New subfolder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();

    // Right-click on file switches the popover to the file actions popover.
    fireEvent.contextMenu(fileLabel);
    expect(await screen.findByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New subfolder" })).not.toBeInTheDocument();
  });
});
