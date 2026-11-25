import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { todayNoteName } from "./commandSearch";
import { Preview } from "./components/Preview";
import { getSettings, updateSettings } from "./settings";
import { getViewPrefs } from "./viewPrefs";

const server = setupServer();
let linkPreviewRequests = 0;

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).pathname.startsWith("/api/link-preview")) {
      linkPreviewRequests += 1;
    }
  });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  linkPreviewRequests = 0;
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

function vault(
  session: { cloudSync?: boolean } = {},
  rootNodes = [node("a-id", "a.md", "markdown")],
) {
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com", ...session })),
    http.get("/api/root", () => HttpResponse.json(node("root-id", "Notes", "folder"))),
    http.get("/api/folders/root-id/children", () => HttpResponse.json({ nodes: rootNodes })),
    http.get("/api/files/a-id/content", () => markdown("# Alpha", "e1")),
  );
}

function pressCmdK() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

async function openSettingsFromAccount() {
  fireEvent.click(await screen.findByRole("button", { name: /Account:/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog", { name: "Settings" });
}

describe("Settings dialog", () => {
  it("opens from the account popover and from Cmd+K, and closes on Escape", async () => {
    vault();
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });

    let dialog = await openSettingsFromAccount();
    expect(within(dialog).getByTestId("settings-vault-name")).toHaveTextContent("Notes");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());

    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: ">settings" } });
    fireEvent.click(within(palette).getByRole("option", { name: /Open Settings/ }));
    dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("heading", { name: "Vault & Folders" })).toBeInTheDocument();
  });

  it("edits folder settings, rejects invalid names and resets a customized folder", async () => {
    vault();
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    const dialog = await openSettingsFromAccount();

    const attachments = within(dialog).getByLabelText("Attachments folder");
    expect(attachments).toHaveValue("_attachments");
    fireEvent.change(attachments, { target: { value: "a/b" } });
    expect(attachments).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    fireEvent.blur(attachments);
    expect(getSettings().attachmentsFolder).toBe("_attachments");

    fireEvent.change(attachments, { target: { value: ".." } });
    expect(attachments).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(attachments, { target: { value: " Media " } });
    expect(attachments).toHaveAttribute("aria-invalid", "false");
    fireEvent.keyDown(attachments, { key: "Enter" });
    expect(getSettings().attachmentsFolder).toBe("Media");
    expect(attachments).toHaveValue("Media");

    const daily = within(dialog).getByLabelText("Daily notes folder");
    expect(daily).toHaveValue("");
    fireEvent.change(daily, { target: { value: "Daily" } });
    fireEvent.blur(daily);
    expect(getSettings().dailyNotesFolder).toBe("Daily");
    fireEvent.change(daily, { target: { value: "" } });
    fireEvent.blur(daily);
    expect(getSettings().dailyNotesFolder).toBe("");

    const templates = within(dialog).getByLabelText("Templates folder");
    fireEvent.change(templates, { target: { value: "" } });
    expect(templates).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(templates, { target: { value: "Snippets" } });
    fireEvent.blur(templates);
    expect(getSettings().templatesFolder).toBe("Snippets");

    fireEvent.click(within(dialog).getByRole("button", { name: "Reset templates folder" }));
    expect(getSettings().templatesFolder).toBe("Templates");
    expect(templates).toHaveValue("Templates");
    expect(JSON.parse(localStorage.getItem("markyard:settings") ?? "{}")).toMatchObject({
      attachmentsFolder: "Media",
    });
  });

  it("toggles theme, default mode, link previews and view modes", async () => {
    vault();
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    const dialog = await openSettingsFromAccount();

    const theme = within(dialog).getByRole("radiogroup", { name: "Theme" });
    fireEvent.click(within(theme).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const mode = within(dialog).getByRole("radiogroup", { name: "Default mode" });
    expect(within(mode).getByRole("radio", { name: "Preview" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(mode).getByRole("radio", { name: "Edit" }));
    expect(getSettings().defaultMode).toBe("edit");

    const showAttachments = within(dialog).getByRole("switch", {
      name: "Show attachments folder",
    });
    expect(showAttachments).toHaveAttribute("aria-checked", "true");
    expect(showAttachments).toHaveAttribute("data-slot", "switch");
    expect(showAttachments).toHaveAttribute("data-checked");
    expect(showAttachments).toHaveAccessibleDescription(
      "Show the attachments folder in the file tree, move picker and command palette.",
    );
    fireEvent.click(showAttachments);
    expect(showAttachments).toHaveAttribute("aria-checked", "false");
    expect(showAttachments).not.toHaveAttribute("data-checked");
    expect(getSettings().showAttachmentsFolder).toBe(false);

    const previews = within(dialog).getByRole("switch", { name: "URL link previews" });
    expect(previews).toHaveAttribute("aria-checked", "true");
    fireEvent.click(previews);
    expect(previews).toHaveAttribute("aria-checked", "false");
    expect(getSettings().linkPreviewsEnabled).toBe(false);

    fireEvent.click(within(dialog).getByRole("switch", { name: "Focus mode" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Typewriter mode" }));
    expect(getViewPrefs()).toMatchObject({ focusMode: true, typewriterMode: true });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Read-only mode" }));
    expect(getViewPrefs().readOnly).toBe(true);
  });

  it("opens notes in the default mode chosen in Settings", async () => {
    updateSettings({ defaultMode: "edit" });
    vault();
    render(<App />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /a\.md/ }));
    expect(await screen.findByRole("region", { name: "Editor" })).toBeInTheDocument();
  });

  it("shows the cloud sync status", async () => {
    vault({ cloudSync: false });
    const { unmount } = render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    let dialog = await openSettingsFromAccount();
    expect(within(dialog).getByTestId("settings-cloud-sync")).toHaveTextContent("Local only");
    unmount();

    server.resetHandlers();
    vault({ cloudSync: true });
    server.use(
      http.get("/api/state", () =>
        HttpResponse.json({ enabled: true, state: null, updatedAt: null }),
      ),
      http.put("/api/state", async ({ request }) =>
        HttpResponse.json({ enabled: true, ...((await request.json()) as object) }),
      ),
    );
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    dialog = await openSettingsFromAccount();
    expect(within(dialog).getByTestId("settings-cloud-sync")).toHaveTextContent(
      "Active (Cloudflare D1)",
    );
  });

  it("clears the local cache after confirming and reloads the tree from Drive", async () => {
    let listings = 0;
    vault();
    server.use(
      http.get("/api/folders/root-id/children", () => {
        listings += 1;
        return HttpResponse.json({ nodes: [node("a-id", "a.md", "markdown")] });
      }),
    );
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    expect(listings).toBe(1);
    const dialog = await openSettingsFromAccount();

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear local cache" }));
    const confirm = within(dialog).getByRole("group", { name: "Confirm clearing the local cache" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Clear cache" }));
    expect(await within(dialog).findByText("Local cache cleared.")).toBeInTheDocument();
    await vi.waitFor(() => expect(listings).toBe(2));
    expect(await screen.findByRole("treeitem", { name: /a\.md/ })).toBeInTheDocument();
  });
});

describe("link previews setting", () => {
  it("renders external links as plain links with no hover card or bookmark when disabled", async () => {
    server.use(
      http.get("/api/link-preview", () =>
        HttpResponse.json({ url: "https://example.com/post", hostname: "example.com", title: "T" }),
      ),
    );
    updateSettings({ linkPreviewsEnabled: false });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Preview text={"Read [the post](https://example.com/post).\n\nhttps://example.com/bare"} />
      </QueryClientProvider>,
    );

    const link = screen.getByRole("link", { name: "the post" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("link", { name: "https://example.com/bare" })).toBeInTheDocument();
    expect(screen.queryByTestId("link-bookmark")).toBeNull();
    expect(linkPreviewRequests).toBe(0);
  });
});

describe("daily notes folder", () => {
  it("creates the Daily folder when missing and today's note inside it", async () => {
    updateSettings({ dailyNotesFolder: "Daily" });
    const today = todayNoteName();
    const folderPosts: { parentId: string; name: string }[] = [];
    const filePosts: { folderId: string; name: string }[] = [];
    vault();
    server.use(
      http.post("/api/folders/:id/folders", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        folderPosts.push({ parentId: String(params.id), name: body.name });
        return HttpResponse.json(node("daily-folder", body.name, "folder"), { status: 201 });
      }),
      http.post("/api/folders/:id/files", async ({ params, request }) => {
        const body = (await request.json()) as { name: string };
        filePosts.push({ folderId: String(params.id), name: body.name });
        return HttpResponse.json(node("today-id", body.name, "markdown"), {
          status: 201,
          headers: { ETag: '"etag-today"' },
        });
      }),
    );
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });

    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: ">today" } });
    fireEvent.click(within(palette).getByRole("option", { name: /Today's note/ }));

    const editor = await screen.findByRole("region", { name: "Editor" });
    expect(within(editor).getByRole("heading", { level: 2, name: today })).toBeInTheDocument();
    expect(folderPosts).toEqual([{ parentId: "root-id", name: "Daily" }]);
    expect(filePosts).toEqual([{ folderId: "daily-folder", name: today }]);
    expect(await screen.findByRole("treeitem", { name: /Daily/ })).toBeInTheDocument();
  });

  it("opens today's note already inside an existing Daily folder (case-insensitive)", async () => {
    updateSettings({ dailyNotesFolder: "daily" });
    const today = todayNoteName();
    vault({}, [node("a-id", "a.md", "markdown"), node("daily-folder", "Daily", "folder")]);
    server.use(
      http.get("/api/folders/daily-folder/children", () =>
        HttpResponse.json({ nodes: [node("today-id", today, "markdown")] }),
      ),
      http.get("/api/files/today-id/content", () => markdown("# Already here", "et")),
    );
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });

    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: ">today" } });
    fireEvent.click(within(palette).getByRole("option", { name: /Today's note/ }));

    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(
      await within(preview).findByRole("heading", { name: "Already here" }),
    ).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("file")).toBe("today-id");
  });
});
