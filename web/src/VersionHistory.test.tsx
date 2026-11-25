import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App";
import { VersionHistoryDialog } from "./components/VersionHistoryDialog";
import { setViewPref } from "./viewPrefs";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

afterEach(() => {
  server.resetHandlers();
  history.replaceState(null, "", "/");
  vi.useRealTimers();
});

afterAll(() => {
  server.close();
});

const MODIFIED = "2026-11-01T10:00:00.000Z";
const CURRENT = "# Plan\n\nShip it now.\n";
const OLDER = "# Plan\n\nShip it later.\n";

const REVISIONS = [
  {
    id: "r3",
    modifiedTime: "2026-11-20T09:30:00.000Z",
    size: 22,
    author: "Ada Lovelace",
    keepForever: false,
  },
  { id: "r2", modifiedTime: "2026-11-18T14:00:00.000Z", size: 2_048, keepForever: true },
];

function revisionHandlers(revisions = REVISIONS) {
  const contentCalls: string[] = [];
  server.use(
    http.get("/api/files/:id/revisions", () => HttpResponse.json({ revisions })),
    http.get("/api/files/:id/revisions/:rev", ({ params }) => {
      contentCalls.push(String(params.rev));
      const text = params.rev === "r3" ? CURRENT : OLDER;
      return new HttpResponse(new TextEncoder().encode(text), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }),
  );
  return contentCalls;
}

function openNote() {
  history.replaceState(null, "", "/?file=doc-id");
  const puts: { ifMatch: string | null; body: string }[] = [];
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
        new HttpResponse(CURRENT, {
          headers: { "Content-Type": "application/octet-stream", ETag: '"etag-1"' },
        }),
    ),
    http.put("/api/files/:id/content", async ({ request }) => {
      puts.push({ ifMatch: request.headers.get("If-Match"), body: await request.text() });
      return new HttpResponse(null, { status: 204, headers: { ETag: '"etag-2"' } });
    }),
  );
  render(<App />);
  return puts;
}

describe("Version history", () => {
  it("lists revisions, previews a diff against the current text, and restores through the sync queue", async () => {
    const contentCalls = revisionHandlers();
    const puts = openNote();
    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { name: "Plan" });

    fireEvent.click(within(preview).getByRole("button", { name: "Version history" }));
    const dialog = await screen.findByRole("dialog", { name: "Version history" });

    const list = await within(dialog).findByRole("listbox", { name: "Revisions" });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Current");
    expect(options[0]).toHaveTextContent("Ada Lovelace");
    expect(options[0]).toHaveTextContent("22 B");
    expect(options[1]).toHaveTextContent("2.0 KB");
    expect(options[1]).toHaveTextContent("Kept forever");

    // The newest revision is selected first and matches the note: nothing to restore.
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(
      await within(dialog).findByText("This version matches the current note."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Restore this version" })).toBeDisabled();

    fireEvent.click(options[1]);
    const diffHost = await within(dialog).findByTestId("revision-diff-host");
    await waitFor(() => expect(diffHost.shadowRoot?.textContent).toContain("Ship it later."));
    expect(diffHost.shadowRoot?.textContent).toContain("Ship it now.");

    const viewGroup = within(dialog).getByRole("radiogroup", { name: "View" });
    fireEvent.click(within(viewGroup).getByRole("radio", { name: "Raw text" }));
    expect(within(dialog).getByTestId("revision-raw")).toHaveTextContent("Ship it later.");

    // Going back to a revision already fetched does not refetch it.
    fireEvent.click(options[0]);
    fireEvent.click(options[1]);
    expect(contentCalls).toEqual(["r3", "r2"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore this version" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/^Restored revision from /)).toBeInTheDocument();
    expect(await within(preview).findByText("Ship it later.")).toBeInTheDocument();
    await waitFor(() => expect(puts).toEqual([{ ifMatch: '"etag-1"', body: OLDER }]));
  });

  it("opens from the command palette for the active note", async () => {
    revisionHandlers();
    openNote();
    const preview = await screen.findByRole("region", { name: "Preview" });
    await within(preview).findByRole("heading", { name: "Plan" });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const palette = await screen.findByRole("dialog");
    fireEvent.change(within(palette).getByRole("combobox"), {
      target: { value: ">version history" },
    });
    fireEvent.click(await within(palette).findByRole("option", { name: /Version history/ }));

    expect(await screen.findByRole("dialog", { name: "Version history" })).toBeInTheDocument();
  });
});

function renderDialog(props: Partial<Parameters<typeof VersionHistoryDialog>[0]> = {}) {
  const onRestore = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VersionHistoryDialog
        fileId="doc-id"
        fileName="plan.md"
        currentText={CURRENT}
        readOnly={false}
        offline={false}
        onRestore={onRestore}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onRestore, onClose, dialog: screen.getByRole("dialog", { name: "Version history" }) };
}

describe("VersionHistoryDialog states", () => {
  it("shows a loading state, then an empty state", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/files/:id/revisions", async () => {
        await gate;
        return HttpResponse.json({ revisions: [] });
      }),
    );
    const { dialog } = renderDialog();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading versions…");
    await act(async () => release());
    expect(
      await within(dialog).findByText("Drive has no stored versions of this note yet."),
    ).toBeInTheDocument();
  });

  it("explains a failed listing and retries", async () => {
    let calls = 0;
    server.use(
      http.get("/api/files/:id/revisions", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: "upstream_error", message: "Drive down" }, { status: 502 })
          : HttpResponse.json({ revisions: [] });
      }),
    );
    const { dialog } = renderDialog();
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Unable to load the version history.");
    expect(alert).toHaveTextContent("HTTP 502 upstream_error");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(
      await within(dialog).findByText("Drive has no stored versions of this note yet."),
    ).toBeInTheDocument();
  });

  it("needs a connection while offline and makes no request", () => {
    const { dialog } = renderDialog({ offline: true });
    expect(within(dialog).getByText(/Version history needs a connection/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("picks revisions from a ui-sdk Listbox with clamped arrows, Home and End", async () => {
    revisionHandlers([
      ...REVISIONS,
      { id: "r1", modifiedTime: "2026-11-10T08:00:00.000Z", size: 10, keepForever: false },
    ]);
    const { dialog, onClose } = renderDialog();
    const list = await within(dialog).findByRole("listbox", { name: "Revisions" });
    expect(list).toHaveAttribute("data-slot", "listbox");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    act(() => options[0].focus());
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveFocus();

    fireEvent.keyDown(options[1], { key: "End" });
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(options[2]).toHaveFocus();

    // The ends clamp: no wrap back to the newest revision.
    fireEvent.keyDown(options[2], { key: "ArrowDown" });
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).not.toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(options[2], { key: "Home" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(options[0], { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    // Escape on the list still reaches the dialog.
    fireEvent.keyDown(options[0], { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("disables restore in read-only mode", async () => {
    revisionHandlers();
    const { dialog, onRestore } = renderDialog({ readOnly: true });
    const options = await within(dialog).findAllByRole("option");
    fireEvent.click(options[1]);
    await within(dialog).findByTestId("revision-diff-host");
    const restore = within(dialog).getByRole("button", { name: "Restore this version" });
    expect(restore).toBeDisabled();
    expect(within(dialog).getByText(/Unlock the note to restore/)).toBeInTheDocument();
    fireEvent.click(restore);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("explains a revision that is not UTF-8 text", async () => {
    server.use(
      http.get("/api/files/:id/revisions", () => HttpResponse.json({ revisions: REVISIONS })),
      http.get(
        "/api/files/:id/revisions/:rev",
        () => new HttpResponse(new Uint8Array([0xff, 0xfe]), { status: 200 }),
      ),
    );
    const { dialog } = renderDialog();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This version is not valid UTF-8 text",
    );
  });
});

describe("Version history with read-only notes", () => {
  it("keeps the header button available while read-only", async () => {
    setViewPref("readOnly", true);
    revisionHandlers();
    openNote();
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(await within(preview).findByRole("button", { name: "Version history" })).toBeEnabled();
  });
});
