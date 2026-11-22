import { cleanup, render, screen, within } from "@testing-library/react";
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

function signedIn() {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({
        nodes: [node("doc-1", "a.md", "markdown"), node("doc-2", "b.md", "markdown")],
      }),
    ),
    http.get(
      "/api/files/doc-1/content",
      () =>
        new HttpResponse("# Alpha", {
          headers: { "Content-Type": "application/octet-stream", ETag: '"e1"' },
        }),
    ),
    http.get(
      "/api/files/doc-2/content",
      () =>
        new HttpResponse("# Beta", {
          headers: { "Content-Type": "application/octet-stream", ETag: '"e2"' },
        }),
    ),
  );
}

describe("last open note", () => {
  it("reopens the note that was open last time when the app starts at /", async () => {
    signedIn();
    history.replaceState(null, "", "/?file=doc-2");
    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { name: "Beta" });
    cleanup();

    history.replaceState(null, "", "/");
    const before = history.length;
    render(<App />);
    const restored = await screen.findByRole("region", { name: "Preview" });
    expect(await within(restored).findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("file")).toBe("doc-2");
    // Restoring rewrites the URL in place: Back does not land on an empty workspace.
    expect(history.length).toBe(before);
  });

  it("an explicit ?file= wins over the remembered note", async () => {
    signedIn();
    localStorage.setItem("markyard:last-open-file", "doc-2");
    history.replaceState(null, "", "/?file=doc-1");
    render(<App />);
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(await within(preview).findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
  });

  it("falls back to the empty workspace when the remembered note no longer exists", async () => {
    signedIn();
    server.use(
      http.get("/api/files/gone/content", () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    localStorage.setItem("markyard:last-open-file", "gone");
    render(<App />);

    await screen.findByRole("treeitem", { name: /a\.md/ });
    await vi.waitFor(() => expect(new URLSearchParams(location.search).get("file")).toBeNull());
    expect(localStorage.getItem("markyard:last-open-file")).toBeNull();
    expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument();
  });
});
