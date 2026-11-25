import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { AttachmentItem } from "./api";
import { startOfMonth, todayDate } from "@ui-sdk/core/date";
import { AttachmentsPanel, attachmentMarkdown, formatBytes } from "./components/AttachmentsView";
import { dayRangeLabel } from "./components/UploadDateFilter";
import type { VaultDocument } from "./vaultDocuments";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

const item = (
  id: string,
  name: string,
  modifiedTime: string,
  size?: number,
  tags?: string[],
): AttachmentItem => ({
  id,
  name,
  mimeType: "image/png",
  size,
  modifiedTime,
  createdTime: modifiedTime,
  url: `/api/files/${id}/blob`,
  ...(tags === undefined ? {} : { tags }),
});

const ATTACHMENTS = [
  item("img-a", "diagram.png", "2026-11-03T10:00:00.000Z", 2048, ["architecture", "Design"]),
  item("img-b", "orphan.png", "2026-11-02T10:00:00.000Z", 512),
  item("img-c", "shared.png", "2026-11-01T10:00:00.000Z", undefined, ["Y2K aesthetic"]),
];

const doc = (id: string, name: string, text: string): VaultDocument => ({
  id,
  name,
  path: ["Work"],
  folderId: "folder",
  text,
  revision: `rev-${id}`,
});

const DOCS = [
  doc("n1", "Plan.md", "![diagram](/api/files/img-a/blob)\n![](/api/files/img-c/blob)\n"),
  doc("n2", "Notes.md", "See ![shared](/api/files/img-c/blob)"),
];

function renderPanel({
  readOnly = false,
  offline = false,
  docs = DOCS,
  focusAttachment,
}: {
  readOnly?: boolean;
  offline?: boolean;
  docs?: VaultDocument[] | null;
  focusAttachment?: { id: string; key: number } | null;
} = {}) {
  const deleted: string[] = [];
  const patchedTags: { id: string; tags: string[] }[] = [];
  const listUrls: URL[] = [];
  let listed = [...ATTACHMENTS];
  server.use(
    http.get("/api/attachments", ({ request }) => {
      const url = new URL(request.url);
      listUrls.push(url);
      const from = url.searchParams.get("uploadedFrom");
      const before = url.searchParams.get("uploadedBefore");
      return HttpResponse.json({
        folderId: "att-folder",
        attachments: listed.filter(
          (entry) =>
            (from === null || (entry.createdTime ?? "") >= from) &&
            (before === null || (entry.createdTime ?? "") < before),
        ),
      });
    }),
    http.patch("/api/attachments/:id/tags", async ({ params, request }) => {
      const id = String(params.id);
      const body = (await request.json()) as { tags: string[] };
      patchedTags.push({ id, tags: body.tags });
      const existing = listed.find((entry) => entry.id === id);
      if (!existing) {
        return HttpResponse.json({ code: "not_found", message: "Not found" }, { status: 404 });
      }
      const updated: AttachmentItem =
        body.tags.length === 0
          ? {
              id: existing.id,
              name: existing.name,
              mimeType: existing.mimeType,
              size: existing.size,
              modifiedTime: existing.modifiedTime,
              createdTime: existing.createdTime,
              url: existing.url,
            }
          : { ...existing, tags: body.tags };
      listed = listed.map((entry) => (entry.id === id ? updated : entry));
      return HttpResponse.json(updated);
    }),
    http.delete("/api/files/:id", ({ params }) => {
      deleted.push(String(params.id));
      listed = listed.filter((entry) => entry.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const onOpenNote = vi.fn<(id: string) => void>();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AttachmentsPanel
        docs={docs}
        vaultPinned={false}
        offline={offline}
        readOnly={readOnly}
        focusAttachment={focusAttachment}
        onOpenNote={onOpenNote}
      />
    </QueryClientProvider>,
  );
  return { deleted, patchedTags, listUrls, onOpenNote };
}

const cardNames = () =>
  within(screen.getByRole("list", { name: "Attachment list" }))
    .getAllByRole("listitem")
    .map((card) => card.getAttribute("aria-label"));

describe("AttachmentsPanel", () => {
  it("lists attachments newest first as a lazy Drive thumbnail, the name and two actions", async () => {
    renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });
    expect(cardNames()).toEqual(["diagram.png", "orphan.png", "shared.png"]);

    const diagram = screen.getByRole("listitem", { name: "diagram.png" });
    const thumb = diagram.querySelector("img");
    expect(thumb).toHaveAttribute("src", "/api/files/img-a/thumb?size=640");
    expect(thumb).toHaveAttribute("loading", "lazy");
    expect(within(diagram).getByText("diagram.png")).toBeInTheDocument();
    expect(
      within(diagram)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Details for diagram.png", "Copy diagram.png", "Delete diagram.png"]);
    expect(within(diagram).queryByText(/KB|Used in|Unused/)).toBeNull();
  });

  it("shows details and the notes using an attachment in the info sidebar", async () => {
    const { onOpenNote } = renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    // Open from the start on the newest card; pressing that card keeps it open.
    const details = screen.getByRole("button", { name: "Details for diagram.png" });
    expect(details).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    let info = screen.getByRole("complementary", { name: "Attachment info" });
    expect(within(info).getByRole("heading", { name: "diagram.png" })).toBeInTheDocument();
    expect(within(info).getByRole("img", { name: "diagram.png" })).toHaveAttribute(
      "src",
      "/api/files/img-a/thumb?size=800",
    );
    expect(within(info).getByRole("link")).toHaveAttribute("href", "/api/files/img-a/blob");
    expect(within(info).getByText("2.0 KB")).toBeInTheDocument();
    expect(within(info).getByText("Uploaded")).toBeInTheDocument();
    expect(within(info).getByText("PNG")).toBeInTheDocument();
    const usage = within(info).getByRole("region", { name: "Used in" });
    expect(usage).toHaveTextContent("· 1");
    expect(within(usage).getByText(/Usage counts only notes cached on this device/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Details for shared.png" }));
    info = screen.getByRole("complementary", { name: "Attachment info" });
    expect(within(info).getByRole("heading", { name: "shared.png" })).toBeInTheDocument();
    fireEvent.click(within(info).getByRole("button", { name: /Notes/ }));
    expect(onOpenNote).toHaveBeenCalledWith("n2");

    fireEvent.click(screen.getByRole("button", { name: "Details for orphan.png" }));
    info = screen.getByRole("complementary", { name: "Attachment info" });
    expect(within(info).getByText("Not used in any note cached on this device.")).toBeVisible();

    fireEvent.click(within(info).getByRole("button", { name: "Close attachment info" }));
    expect(screen.queryByRole("complementary", { name: "Attachment info" })).toBeNull();
    expect(details).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Details for shared.png" }));
    info = screen.getByRole("complementary", { name: "Attachment info" });
    expect(within(info).getByRole("heading", { name: "shared.png" })).toBeInTheDocument();
  });

  it("starts with the info sidebar closed on narrow screens", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 47.99rem)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    try {
      renderPanel();
      await screen.findByRole("list", { name: "Attachment list" });
      expect(screen.queryByRole("complementary", { name: "Attachment info" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("filters by upload days picked in one calendar field, as local calendar days", async () => {
    const { listUrls } = renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    fireEvent.click(screen.getByRole("button", { name: "Upload date: any" }));
    const first = startOfMonth(todayDate());
    const day = () => document.querySelector<HTMLElement>(`[data-value="${first}"]`)!;
    fireEvent.click(day());
    fireEvent.click(day());
    const [year, month] = first.split("-").map(Number);
    await waitFor(() =>
      expect(listUrls.at(-1)!.searchParams.get("uploadedFrom")).toBe(
        new Date(year, month - 1, 1).toISOString(),
      ),
    );
    expect(listUrls.at(-1)!.searchParams.get("uploadedBefore")).toBe(
      new Date(year, month - 1, 2).toISOString(),
    );
    expect(
      screen.getByRole("button", { name: `Upload date: ${dayRangeLabel([first, first])}` }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear dates" }));
    await waitFor(() => expect(listUrls.at(-1)!.searchParams.has("uploadedFrom")).toBe(false));
    expect(screen.getByRole("button", { name: "Upload date: any" })).toBeInTheDocument();
  });

  it("filters by an upload-date preset", async () => {
    const { listUrls } = renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    fireEvent.click(screen.getByRole("button", { name: "Upload date: any" }));
    fireEvent.click(await screen.findByRole("button", { name: "Last 7 days" }));
    const today = todayDate();
    const [year, month, date] = today.split("-").map(Number);
    await waitFor(() =>
      expect(listUrls.at(-1)!.searchParams.get("uploadedFrom")).toBe(
        new Date(year, month - 1, date - 6).toISOString(),
      ),
    );
    expect(listUrls.at(-1)!.searchParams.get("uploadedBefore")).toBe(
      new Date(year, month - 1, date + 1).toISOString(),
    );
  });

  it("filters by filename and direct tags, including clicking a tag pill", async () => {
    renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    const searchbox = screen.getByRole("searchbox", { name: "Search attachments" });
    fireEvent.change(searchbox, { target: { value: "SHA" } });
    expect(cardNames()).toEqual(["shared.png"]);

    fireEvent.change(searchbox, { target: { value: "#y2k" } });
    expect(cardNames()).toEqual(["shared.png"]);

    fireEvent.change(searchbox, { target: { value: "design" } });
    expect(cardNames()).toEqual(["diagram.png"]);

    fireEvent.change(searchbox, { target: { value: "" } });
    const info = screen.getByRole("complementary", { name: "Attachment info" });
    fireEvent.click(within(info).getByRole("button", { name: "#architecture" }));
    expect(searchbox).toHaveValue("#architecture");
    expect(cardNames()).toEqual(["diagram.png"]);

    fireEvent.change(searchbox, { target: { value: "nothing" } });
    expect(screen.getByText("No attachments match.")).toBeInTheDocument();
  });

  it("adds and removes direct image tags in the Attachment info sidebar", async () => {
    const { patchedTags } = renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    const info = screen.getByRole("complementary", { name: "Attachment info" });
    const tagsSection = within(info).getByRole("region", { name: "Tags" });
    expect(within(tagsSection).getByText("#architecture")).toBeInTheDocument();
    expect(within(tagsSection).getByText("#Design")).toBeInTheDocument();

    const input = within(tagsSection).getByRole("textbox", { name: "Add image tag" });
    fireEvent.change(input, { target: { value: "Cybercore" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(patchedTags).toEqual([{ id: "img-a", tags: ["architecture", "Cybercore", "Design"] }]),
    );
    expect(within(tagsSection).getByText("#Cybercore")).toBeInTheDocument();

    fireEvent.click(within(tagsSection).getByRole("button", { name: "Remove tag Design" }));
    await waitFor(() =>
      expect(patchedTags.at(-1)).toEqual({ id: "img-a", tags: ["architecture", "Cybercore"] }),
    );
    expect(within(tagsSection).queryByText("#Design")).toBeNull();
    // Removing a pill returns keyboard focus to the tag input.
    expect(document.activeElement).toBe(input);
  });

  it("serializes rapid add-then-remove saves so Drive never keeps a removed tag", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: string[][] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    server.use(
      http.patch("/api/attachments/img-a/tags", async ({ request }) => {
        const body = (await request.json()) as { tags: string[] };
        requests.push(body.tags);
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        if (requests.length === 1) {
          await firstGate;
        }
        inFlight -= 1;
        return HttpResponse.json({
          ...ATTACHMENTS[0],
          tags: body.tags,
        });
      }),
    );

    const info = screen.getByRole("complementary", { name: "Attachment info" });
    const tagsSection = within(info).getByRole("region", { name: "Tags" });
    const input = within(tagsSection).getByRole("textbox", { name: "Add image tag" });

    // Add "Temp", then immediately remove it before the first PATCH completes.
    fireEvent.change(input, { target: { value: "Temp" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(within(tagsSection).getByText("#Temp")).toBeInTheDocument();

    fireEvent.click(within(tagsSection).getByRole("button", { name: "Remove tag Temp" }));
    await waitFor(() => expect(within(tagsSection).queryByText("#Temp")).toBeNull());
    // Second request must wait for the first scoped mutation to finish.
    expect(requests).toHaveLength(1);

    releaseFirst();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(maxConcurrent).toBe(1);
    expect(requests).toEqual([
      ["architecture", "Design", "Temp"],
      ["architecture", "Design"],
    ]);
    expect(within(tagsSection).queryByText("#Temp")).toBeNull();
  });

  it("pre-selects a focused attachment in the Attachment info sidebar", async () => {
    renderPanel({ focusAttachment: { id: "img-c", key: 1 } });
    await screen.findByRole("list", { name: "Attachment list" });
    const info = screen.getByRole("complementary", { name: "Attachment info" });
    expect(within(info).getByRole("heading", { name: "shared.png" })).toBeInTheDocument();
    expect(within(info).getByText("#Y2K aesthetic")).toBeInTheDocument();
  });

  it("copies the image Markdown from the copy menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });
    fireEvent.click(screen.getByRole("button", { name: "Copy orphan.png" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy Markdown" }));
    expect(writeText).toHaveBeenCalledWith("![orphan.png](/api/files/img-b/blob)");
    expect(await screen.findByText("Copied Markdown.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Markdown" })).toBeNull();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the original image as a PNG clipboard item", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    server.use(
      http.get(
        "/api/files/img-b/blob",
        () => new HttpResponse(png, { headers: { "content-type": "image/png" } }),
      ),
    );
    const items: Record<string, Promise<Blob>>[] = [];
    class FakeClipboardItem {
      constructor(data: Record<string, Promise<Blob>>) {
        items.push(data);
      }
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    try {
      renderPanel();
      await screen.findByRole("list", { name: "Attachment list" });
      fireEvent.click(screen.getByRole("button", { name: "Copy orphan.png" }));
      fireEvent.click(await screen.findByRole("button", { name: "Copy image" }));
      expect(write).toHaveBeenCalledTimes(1);
      const blob = await items[0]["image/png"];
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
      expect(await screen.findByText("Copied image.")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("warns about referencing notes, trashes the file and drops it from the list", async () => {
    const { deleted } = renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });

    fireEvent.click(screen.getByRole("button", { name: "Delete shared.png" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete image" });
    const warning = within(dialog).getByRole("note", { name: "Still referenced" });
    expect(warning).toHaveTextContent("2 notes still show this image");
    expect(
      within(warning)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Plan", "Notes"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleted).toEqual(["img-c"]);
    expect(cardNames()).toEqual(["diagram.png", "orphan.png"]);
    expect(screen.getByRole("status")).toHaveTextContent("Moved “shared.png” to Drive Trash.");
  });

  it("deletes an unused image without a warning", async () => {
    const { deleted } = renderPanel();
    await screen.findByRole("list", { name: "Attachment list" });
    fireEvent.click(screen.getByRole("button", { name: "Delete orphan.png" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete image" });
    expect(within(dialog).queryByRole("note")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(deleted).toEqual(["img-b"]));
  });

  it("disables delete when read-only", async () => {
    renderPanel({ readOnly: true });
    await screen.findByRole("list", { name: "Attachment list" });
    expect(screen.getByRole("button", { name: "Delete orphan.png" })).toBeDisabled();
  });

  it("shows an empty state", async () => {
    server.use(
      http.get("/api/attachments", () => HttpResponse.json({ folderId: null, attachments: [] })),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AttachmentsPanel
          docs={[]}
          vaultPinned
          offline={false}
          readOnly={false}
          onOpenNote={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/No attachments yet/)).toBeInTheDocument();
  });
});

describe("attachment helpers", () => {
  it("formats sizes and escapes Markdown alt text", () => {
    expect(formatBytes(undefined)).toBeNull();
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
    expect(attachmentMarkdown({ name: "a [b].png", url: "/api/files/x/blob" })).toBe(
      "![a \\[b\\].png](/api/files/x/blob)",
    );
  });
});
