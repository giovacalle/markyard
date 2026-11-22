import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { CloudUserState } from "./api";
import { App } from "./App";
import { CLOUD_STATE_STAMP_KEY } from "./cloudStateStamp";
import { getSettings, updateSettings } from "./settings";
import { getViewPrefs, setViewPref } from "./viewPrefs";

const server = setupServer();

/** Every request to `/api/state`, handled or not. */
let stateRequests: string[] = [];
const puts: { state: CloudUserState; updatedAt: number }[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).pathname === "/api/state") {
      stateRequests.push(request.method);
    }
  });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  stateRequests = [];
  puts.length = 0;
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-20T12:00:00.000Z";
// Longer than the 1 s push debounce.
const PUSH_WAIT = { timeout: 3000 };

function node(id: string, name: string, kind: "folder" | "markdown") {
  return { id, name, kind, modifiedTime: MODIFIED };
}

function markdown(text: string, etag: string) {
  return new HttpResponse(text, {
    headers: { "Content-Type": "application/octet-stream", ETag: `"${etag}"` },
  });
}

function vault(session: { cloudSync?: boolean }) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com", ...session })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () =>
      HttpResponse.json({
        nodes: [node("work-id", "Work", "folder"), node("doc-1", "a.md", "markdown")],
      }),
    ),
    http.get("/api/folders/work-id/children", () =>
      HttpResponse.json({ nodes: [node("doc-2", "b.md", "markdown")] }),
    ),
    http.get("/api/files/doc-1/content", () => markdown("# Alpha", "e1")),
    http.get("/api/files/doc-2/content", () => markdown("# Beta", "e2")),
  );
}

function cloud(remote: { state: CloudUserState | null; updatedAt: number | null }) {
  server.use(
    http.get("/api/state", () => HttpResponse.json({ enabled: true, ...remote })),
    http.put("/api/state", async ({ request }) => {
      const body = (await request.json()) as { state: CloudUserState; updatedAt: number };
      puts.push(body);
      return HttpResponse.json({ enabled: true, state: body.state, updatedAt: body.updatedAt });
    }),
  );
}

async function settle(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("cloud state sync", () => {
  it("never calls /api/state when the session has no cloud sync", async () => {
    vault({});
    render(<App />);

    const work = await screen.findByRole("treeitem", { name: /Work/ });
    fireEvent.click(work);
    await within(work).findByRole("treeitem", { name: /b\.md/ });
    act(() => setViewPref("focusMode", true));
    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    await settle(1300);

    expect(stateRequests).toEqual([]);
    expect(localStorage.getItem(CLOUD_STATE_STAMP_KEY)).toBeNull();
  });

  it("also stays off when the session says cloudSync: false", async () => {
    vault({ cloudSync: false });
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    await settle(100);
    expect(stateRequests).toEqual([]);
  });

  it("hydrates theme, folders, the last note and view modes from a newer cloud state", async () => {
    vault({ cloudSync: true });
    cloud({
      state: {
        theme: "dark",
        lastOpenFileId: "doc-2",
        expandedFolders: ["work-id"],
        readOnly: true,
        focusMode: false,
        typewriterMode: true,
        infoDrawerOpen: false,
      },
      updatedAt: 5000,
    });
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(await within(preview).findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("file")).toBe("doc-2");
    const work = screen.getByRole("treeitem", { name: /Work/ });
    expect(work).toHaveAttribute("aria-expanded", "true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("markyard-theme")).toBe("dark");
    expect(getViewPrefs()).toMatchObject({ readOnly: true, typewriterMode: true });
    expect(localStorage.getItem(CLOUD_STATE_STAMP_KEY)).toBe("5000");

    // Applying the cloud's state is not a local change: no PUT echoes it back.
    await settle(1300);
    expect(stateRequests).toEqual(["GET"]);
  });

  it("does not replace a note the user opened explicitly", async () => {
    vault({ cloudSync: true });
    cloud({ state: { lastOpenFileId: "doc-2" }, updatedAt: 5000 });
    history.replaceState(null, "", "/?file=doc-1");
    render(<App />);

    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { name: "Alpha" });
    await vi.waitFor(() => expect(puts.length).toBe(1), PUSH_WAIT);
    expect(new URLSearchParams(location.search).get("file")).toBe("doc-1");
    expect(puts[0].state.lastOpenFileId).toBe("doc-1");
    expect(puts[0].updatedAt).toBeGreaterThan(5000);
  });

  it("pushes local changes in one debounced PUT", async () => {
    vault({ cloudSync: true });
    cloud({ state: { theme: "light" }, updatedAt: 5000 });
    render(<App />);

    const work = await screen.findByRole("treeitem", { name: /Work/ });
    await vi.waitFor(() => expect(localStorage.getItem(CLOUD_STATE_STAMP_KEY)).toBe("5000"));

    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    fireEvent.click(work);
    await within(work).findByRole("treeitem", { name: /b\.md/ });
    act(() => setViewPref("focusMode", true));
    expect(Number(localStorage.getItem(CLOUD_STATE_STAMP_KEY))).toBeGreaterThan(5000);
    expect(puts).toEqual([]);

    await vi.waitFor(() => expect(puts.length).toBe(1), PUSH_WAIT);
    expect(puts[0].state).toMatchObject({
      theme: "dark",
      expandedFolders: ["work-id"],
      focusMode: true,
      readOnly: false,
    });
    expect(puts[0].updatedAt).toBe(Number(localStorage.getItem(CLOUD_STATE_STAMP_KEY)));
    await settle(1300);
    expect(puts.length).toBe(1);
  });

  it("seeds an empty cloud with this device's state", async () => {
    localStorage.setItem("markyard-theme", "dark");
    vault({ cloudSync: true });
    cloud({ state: null, updatedAt: null });
    render(<App />);

    await vi.waitFor(() => expect(puts.length).toBe(1), PUSH_WAIT);
    expect(puts[0].state).toMatchObject({ theme: "dark", expandedFolders: [] });
    expect(puts[0].updatedAt).toBeGreaterThan(0);
  });

  it("keeps newer local state over a stale cloud state and pushes it up", async () => {
    localStorage.setItem("markyard-theme", "light");
    localStorage.setItem(CLOUD_STATE_STAMP_KEY, "9000");
    vault({ cloudSync: true });
    cloud({ state: { theme: "dark", readOnly: true }, updatedAt: 5000 });
    render(<App />);

    await vi.waitFor(() => expect(puts.length).toBe(1), PUSH_WAIT);
    expect(puts[0]).toMatchObject({ state: { theme: "light", readOnly: false }, updatedAt: 9000 });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(getViewPrefs().readOnly).toBe(false);
  });

  it("adopts a newer winner returned by PUT without pushing again", async () => {
    vault({ cloudSync: true });
    server.use(
      http.get("/api/state", () =>
        HttpResponse.json({ enabled: true, state: { theme: "light" }, updatedAt: 5000 }),
      ),
      http.put("/api/state", async ({ request }) => {
        puts.push((await request.json()) as { state: CloudUserState; updatedAt: number });
        return HttpResponse.json({
          enabled: true,
          state: { theme: "system", focusMode: true },
          updatedAt: Date.now() + 60_000,
        });
      }),
    );
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    await vi.waitFor(() => expect(localStorage.getItem(CLOUD_STATE_STAMP_KEY)).toBe("5000"));

    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));

    await vi.waitFor(() => expect(getViewPrefs().focusMode).toBe(true), PUSH_WAIT);
    expect(localStorage.getItem("markyard-theme")).toBe("system");
    await settle(1300);
    expect(puts.length).toBe(1);
  });

  it("hydrates the Settings fields from a newer cloud state without echoing them", async () => {
    vault({ cloudSync: true });
    cloud({
      state: {
        theme: "light",
        rootFolderId: "root-id",
        attachmentsFolder: "Media",
        dailyNotesFolder: "Daily",
        templatesFolder: "Snippets",
        defaultMode: "edit",
        linkPreviewsEnabled: false,
      },
      updatedAt: 5000,
    });
    render(<App />);

    await screen.findByRole("treeitem", { name: /a\.md/ });
    await vi.waitFor(() =>
      expect(getSettings()).toEqual({
        attachmentsFolder: "Media",
        dailyNotesFolder: "Daily",
        templatesFolder: "Snippets",
        defaultMode: "edit",
        linkPreviewsEnabled: false,
      }),
    );
    expect(JSON.parse(localStorage.getItem("markyard:settings") ?? "{}")).toMatchObject({
      dailyNotesFolder: "Daily",
    });
    await settle(1300);
    expect(stateRequests).toEqual(["GET"]);
  });

  it("pushes Settings changes, echoing the server's vault folder", async () => {
    vault({ cloudSync: true });
    cloud({ state: { theme: "light", rootFolderId: "root-id" }, updatedAt: 5000 });
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    await vi.waitFor(() => expect(localStorage.getItem(CLOUD_STATE_STAMP_KEY)).toBe("5000"));

    act(() =>
      updateSettings({
        attachmentsFolder: "Media",
        dailyNotesFolder: "Daily",
        templatesFolder: "Snippets",
        defaultMode: "edit",
        linkPreviewsEnabled: false,
      }),
    );
    expect(Number(localStorage.getItem(CLOUD_STATE_STAMP_KEY))).toBeGreaterThan(5000);

    await vi.waitFor(() => expect(puts.length).toBe(1), PUSH_WAIT);
    expect(puts[0].state).toMatchObject({
      theme: "light",
      rootFolderId: "root-id",
      attachmentsFolder: "Media",
      dailyNotesFolder: "Daily",
      templatesFolder: "Snippets",
      defaultMode: "edit",
      linkPreviewsEnabled: false,
    });
  });

  it("degrades silently when /api/state fails", async () => {
    vault({ cloudSync: true });
    server.use(
      http.get("/api/state", () => HttpResponse.error()),
      http.put("/api/state", () => HttpResponse.error()),
    );
    render(<App />);

    const work = await screen.findByRole("treeitem", { name: /Work/ });
    fireEvent.click(work);
    await within(work).findByRole("treeitem", { name: /b\.md/ });
    fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    await settle(1300);

    expect(stateRequests).toEqual(["GET"]);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
