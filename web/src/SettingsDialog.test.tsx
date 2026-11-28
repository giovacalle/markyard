import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { todayNoteName } from "./commandSearch";
import { Preview } from "./components/Preview";
import { SettingsDialog } from "./components/SettingsDialog";
import { getCustomCssSheet, resetCustomCssForTests } from "./customCss";
import { getSettings, resetSettings, updateSettings } from "./settings";
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

function showSection(dialog: HTMLElement, name: string) {
  fireEvent.click(within(dialog).getByRole("tab", { name }));
}

function renderSettings() {
  render(
    <SettingsDialog
      open
      onClose={vi.fn()}
      vaultName="Notes"
      onChangeVault={vi.fn()}
      theme="system"
      onThemeChange={vi.fn()}
      cloudSync={false}
      vaultPinned={false}
      onPinVaultChange={vi.fn()}
      pendingSyncCount={0}
      onClearCache={vi.fn(async () => {})}
    />,
  );
  return screen.getByRole("dialog", { name: "Settings" });
}

/** The dialog moves focus into itself after opening; wait for that before steering focus. */
async function renderSettledSettings() {
  const dialog = renderSettings();
  await vi.waitFor(() => expect(document.activeElement).not.toBe(document.body));
  return dialog;
}

const SECTIONS = ["Appearance", "Editor", "Vault", "Sync & Storage"];

/** Every control, by the section it must live in. */
const SECTION_CONTROLS: Record<string, ((dialog: HTMLElement) => HTMLElement | null)[]> = {
  Appearance: [
    (d) => within(d).queryByRole("radiogroup", { name: "Theme" }),
    (d) => within(d).queryByRole("radiogroup", { name: "Layout" }),
    (d) => within(d).queryByRole("switch", { name: "Custom CSS" }),
    (d) => within(d).queryByLabelText("Styles folder"),
    (d) => within(d).queryByTestId("settings-custom-css-status"),
  ],
  Editor: [
    (d) => within(d).queryByRole("radiogroup", { name: "Default mode" }),
    (d) => within(d).queryByRole("switch", { name: "URL link previews" }),
    (d) => within(d).queryByRole("switch", { name: "Read-only mode" }),
    (d) => within(d).queryByRole("switch", { name: "Focus mode" }),
    (d) => within(d).queryByRole("switch", { name: "Typewriter mode" }),
  ],
  Vault: [
    (d) => within(d).queryByTestId("settings-vault-name"),
    (d) => within(d).queryByRole("button", { name: "Change vault…" }),
    (d) => within(d).queryByLabelText("Attachments folder"),
    (d) => within(d).queryByRole("switch", { name: "Show attachments folder" }),
    (d) => within(d).queryByLabelText("Daily notes folder"),
    (d) => within(d).queryByLabelText("Templates folder"),
  ],
  "Sync & Storage": [
    (d) => within(d).queryByTestId("settings-cloud-sync"),
    (d) => within(d).queryByRole("switch", { name: "Offline vault" }),
    (d) => within(d).queryByRole("button", { name: "Clear local cache" }),
  ],
};

describe("Settings sections", () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    }
  });

  function mockNarrowViewport(narrow: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: narrow && query === "(max-width: 47.99rem)",
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  }

  it("lists the four sections in order with Appearance selected", () => {
    const dialog = renderSettings();
    const list = within(dialog).getByRole("tablist", { name: "Settings sections" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(SECTIONS);
    expect(within(list).getByRole("tab", { name: "Appearance" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = within(dialog).getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });

  it("moves between sections with the Up and Down arrows", async () => {
    const dialog = await renderSettledSettings();
    const appearance = within(dialog).getByRole("tab", { name: "Appearance" });
    appearance.focus();
    fireEvent.keyDown(appearance, { key: "ArrowDown" });
    const editor = within(dialog).getByRole("tab", { name: "Editor" });
    await vi.waitFor(() => expect(editor).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(editor);
    expect(within(dialog).getByRole("tabpanel", { name: "Editor" })).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "ArrowUp" });
    await vi.waitFor(() => expect(appearance).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(appearance);
  });

  it("shows each control only in its own section", () => {
    const dialog = renderSettings();
    for (const section of SECTIONS) {
      showSection(dialog, section);
      const panel = within(dialog).getByRole("tabpanel", { name: section });
      expect(within(panel).getByRole("heading", { name: section })).toBeInTheDocument();
      for (const [owner, controls] of Object.entries(SECTION_CONTROLS)) {
        for (const control of controls) {
          if (owner === section) {
            expect(control(panel)).toBeInTheDocument();
          } else {
            expect(control(dialog)).toBeNull();
          }
        }
      }
    }
  });

  it("drills into one section on narrow screens and goes back to the list", async () => {
    mockNarrowViewport(true);
    const dialog = await renderSettledSettings();
    const list = within(dialog).getByRole("tablist", { name: "Settings sections" });
    expect(within(list).getAllByRole("tab")).toHaveLength(4);
    expect(within(dialog).queryByRole("tabpanel")).toBeNull();

    const vaultTab = within(list).getByRole("tab", { name: "Vault" });
    fireEvent.click(vaultTab);
    const panel = within(dialog).getByRole("tabpanel", { name: "Vault" });
    expect(within(panel).getByTestId("settings-vault-name")).toHaveTextContent("Notes");
    expect(within(dialog).queryByRole("tablist")).toBeNull();
    const back = within(dialog).getByRole("button", { name: "Back to settings sections" });
    expect(document.activeElement).toBe(back);

    fireEvent.click(back);
    expect(within(dialog).getByRole("tablist", { name: "Settings sections" })).toBeVisible();
    expect(within(dialog).queryByRole("tabpanel")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Back to settings sections" })).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole("tab", { name: "Vault" }));
  });

  it("keeps exactly one section tab in the Tab order of the narrow list view", () => {
    mockNarrowViewport(true);
    const dialog = renderSettings();
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
  });

  it("returns focus to the section tab after Back when the screen narrowed while a section was open", async () => {
    let narrow = false;
    const listeners = new Set<() => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        get matches() {
          return narrow && query === "(max-width: 47.99rem)";
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }),
    });
    const dialog = await renderSettledSettings();
    showSection(dialog, "Sync & Storage");

    narrow = true;
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
    const back = within(dialog).getByRole("button", { name: "Back to settings sections" });
    expect(document.activeElement).toBe(back);

    fireEvent.click(back);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("tab", { name: "Sync & Storage" }),
    );
  });

  it("focuses the open section's tab when the screen widens while Back had focus", async () => {
    let narrow = true;
    const listeners = new Set<() => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        get matches() {
          return narrow && query === "(max-width: 47.99rem)";
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }),
    });
    const dialog = await renderSettledSettings();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Vault" }));
    const back = within(dialog).getByRole("button", { name: "Back to settings sections" });
    expect(document.activeElement).toBe(back);

    narrow = false;
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
    expect(within(dialog).queryByRole("button", { name: "Back to settings sections" })).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole("tab", { name: "Vault" }));
  });

  it("falls back to the desktop layout without matchMedia", () => {
    Reflect.deleteProperty(window, "matchMedia");
    const dialog = renderSettings();
    expect(within(dialog).getByRole("tabpanel", { name: "Appearance" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
  });
});

describe("Settings dialog", () => {
  it("opens from the account popover and from Cmd+K, and closes on Escape", async () => {
    vault();
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });

    let dialog = await openSettingsFromAccount();
    showSection(dialog, "Vault");
    expect(within(dialog).getByTestId("settings-vault-name")).toHaveTextContent("Notes");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());

    pressCmdK();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: ">settings" } });
    fireEvent.click(within(palette).getByRole("option", { name: /Open Settings/ }));
    dialog = await screen.findByRole("dialog", { name: "Settings" });
    const sections = within(dialog).getByRole("tablist", { name: "Settings sections" });
    expect(within(sections).getByRole("tab", { name: "Appearance" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("edits folder settings, rejects invalid names and resets a customized folder", async () => {
    vault();
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    const dialog = await openSettingsFromAccount();
    showSection(dialog, "Vault");

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

    const layout = within(dialog).getByRole("radiogroup", { name: "Layout" });
    expect(within(layout).getByRole("radio", { name: "Default" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(layout).getByRole("radio", { name: "Borderless" }));
    expect(getSettings().layout).toBe("borderless");
    expect(document.documentElement.dataset.layout).toBe("borderless");
    fireEvent.click(within(layout).getByRole("radio", { name: "Default" }));
    expect(getSettings().layout).toBe("default");
    expect(document.documentElement.dataset.layout).toBeUndefined();

    showSection(dialog, "Editor");
    const mode = within(dialog).getByRole("radiogroup", { name: "Default mode" });
    expect(within(mode).getByRole("radio", { name: "Preview" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(mode).getByRole("radio", { name: "Edit" }));
    expect(getSettings().defaultMode).toBe("edit");

    showSection(dialog, "Vault");
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

    showSection(dialog, "Editor");
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
    showSection(dialog, "Sync & Storage");
    expect(within(dialog).getByTestId("settings-cloud-sync")).toHaveTextContent(/^Local only$/);
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
    showSection(dialog, "Sync & Storage");
    // Whatever the backend (D1 on Cloudflare, SQLite on the Node host), the copy names none.
    expect(within(dialog).getByTestId("settings-cloud-sync")).toHaveTextContent(/^Active$/);
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
    showSection(dialog, "Sync & Storage");

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear local cache" }));
    const confirm = within(dialog).getByRole("group", { name: "Confirm clearing the local cache" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Clear cache" }));
    expect(await within(dialog).findByText("Local cache cleared.")).toBeInTheDocument();
    await vi.waitFor(() => expect(listings).toBe(2));
    expect(await screen.findByRole("treeitem", { name: /a\.md/ })).toBeInTheDocument();
  });

  it("controls custom CSS via the Appearance switch and Styles folder and shows all four status states", async () => {
    vault({}, [node("a-id", "a.md", "markdown"), node("styles-dir", "_styles", "folder")]);
    server.use(
      http.get("/api/folders/styles-dir/children", () =>
        HttpResponse.json({ nodes: [node("look-id", "look.md", "markdown")] }),
      ),
      http.get("/api/files/look-id/content", () =>
        markdown("```css\n.markdown-preview h1 { color: rgb(255, 0, 0); }\n```", "e1"),
      ),
    );

    const { unmount } = render(<App />);
    await vi.waitFor(() => {
      expect(getCustomCssSheet()!.cssRules.length).toBeGreaterThan(0);
    });

    let dialog = await openSettingsFromAccount();
    expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveTextContent(
      "Loaded: look.md",
    );
    // Announced to assistive tech when it changes (WCAG 4.1.3).
    expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveAttribute(
      "role",
      "status",
    );

    // Edit Styles folder and turn Custom CSS off: sheet empties and both persist across reload.
    const stylesInput = within(dialog).getByLabelText("Styles folder");
    expect(stylesInput).toHaveValue("_styles");
    fireEvent.change(stylesInput, { target: { value: "MyStyles" } });
    fireEvent.blur(stylesInput);
    expect(getSettings().stylesFolder).toBe("MyStyles");
    await vi.waitFor(() => {
      expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveTextContent(
        "No style notes in MyStyles",
      );
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Reset styles folder" }));
    await vi.waitFor(() => {
      expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveTextContent(
        "Loaded: look.md",
      );
    });

    const toggle = within(dialog).getByRole("switch", { name: "Custom CSS" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(getSettings().customCss).toBe(false);
    expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveTextContent(
      "Custom CSS is off",
    );
    await vi.waitFor(() => {
      expect(getCustomCssSheet()!.cssRules.length).toBe(0);
    });

    fireEvent.change(stylesInput, { target: { value: "theme" } });
    fireEvent.blur(stylesInput);
    resetSettings({ keepStorage: true });
    expect(getSettings()).toMatchObject({ customCss: false, stylesFolder: "theme" });
    unmount();

    // No style notes when _styles is absent in a listed root.
    resetSettings();
    server.resetHandlers();
    vault();
    const { unmount: unmountEmpty } = render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    dialog = await openSettingsFromAccount();
    await vi.waitFor(() => {
      expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveTextContent(
        "No style notes in _styles",
      );
    });
    unmountEmpty();

    // Disabled by ?nocss=1.
    history.replaceState(null, "", "/?nocss=1");
    resetCustomCssForTests();
    render(<App />);
    await screen.findByRole("treeitem", { name: /a\.md/ });
    dialog = await openSettingsFromAccount();
    expect(within(dialog).getByTestId("settings-custom-css-status")).toHaveTextContent(
      "Disabled for this load by ?nocss=1",
    );
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
