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
  history.replaceState(null, "", "/");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";

function node(id: string, name: string, kind: "folder" | "markdown") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function markdown(text: string, etag: string) {
  return new HttpResponse(text, {
    headers: { "Content-Type": "application/octet-stream", ETag: `"${etag}"` },
  });
}

/** Drive's folder tree as `GET /api/drive/folders` serves it. */
function driveFolders() {
  server.use(
    http.get("/api/drive/folders", ({ request }) => {
      const parentId = new URL(request.url).searchParams.get("parentId");
      if (parentId === null) {
        return HttpResponse.json({
          parent: { id: "root", name: "My Drive" },
          folders: [node("work-id", "Work", "folder"), node("old-id", "Old vault", "folder")],
        });
      }
      if (parentId === "work-id") {
        return HttpResponse.json({
          parent: { id: "work-id", name: "Work" },
          folders: [node("projects-id", "Projects", "folder")],
        });
      }
      return HttpResponse.json({ parent: { id: parentId, name: "?" }, folders: [] });
    }),
  );
}

describe("vault onboarding", () => {
  it("lets a vault-less account browse, create and pick its folder, then opens the vault", async () => {
    let needsVaultSetup = true;
    let rootRequests = 0;
    const creates: unknown[] = [];
    const picks: unknown[] = [];
    driveFolders();
    server.use(
      http.get("/api/session", () =>
        HttpResponse.json({ email: "new@example.com", name: "New User", needsVaultSetup }),
      ),
      http.get("/api/root", () => {
        rootRequests += 1;
        return HttpResponse.json(node("notes-id", "My notes", "folder"));
      }),
      http.post("/api/drive/folders", async ({ request }) => {
        const body = (await request.json()) as { parentId?: string; name: string };
        creates.push(body);
        return HttpResponse.json(node("notes-id", body.name, "folder"), { status: 201 });
      }),
      http.put("/api/vault/root", async ({ request }) => {
        const body = (await request.json()) as { folderId: string };
        picks.push(body);
        needsVaultSetup = false;
        return HttpResponse.json({ root: node(body.folderId, "My notes", "folder") });
      }),
      http.get("/api/folders/notes-id/children", () =>
        HttpResponse.json({ nodes: [node("n1", "hello.md", "markdown")] }),
      ),
    );
    render(<App />);

    const onboarding = await screen.findByRole("region", { name: "Choose your vault folder" });
    expect(screen.getByText("New User (new@example.com)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // My Drive itself can be the vault.
    expect(within(onboarding).getByRole("button", { name: "Use “My Drive”" })).toBeEnabled();

    // Drill into Work, then back via the breadcrumbs.
    fireEvent.click(await within(onboarding).findByRole("button", { name: "Open Work" }));
    const path = within(onboarding).getByRole("navigation", { name: "Folder path" });
    expect(within(path).getByText("Work")).toHaveAttribute("aria-current", "location");
    expect(await within(onboarding).findByRole("button", { name: "Projects" })).toBeInTheDocument();
    expect(within(onboarding).getByRole("button", { name: "Use “Work”" })).toBeEnabled();
    fireEvent.click(within(path).getByRole("button", { name: "My Drive" }));
    await within(onboarding).findByRole("button", { name: "Open Old vault" });

    // Invalid names are refused before any request.
    fireEvent.click(within(onboarding).getByRole("button", { name: "New folder" }));
    const input = within(onboarding).getByLabelText("New folder in My Drive");
    fireEvent.change(input, { target: { value: "a/b" } });
    fireEvent.click(within(onboarding).getByRole("button", { name: "Create" }));
    expect(within(onboarding).getByRole("alert")).toBeInTheDocument();
    expect(creates).toEqual([]);

    fireEvent.change(input, { target: { value: "My notes" } });
    fireEvent.click(within(onboarding).getByRole("button", { name: "Create" }));
    const created = await within(onboarding).findByRole("button", { name: /^My notes/ });
    expect(created).toHaveAttribute("aria-pressed", "true");
    expect(creates).toEqual([{ name: "My notes" }]);
    expect(rootRequests).toBe(0);

    fireEvent.click(within(onboarding).getByRole("button", { name: "Use “My notes”" }));
    expect(await screen.findByRole("treeitem", { name: /hello\.md/ })).toBeInTheDocument();
    expect(picks).toEqual([{ folderId: "notes-id" }]);
    expect(screen.queryByRole("region", { name: "Choose your vault folder" })).toBeNull();
  });

  it("lets a vault-less account take all of My Drive as its vault", async () => {
    const picks: unknown[] = [];
    driveFolders();
    server.use(
      http.get("/api/session", () =>
        HttpResponse.json({ email: "new@example.com", name: "New User", needsVaultSetup: true }),
      ),
      http.put("/api/vault/root", async ({ request }) => {
        const body = (await request.json()) as { folderId: string };
        picks.push(body);
        return HttpResponse.json({ root: node("my-drive-id", "My Drive", "folder") });
      }),
      http.get("/api/root", () => HttpResponse.json(node("my-drive-id", "My Drive", "folder"))),
      http.get("/api/folders/my-drive-id/children", () =>
        HttpResponse.json({ nodes: [node("n1", "hello.md", "markdown")] }),
      ),
    );
    render(<App />);

    const onboarding = await screen.findByRole("region", { name: "Choose your vault folder" });
    await within(onboarding).findByRole("button", { name: "Open Work" });

    fireEvent.click(within(onboarding).getByRole("button", { name: "Use “My Drive”" }));

    expect(await screen.findByRole("treeitem", { name: /hello\.md/ })).toBeInTheDocument();
    expect(picks).toEqual([{ folderId: "root" }]);
    expect(screen.queryByRole("region", { name: "Choose your vault folder" })).toBeNull();
  });
});

describe("changing vault from Settings", () => {
  it("switches the root, drops the old vault's tree and open note", async () => {
    let rootId = "old-id";
    const picks: unknown[] = [];
    history.replaceState(null, "", "/?file=old-note");
    driveFolders();
    server.use(
      http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
      http.get("/api/root", () =>
        HttpResponse.json(node(rootId, rootId === "old-id" ? "Old vault" : "Projects", "folder")),
      ),
      http.get("/api/folders/old-id/children", () =>
        HttpResponse.json({ nodes: [node("old-note", "old.md", "markdown")] }),
      ),
      http.get("/api/files/old-note/content", () => markdown("# Old", "e-old")),
      http.get("/api/folders/projects-id/children", () =>
        HttpResponse.json({ nodes: [node("new-note", "new.md", "markdown")] }),
      ),
      http.put("/api/vault/root", async ({ request }) => {
        const body = (await request.json()) as { folderId: string };
        picks.push(body);
        rootId = body.folderId;
        return HttpResponse.json({ root: node(body.folderId, "Projects", "folder") });
      }),
    );
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { name: "Old" });

    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByTestId("settings-vault-name")).toHaveTextContent("Old vault");
    fireEvent.click(within(settings).getByRole("button", { name: "Change vault…" }));

    const picker = await screen.findByRole("dialog", { name: "Choose vault folder" });
    const oldRow = await within(picker).findByRole("button", { name: /^Old vault/ });
    expect(within(oldRow).getByText("Current vault")).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "Open Work" }));
    fireEvent.click(await within(picker).findByRole("button", { name: "Projects" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Use “Projects”" }));

    expect(await screen.findByRole("treeitem", { name: /new\.md/ })).toBeInTheDocument();
    expect(picks).toEqual([{ folderId: "projects-id" }]);
    expect(screen.queryByRole("treeitem", { name: /old\.md/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Choose vault folder" })).toBeNull();
    await vi.waitFor(() => expect(new URLSearchParams(location.search).get("file")).toBeNull());
    expect(screen.queryByRole("heading", { name: "Old" })).toBeNull();
  });
});
