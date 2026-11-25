import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { getViewPrefs, setViewPref, VIEW_PREFS_STORAGE_KEY } from "./viewPrefs";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-01T10:00:00.000Z";

const NOTE = [
  "---",
  "title: Launch plan",
  "tags: [work, q4]",
  "---",
  "# Goals",
  "",
  "Ship the first public release this quarter.",
  "",
  "## Tasks",
  "",
  "- [x] write spec",
  "- [ ] build it",
  "",
  "### Risks",
  "",
].join("\n");

function openNote(text = NOTE) {
  history.replaceState(null, "", "/?file=doc-id");
  server.use(
    http.get("/api/session", () => HttpResponse.json({ email: "owner@example.com" })),
    http.get("/api/root", () =>
      HttpResponse.json({ id: "root-id", name: "Notes", kind: "folder", modifiedTime: MODIFIED }),
    ),
    http.get("/api/folders/:id/children", () =>
      HttpResponse.json({
        nodes: [{ id: "doc-id", name: "plan.md", kind: "markdown", modifiedTime: MODIFIED }],
      }),
    ),
    http.get(
      "/api/files/:id/content",
      () =>
        new HttpResponse(text, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream", ETag: '"etag-1"' },
        }),
    ),
  );
  render(<App />);
  return screen.findByRole("region", { name: "Preview" });
}

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

function mockScrollIntoView() {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      scrolled.push(this);
    },
  });
  return scrolled;
}

function pressShortcut(key: string, modifiers: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    );
  });
}

async function runPaletteCommand(name: RegExp) {
  pressShortcut("k");
  const dialog = await screen.findByRole("dialog", { name: /command palette/i });
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">toggle" } });
  fireEvent.click(within(dialog).getByRole("option", { name }));
}

describe("Info Drawer", () => {
  it("opens from the header and shows the outline, stats and frontmatter properties", async () => {
    const scrolled = mockScrollIntoView();
    const preview = await openNote();
    const toggle = await within(preview).findByRole("button", { name: "Document info" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary", { name: "Document info" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const drawer = screen.getByRole("complementary", { name: "Document info" });

    const outline = within(drawer).getByRole("navigation", { name: "Outline" });
    const items = within(outline).getAllByRole("button");
    expect(items.map((item) => item.textContent)).toEqual(["Goals", "Tasks", "Risks"]);
    expect(items.map((item) => item.dataset.level)).toEqual(["1", "2", "3"]);

    const stat = (label: string) =>
      within(drawer).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(stat("Words")).toBe("14");
    expect(stat("Lines")).toBe("15");
    expect(stat("Tasks")).toBe("1 / 2");
    expect(stat("Reading time")).toBe("1 min");
    expect(stat("Characters")).not.toBe("");

    const properties = within(drawer).getByRole("group", { name: "Properties" });
    expect(within(properties).getByText("title").nextElementSibling).toHaveTextContent(
      "Launch plan",
    );
    expect(within(properties).getByText("tags").nextElementSibling).toHaveTextContent("work, q4");

    const tasksHeading = await within(preview).findByRole("heading", { name: "Tasks" });
    fireEvent.click(within(outline).getByRole("button", { name: "Tasks" }));
    expect(scrolled.at(-1)).toBe(tasksHeading);
    // Docked on desktop: the drawer stays open after a jump.
    expect(screen.getByRole("complementary", { name: "Document info" })).toBeInTheDocument();
  });

  it("toggles with Cmd+Shift+I and the command palette, and closes after a jump on mobile", async () => {
    mockScrollIntoView();
    mockNarrowViewport(true);
    await openNote();

    await screen.findByRole("button", { name: "Document info" });
    pressShortcut("I", { shiftKey: true });
    const drawer = screen.getByRole("complementary", { name: "Document info" });
    pressShortcut("i", { shiftKey: true });
    expect(drawer).not.toBeInTheDocument();

    await runPaletteCommand(/Toggle Info Drawer/);
    const reopened = await screen.findByRole("complementary", { name: "Document info" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Goals" }));
    expect(screen.queryByRole("complementary", { name: "Document info" })).toBeNull();
  });

  it("hides stats it cannot compute and says when there is no outline", async () => {
    await openNote("just words\n");
    fireEvent.click(await screen.findByRole("button", { name: "Document info" }));
    const drawer = screen.getByRole("complementary", { name: "Document info" });
    expect(within(drawer).getByText("No headings yet.")).toBeInTheDocument();
    expect(within(drawer).queryByText("Tasks", { selector: "dt" })).toBeNull();
    expect(within(drawer).queryByRole("group", { name: "Properties" })).toBeNull();
  });

  it("renders as a full-height mirror right sidebar while keeping the toggle in the header", async () => {
    const preview = await openNote();
    const toggle = await within(preview).findByRole("button", { name: "Document info" });
    expect(toggle.className).not.toContain("md:hidden");

    fireEvent.click(toggle);
    const drawer = screen.getByRole("complementary", { name: "Document info" });
    const header = within(preview).getByRole("banner");

    // Sits as a sibling column beside the column holding the document header + canvas.
    expect(drawer.parentElement).toBe(header.parentElement?.parentElement);
    expect(drawer.className).toContain("bg-neutral-50");
    expect(drawer.className).toContain("border-l");
    expect(drawer.className).toContain("md:w-72");
    // The header toggle stays visible on desktop rather than moving inside the sidebar.
    expect(toggle.className).not.toContain("md:hidden");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(drawer).getByRole("button", { name: "Close document info" }).className).toContain(
      "md:hidden",
    );

    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary", { name: "Document info" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Read-only lock", () => {
  it("blocks click-to-edit and task toggles, shows a lock badge, and persists", async () => {
    const preview = await openNote();
    const lock = await within(preview).findByRole("button", { name: "Read-only mode" });
    expect(lock).toHaveAttribute("aria-pressed", "false");
    expect(lock).toHaveAttribute("data-slot", "toggle");
    expect(await within(preview).findByRole("checkbox", { name: "build it" })).toBeEnabled();

    fireEvent.click(lock);
    expect(lock).toHaveAttribute("aria-pressed", "true");
    expect(within(preview).getByText("Read-only")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(VIEW_PREFS_STORAGE_KEY) ?? "{}").readOnly).toBe(true);
    expect(within(preview).getByRole("checkbox", { name: "build it" })).toBeDisabled();

    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();
    expect(screen.getByRole("region", { name: "Preview" })).toBe(preview);

    fireEvent.click(lock);
    fireEvent.click(within(preview).getByTestId("editor-canvas"));
    expect(await screen.findByRole("region", { name: "Editor" })).toBeInTheDocument();
  });

  it("returns to Preview when locked from the command palette while editing", async () => {
    const preview = await openNote();
    fireEvent.click(await within(preview).findByTestId("editor-canvas"));
    await screen.findByRole("region", { name: "Editor" });

    await runPaletteCommand(/Toggle Read-Only Mode/);
    expect(await screen.findByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(getViewPrefs().readOnly).toBe(true);
  });

  it("opens notes in Preview when the lock was left on", async () => {
    setViewPref("readOnly", true);
    const preview = await openNote();
    expect(await within(preview).findByText("Read-only")).toBeInTheDocument();
  });
});

describe("writing mode commands", () => {
  it("toggles Focus and Typewriter modes from the command palette", async () => {
    await openNote();
    await runPaletteCommand(/Toggle Focus Mode/);
    expect(getViewPrefs().focusMode).toBe(true);
    await runPaletteCommand(/Toggle Typewriter Mode/);
    expect(getViewPrefs().typewriterMode).toBe(true);
  });
});

describe("Info Drawer attachments", () => {
  const IMAGE_NOTE = [
    "# Trip",
    "",
    "![Beach](/api/files/img-1/blob)",
    "",
    "Text ![Beach](/api/files/img-1/blob) again.",
    "",
    "![](/api/files/img-2/blob)",
    "",
  ].join("\n");

  function trackWrites() {
    const puts: string[] = [];
    const deletes: string[] = [];
    server.use(
      http.put("/api/files/:id/content", async ({ request }) => {
        puts.push(await request.text());
        return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
      }),
      http.delete("/api/files/:id", ({ params }) => {
        deletes.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return { puts, deletes };
  }

  async function openAttachments() {
    const preview = await openNote(IMAGE_NOTE);
    const writes = trackWrites();
    fireEvent.click(await within(preview).findByRole("button", { name: "Document info" }));
    const drawer = screen.getByRole("complementary", { name: "Document info" });
    return {
      drawer,
      section: within(drawer).getByRole("region", { name: "Attachments" }),
      ...writes,
    };
  }

  it("lists the note's images and removes one from the note and Drive", async () => {
    const { section, puts, deletes } = await openAttachments();
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Beach×2", "img-2"]);
    expect(within(rows[0]).getByRole("img", { name: "Beach" })).toHaveAttribute(
      "src",
      "/api/files/img-1/thumb?size=96",
    );

    fireEvent.click(within(section).getByRole("button", { name: "Remove Beach" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove image" });
    expect(dialog).toHaveTextContent("(2 places)");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from note & delete from Drive" }),
    );
    await waitFor(() => expect(deletes).toEqual(["img-1"]));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toContain("img-1");
    expect(puts[0]).toContain("![](/api/files/img-2/blob)");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(
        within(section)
          .getAllByRole("listitem")
          .map((row) => row.textContent),
      ).toEqual(["img-2"]),
    );
  });

  it("removes an image from the note only, without touching Drive", async () => {
    const { section, puts, deletes } = await openAttachments();
    fireEvent.click(within(section).getByRole("button", { name: "Remove img-2" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove image" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from note only" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toContain("img-2");
    expect(puts[0]).toContain("![Beach](/api/files/img-1/blob)");
    expect(deletes).toEqual([]);
  });

  it("disables removal in read-only mode", async () => {
    setViewPref("readOnly", true);
    const { section } = await openAttachments();
    expect(within(section).getByRole("button", { name: "Remove Beach" })).toBeDisabled();
  });

  it("opens an attachment modal on click and lets the user edit tags with note suggestions", async () => {
    const TAGGED_NOTE = [
      "---",
      "tags: [Summer, Travel]",
      "---",
      "",
      "# Trip",
      "",
      "![Beach](/api/files/img-1/blob)",
      "",
    ].join("\n");
    const patched: { id: string; tags: string[] }[] = [];
    let currentTags = ["Coastal"];
    server.use(
      http.get("/api/attachments/img-1", () =>
        HttpResponse.json({
          id: "img-1",
          name: "beach.png",
          mimeType: "image/png",
          size: 2048,
          modifiedTime: "2026-11-20T10:00:00.000Z",
          createdTime: "2026-11-19T10:00:00.000Z",
          url: "/api/files/img-1/blob",
          tags: currentTags,
        }),
      ),
      http.patch("/api/attachments/img-1/tags", async ({ request }) => {
        const body = (await request.json()) as { tags: string[] };
        currentTags = body.tags;
        patched.push({ id: "img-1", tags: body.tags });
        return HttpResponse.json({
          id: "img-1",
          name: "beach.png",
          mimeType: "image/png",
          size: 2048,
          modifiedTime: "2026-11-20T10:00:00.000Z",
          createdTime: "2026-11-19T10:00:00.000Z",
          url: "/api/files/img-1/blob",
          tags: currentTags,
        });
      }),
    );

    const preview = await openNote(TAGGED_NOTE);
    fireEvent.click(await within(preview).findByRole("button", { name: "Document info" }));
    const drawer = screen.getByRole("complementary", { name: "Document info" });
    const section = within(drawer).getByRole("region", { name: "Attachments" });

    fireEvent.click(within(section).getByRole("button", { name: "Details for Beach" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("#Coastal")).toBeInTheDocument();
    expect(within(dialog).getByText("From this note")).toBeInTheDocument();

    // One-click assign a tag from the current note's frontmatter.
    fireEvent.click(within(dialog).getByRole("button", { name: "+ #Summer" }));
    await waitFor(() => expect(patched).toEqual([{ id: "img-1", tags: ["Coastal", "Summer"] }]));
    expect(within(dialog).getByText("#Summer")).toBeInTheDocument();

    // Add another tag directly via the inline input.
    const input = within(dialog).getByRole("textbox", { name: "Add image tag" });
    fireEvent.change(input, { target: { value: "Sunset" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(patched.at(-1)).toEqual({
        id: "img-1",
        tags: ["Coastal", "Summer", "Sunset"],
      }),
    );
  });
});
