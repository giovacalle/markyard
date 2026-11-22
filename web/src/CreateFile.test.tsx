import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  history.replaceState(null, "", "/");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown" | "other") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function signedInWithRoot(nodes = [node("a-id", "alpha.md", "markdown")]) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes })),
  );
}

function getEditorTextbox(region: HTMLElement): HTMLElement {
  const host = region.querySelector('[data-testid="editor-host"]');
  const shadow = host?.shadowRoot;
  const textbox = shadow?.querySelector<HTMLElement>('[role="textbox"][aria-label="Note text"]');
  if (!textbox) {
    throw new Error("CodeMirror textbox not found inside shadow root");
  }
  return textbox;
}

async function getEditorView(region: HTMLElement): Promise<EditorView> {
  await vi.waitFor(() => getEditorTextbox(region));
  const view = EditorView.findFromDOM(getEditorTextbox(region));
  if (!view) {
    throw new Error("CodeMirror EditorView not found on textbox");
  }
  return view;
}

function pressSave() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

describe("dashboard shell, instant create, inline rename, and delete", () => {
  it("shows empty workspace state with a Create a note CTA when no file is open", async () => {
    signedInWithRoot();
    render(<App />);

    expect(await screen.findByText("No note selected")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Create a note" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Account" })).toHaveTextContent("owner@example.com");
  });

  it("creates an Untitled.md file immediately without a name dialog, opens in Editor, and saves with its ETag", async () => {
    signedInWithRoot([node("z-id", "zeta.md", "markdown")]);
    const posts: { folderId: string; body: unknown }[] = [];
    const gets: string[] = [];
    const puts: { fileId: string; ifMatch: string | null; text: string }[] = [];

    server.use(
      http.post("/api/folders/:id/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string; content: string };
        posts.push({ folderId: String(params.id), body });
        return HttpResponse.json(node("new-1", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-created-1"' },
        });
      }),
      http.get("/api/files/:id/content", ({ params }) => {
        gets.push(String(params.id));
        return new HttpResponse("", { status: 200, headers: { ETag: '"unexpected"' } });
      }),
      http.put("/api/files/:id/content", async ({ params, request }) => {
        puts.push({
          fileId: String(params.id),
          ifMatch: request.headers.get("If-Match"),
          text: await request.text(),
        });
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-saved-2"' } });
      }),
    );

    render(<App />);
    await screen.findByRole("tree", { name: "Notes" });

    fireEvent.click(screen.getByRole("button", { name: "Create a note" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Opens immediately in Editor with Untitled.md, empty and clean.
    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(
      within(editor).getByRole("heading", { level: 2, name: "Untitled.md" }),
    ).toBeInTheDocument();
    expect(window.location.search).toBe("?file=new-1");
    expect(posts).toEqual([{ folderId: "root-id", body: { name: "Untitled.md", content: "" } }]);
    expect(gets).toEqual([]);

    // Appears in the tree sorted before zeta.md.
    const items = within(screen.getByRole("tree", { name: "Notes" }))
      .getAllByRole("treeitem")
      .map((el) => el.textContent ?? "");
    expect(items[0]).toContain("Untitled.md");
    expect(items[1]).toContain("zeta.md");

    // Can be edited and saved immediately via Cmd+S using the ETag returned by POST.
    const view = await getEditorView(editor);
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "# Fresh ideas" } });
    });
    pressSave();

    await vi.waitFor(() => {
      expect(within(editor).getByRole("status")).toHaveTextContent("Saved");
    });
    expect(puts).toEqual([{ fileId: "new-1", ifMatch: '"etag-created-1"', text: "# Fresh ideas" }]);
  });

  it("picks the next free Untitled number and retries on 409 name_exists", async () => {
    signedInWithRoot([node("u-1", "Untitled.md", "markdown")]);
    const triedNames: string[] = [];

    server.use(
      http.post("/api/folders/:id/files", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        triedNames.push(body.name);
        if (body.name === "Untitled 2.md") {
          return HttpResponse.json(
            { code: "name_exists", message: "Already exists" },
            { status: 409 },
          );
        }
        return HttpResponse.json(node("new-3", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-3"' },
        });
      }),
    );

    render(<App />);
    await screen.findByRole("treeitem", { name: /Untitled\.md/ });

    fireEvent.click(screen.getByRole("button", { name: "Create a note" }));
    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(
      within(editor).getByRole("heading", { level: 2, name: "Untitled 3.md" }),
    ).toBeInTheDocument();
    expect(triedNames).toEqual(["Untitled 2.md", "Untitled 3.md"]);
  });

  it("creates a file immediately inside a subfolder via the folder popover", async () => {
    signedInWithRoot([node("sub-1", "Projects", "folder")]);
    const posts: { folderId: string; name: string }[] = [];

    server.use(
      http.get("/api/folders/sub-1/children", () =>
        HttpResponse.json({ nodes: [node("existing", "plan.md", "markdown")] }),
      ),
      http.post("/api/folders/:id/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        posts.push({ folderId: String(params.id), name: body.name });
        return HttpResponse.json(node("sub-note-1", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-sub"' },
        });
      }),
    );

    render(<App />);
    const folder = await screen.findByRole("treeitem", { name: /Projects/ });
    fireEvent.click(folder);
    await within(folder).findByRole("treeitem", { name: /plan\.md/ });

    fireEvent.click(within(folder).getByRole("button", { name: "Actions for Projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "New note" }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(
      within(editor).getByRole("heading", { level: 2, name: "Untitled.md" }),
    ).toBeInTheDocument();
    expect(posts).toEqual([{ folderId: "sub-1", name: "Untitled.md" }]);
    expect(
      await within(folder).findByRole("treeitem", { name: /Untitled\.md/ }),
    ).toBeInTheDocument();
  });

  it("refreshes the ETag after renaming a newly created note so the next save does not 412", async () => {
    signedInWithRoot([node("z-id", "zeta.md", "markdown")]);
    const putTags: (string | null)[] = [];

    server.use(
      http.post("/api/folders/:id/files", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json(node("new-id", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-create"' },
        });
      }),
      http.patch("/api/files/new-id", async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json(node("new-id", body.name, "markdown"), {
          status: 200,
          headers: { ETag: '"etag-after-rename"' },
        });
      }),
      http.put("/api/files/new-id/content", ({ request }) => {
        const tag = request.headers.get("If-Match");
        putTags.push(tag);
        if (tag !== '"etag-after-rename"') {
          return HttpResponse.json(
            { code: "conflict", message: "The note changed on Drive since it was opened." },
            { status: 412 },
          );
        }
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-saved"' } });
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a note" }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    // Immediately rename Untitled.md -> fresh-note.md (which bumps Drive's ETag).
    fireEvent.click(within(editor).getByRole("button", { name: "Untitled.md" }));
    const input = within(editor).getByLabelText("File name");
    fireEvent.change(input, { target: { value: "fresh-note" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByRole("heading", { level: 2, name: "fresh-note.md" }),
    ).toBeInTheDocument();

    // Click into the canvas to enter edit mode, type, and save.
    fireEvent.click(screen.getByTestId("editor-canvas"));
    const activeEditor = await screen.findByRole("region", { name: "Editor" });
    const view = await getEditorView(activeEditor);
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "Hello after rename" } });
    });

    pressSave();
    expect(await within(activeEditor).findByText("Saved")).toBeInTheDocument();
    expect(putTags).toEqual(['"etag-after-rename"']);
  });

  it("renames a file inline by clicking the filename in the header and validates errors", async () => {
    history.replaceState(null, "", "/?file=a-id");
    signedInWithRoot([node("a-id", "alpha.md", "markdown"), node("b-id", "taken.md", "markdown")]);
    const patches: { id: string; name: string }[] = [];

    server.use(
      http.get(
        "/api/files/a-id/content",
        () =>
          new HttpResponse("# Hello", {
            status: 200,
            headers: { "Content-Type": "application/octet-stream", ETag: '"etag-1"' },
          }),
      ),
      http.patch("/api/files/:id", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        patches.push({ id: String(params.id), name: body.name });
        if (body.name === "taken.md") {
          return HttpResponse.json(
            { code: "name_exists", message: "Already exists" },
            { status: 409 },
          );
        }
        return HttpResponse.json(node(String(params.id), body.name, "markdown"));
      }),
    );

    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    // Click the filename in the header to edit inline.
    fireEvent.click(await within(preview).findByRole("button", { name: "alpha.md" }));
    const input = within(preview).getByLabelText("File name");
    expect(input).toHaveValue("alpha");

    // Pressing Escape cancels without calling the API.
    fireEvent.change(input, { target: { value: "cancelled" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(preview).queryByLabelText("File name")).not.toBeInTheDocument();
    expect(patches).toEqual([]);

    // Re-open rename and test validation error for slash.
    fireEvent.click(within(preview).getByRole("button", { name: "alpha.md" }));
    const input2 = within(preview).getByLabelText("File name");
    fireEvent.change(input2, { target: { value: "bad/name" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(within(preview).getByRole("alert")).toHaveTextContent('A file name cannot contain "/".');
    expect(patches).toEqual([]);

    // Test 409 name_exists error stays inline so user can fix it.
    fireEvent.change(input2, { target: { value: "taken" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(await within(preview).findByRole("alert")).toHaveTextContent(
      "A file with this name already exists in this folder.",
    );

    // Fix name and commit: .md is auto-appended and both header and sidebar update.
    fireEvent.change(input2, { target: { value: "meeting-notes" } });
    fireEvent.keyDown(input2, { key: "Enter" });

    expect(
      await within(preview).findByRole("heading", { level: 2, name: "meeting-notes.md" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("treeitem", { name: /meeting-notes\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /alpha\.md/ })).not.toBeInTheDocument();
    expect(patches).toEqual([
      { id: "a-id", name: "taken.md" },
      { id: "a-id", name: "meeting-notes.md" },
    ]);
  });

  it("deletes a file via the per-file popover menu and confirmation modal, closing it if open", async () => {
    history.replaceState(null, "", "/?file=a-id");
    signedInWithRoot([node("a-id", "alpha.md", "markdown"), node("b-id", "beta.md", "markdown")]);
    const deleted: string[] = [];

    server.use(
      http.get(
        "/api/files/a-id/content",
        () =>
          new HttpResponse("# Alpha", {
            status: 200,
            headers: { "Content-Type": "application/octet-stream", ETag: '"etag-1"' },
          }),
      ),
      http.delete("/api/files/:id", ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    render(<App />);
    await screen.findByRole("region", { name: "Preview" });
    await screen.findByRole("treeitem", { name: /alpha\.md/ });

    // Open per-file popover and click Delete -> opens confirmation modal.
    fireEvent.click(screen.getByRole("button", { name: "Actions for alpha.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete note" });
    expect(dialog).toHaveTextContent("alpha.md");

    // Cancel keeps the file intact.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleted).toEqual([]);

    // Confirm deletion removes the file from tree and closes the open editor.
    fireEvent.click(screen.getByRole("button", { name: "Actions for alpha.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Delete note" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No note selected")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /alpha\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /beta\.md/ })).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(deleted).toEqual(["a-id"]);
  });
});
