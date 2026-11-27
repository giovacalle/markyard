import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DriveNode } from "./api";
import { Preview } from "./components/Preview";
import { type PkmApi, PkmContext } from "./pkm";
import { SyncQueue, SyncQueueContext } from "./syncQueue";
import { childrenKey } from "./treeCache";

interface FixtureNote {
  id: string;
  name: string;
  folderId: string;
  path: string[];
  modifiedTime: string;
  text?: string;
}

function setupVault(
  notes: FixtureNote[],
  folders: { id: string; name: string; parentId: string }[] = [],
) {
  const queryClient = new QueryClient();
  const root: DriveNode = {
    id: "root",
    name: "Vault",
    kind: "folder",
    modifiedTime: "2026-11-27T00:00:00Z",
  };
  queryClient.setQueryData(["root"], root);

  const byParent = new Map<string, DriveNode[]>();
  const addChild = (parentId: string, node: DriveNode) => {
    const list = byParent.get(parentId) ?? [];
    list.push(node);
    byParent.set(parentId, list);
  };

  for (const folder of folders) {
    addChild(folder.parentId, {
      id: folder.id,
      name: folder.name,
      kind: "folder",
      modifiedTime: "2026-11-27T00:00:00Z",
    });
  }

  for (const note of notes) {
    addChild(note.folderId, {
      id: note.id,
      name: note.name,
      kind: "markdown",
      modifiedTime: note.modifiedTime,
    });
    if (note.text !== undefined) {
      queryClient.setQueryData(["files", note.id, "content"], {
        text: note.text,
        revision: `rev-${note.id}`,
      });
    }
  }

  for (const [parentId, children] of byParent) {
    queryClient.setQueryData(childrenKey(parentId), children);
  }

  const openNote = vi.fn();
  const pkm: PkmApi = {
    notes: notes.map((n) => ({
      id: n.id,
      name: n.name,
      path: n.path,
      folderId: n.folderId,
      modifiedTime: n.modifiedTime,
    })),
    currentFileId: null,
    vaultPinned: false,
    openNote,
    createNote: vi.fn(),
    loadTemplates: vi.fn(async () => []),
  };

  const syncQueue = new SyncQueue(queryClient);
  const enqueueSave = vi.spyOn(syncQueue, "enqueueSave").mockImplementation(() => {});

  return { queryClient, pkm, openNote, syncQueue, enqueueSave };
}

const FIXTURE_FOLDERS = [{ id: "f-proj", name: "Projects", parentId: "root" }];

const FIXTURE_NOTES: FixtureNote[] = [
  {
    id: "n-alpha",
    name: "Alpha.md",
    folderId: "f-proj",
    path: ["Projects"],
    modifiedTime: "2026-11-27T10:00:00Z",
    text: [
      "---",
      "status: active",
      "priority: 1",
      "tags: [work, q4]",
      "---",
      "",
      "# Alpha",
      "- [ ] Ship release @2026-12-01",
      "- [x] Draft spec",
    ].join("\n"),
  },
  {
    id: "n-beta",
    name: "Beta.md",
    folderId: "f-proj",
    path: ["Projects"],
    modifiedTime: "2026-11-26T10:00:00Z",
    text: ["---", "status: active", "priority: 2", "---", "", "# Beta", "- [ ] Review PR"].join(
      "\n",
    ),
  },
  {
    id: "n-uncached",
    name: "RemoteOnly.md",
    folderId: "root",
    path: [],
    modifiedTime: "2026-11-20T10:00:00Z",
    // Intentionally not cached locally
  },
];

function renderWithVault(markdown: string) {
  const ctx = setupVault(FIXTURE_NOTES, FIXTURE_FOLDERS);
  const view = render(
    <QueryClientProvider client={ctx.queryClient}>
      <SyncQueueContext.Provider value={ctx.syncQueue}>
        <PkmContext.Provider value={ctx.pkm}>
          <Preview text={markdown} />
        </PkmContext.Provider>
      </SyncQueueContext.Provider>
    </QueryClientProvider>,
  );
  return { ...ctx, ...view };
}

describe("QueryBlock via Preview", () => {
  it("renders list view with clickable note links, folder subtitles, quiet cache footer, and zero inline styles", async () => {
    const md = "```query\nfrom: Projects\nwhere: status = active\nsort: priority asc\n```\n";
    const { openNote, container } = renderWithVault(md);

    const alphaLink = await screen.findByRole("link", { name: "Alpha" });
    expect(screen.getByRole("link", { name: "Beta" })).toBeInTheDocument();
    expect(screen.getAllByText("Projects")).toHaveLength(2);
    expect(screen.getByText("2 results · 2 of 3 notes cached")).toBeInTheDocument();
    expect(screen.queryByText(/pin vault offline/i)).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();

    fireEvent.click(alphaLink);
    expect(openNote).toHaveBeenCalledWith("n-alpha");
  });

  it("renders table view with clickable title column, tags, formatted modified date, and em-dash for missing values", async () => {
    const md =
      "```query\nfrom: Projects\nsort: priority asc\nview: table(title, status, tags, modified, owner)\n```\n";
    const { openNote, container } = renderWithVault(md);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2 rows

    const firstRow = rows[1];
    expect(within(firstRow).getByRole("link", { name: "Alpha" })).toBeInTheDocument();
    expect(within(firstRow).getByText("active")).toBeInTheDocument();
    expect(within(firstRow).getByText("#work")).toBeInTheDocument();
    expect(within(firstRow).getByText("#q4")).toBeInTheDocument();
    expect(within(firstRow).getByText("2026-11-27")).toBeInTheDocument();
    expect(within(firstRow).getByText("—")).toBeInTheDocument();

    fireEvent.click(within(firstRow).getByRole("link", { name: "Alpha" }));
    expect(openNote).toHaveBeenCalledWith("n-alpha");
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("renders tasks view with ui-sdk checkboxes and toggles tasks live through SyncQueue", async () => {
    const md = "```query\ntype: tasks\nwhere: NOT done\n```\n";
    const { enqueueSave, openNote, container } = renderWithVault(md);

    const checkbox = await screen.findByRole("checkbox", { name: "Ship release @2026-12-01" });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute("data-slot", "checkbox");
    expect(screen.getByText("@2026-12-01")).toBeInTheDocument();

    fireEvent.click(checkbox);

    expect(enqueueSave).toHaveBeenCalledWith(
      "n-alpha",
      FIXTURE_NOTES[0].text!.replace(
        "- [ ] Ship release @2026-12-01",
        "- [x] Ship release @2026-12-01",
      ),
      "rev-n-alpha",
      undefined,
    );

    // Since query filters `NOT done`, optimistic update immediately removes the checked-off task.
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Ship release @2026-12-01" })).toBeNull(),
    );
    expect(screen.getByRole("checkbox", { name: "Review PR" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Beta" }));
    expect(openNote).toHaveBeenCalledWith("n-beta");
    expect(container.querySelector('[style]:not([data-slot="checkbox-input"])')).toBeNull();
  });

  it("renders count view as a clean KPI card", async () => {
    const md = "```query\ntype: tasks\nview: count\n```\n";
    renderWithVault(md);

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("matching tasks")).toBeInTheDocument();
    expect(screen.getByText("3 results · 2 of 3 notes cached")).toBeInTheDocument();
  });

  it("renders a syntax error alert with raw query source without needing vault providers", () => {
    const raw = "select: *\nwhere: status =";
    const { container } = render(<Preview text={`\`\`\`query\n${raw}\n\`\`\`\n`} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Unknown key "select"/);
    expect(within(alert).getByText(/select: \*/)).toBeInTheDocument();
    expect(container.querySelector("[style]")).toBeNull();
  });
});
