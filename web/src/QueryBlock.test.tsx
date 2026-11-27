import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DriveNode } from "./api";
import { Preview } from "./components/Preview";
import { type PkmApi, PkmContext } from "./pkm";
import { SyncQueue, SyncQueueContext } from "./syncQueue";
import { childrenKey } from "./treeCache";

const readVaultDocumentsSpy = vi.hoisted(() => vi.fn());
vi.mock("./vaultDocuments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vaultDocuments")>();
  return {
    ...actual,
    readVaultDocuments: (...args: Parameters<typeof actual.readVaultDocuments>) => {
      const result = actual.readVaultDocuments(...args);
      readVaultDocumentsSpy(result);
      return result;
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

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

function renderWithVault(
  markdown: string,
  options?: {
    onToggleTask?: (nextText: string) => void;
    currentFileId?: string | null;
  },
) {
  const ctx = setupVault(FIXTURE_NOTES, FIXTURE_FOLDERS);
  if (options?.currentFileId !== undefined) {
    ctx.pkm.currentFileId = options.currentFileId;
  }
  const view = render(
    <QueryClientProvider client={ctx.queryClient}>
      <SyncQueueContext.Provider value={ctx.syncQueue}>
        <PkmContext.Provider value={ctx.pkm}>
          <Preview text={markdown} onToggleTask={options?.onToggleTask} />
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

  it("renders aliased table column headers while preserving title links, tag pills, and formatted dates", async () => {
    const md =
      '```query\nfrom: Projects\nsort: priority asc\nview: table(title as "Project", status as Status, tags as \'Labels\', modified as "Updated", owner as "Owner, Lead")\n```\n';
    const { openNote, container } = renderWithVault(md);

    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((th) => th.textContent)).toEqual([
      "Project",
      "Status",
      "Labels",
      "Updated",
      "Owner, Lead",
    ]);

    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);

    const firstRow = rows[1];
    const alphaLink = within(firstRow).getByRole("link", { name: "Alpha" });
    expect(alphaLink).toBeInTheDocument();
    expect(within(firstRow).getByText("active")).toBeInTheDocument();
    expect(within(firstRow).getByText("#work")).toBeInTheDocument();
    expect(within(firstRow).getByText("#q4")).toBeInTheDocument();
    expect(within(firstRow).getByText("2026-11-27")).toBeInTheDocument();
    expect(within(firstRow).getByText("—")).toBeInTheDocument();

    fireEvent.click(alphaLink);
    expect(openNote).toHaveBeenCalledWith("n-alpha");
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("renders tasks view with ui-sdk checkboxes and toggles tasks live through SyncQueue", async () => {
    const md = "```query\ntype: tasks\nwhere: NOT done\n```\n";
    const onToggleTask = vi.fn();
    const { enqueueSave, openNote, container } = renderWithVault(md, { onToggleTask });

    const queryRegion = await screen.findByRole("region", { name: "Query results" });
    const checkbox = await within(queryRegion).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute("data-slot", "checkbox");
    expect(within(queryRegion).getByText("@2026-12-01")).toBeInTheDocument();

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
    expect(onToggleTask).not.toHaveBeenCalled();

    // Since query filters `NOT done`, optimistic update immediately removes the checked-off task.
    await waitFor(() =>
      expect(
        within(queryRegion).queryByRole("checkbox", { name: "Ship release @2026-12-01" }),
      ).toBeNull(),
    );
    expect(within(queryRegion).getByRole("checkbox", { name: "Review PR" })).toBeInTheDocument();

    fireEvent.click(within(queryRegion).getByRole("link", { name: "Beta" }));
    expect(openNote).toHaveBeenCalledWith("n-beta");
    expect(container.querySelector('[style]:not([data-slot="checkbox-input"])')).toBeNull();
  });

  it("routes task toggles for the currently open note through onToggleTask and disables checkboxes in read-only mode", async () => {
    const md = `${FIXTURE_NOTES[0].text!}\n\n\`\`\`query\ntype: tasks\nwhere: NOT done\n\`\`\`\n`;
    const onToggleTask = vi.fn();
    const { enqueueSave, unmount } = renderWithVault(md, {
      onToggleTask,
      currentFileId: "n-alpha",
    });

    const queryRegion = await screen.findByRole("region", { name: "Query results" });
    const checkbox = await within(queryRegion).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    fireEvent.click(checkbox);

    expect(onToggleTask).toHaveBeenCalledWith(
      md.replace("- [ ] Ship release @2026-12-01", "- [x] Ship release @2026-12-01"),
    );
    expect(enqueueSave).not.toHaveBeenCalled();
    unmount();

    // Read-only mode omits onToggleTask -> checkboxes must be disabled and not mutate notes.
    const readonly = renderWithVault(md);
    const readonlyRegion = await screen.findByRole("region", { name: "Query results" });
    const readonlyCheckbox = await within(readonlyRegion).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    expect(readonlyCheckbox).toBeDisabled();
    fireEvent.click(readonlyCheckbox);
    expect(readonly.enqueueSave).not.toHaveBeenCalled();
  });

  it("renders count view with totalMatched even when limit is set", async () => {
    const md = "```query\ntype: tasks\nlimit: 1\nview: count\n```\n";
    renderWithVault(md);

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("matching tasks")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 notes cached")).toBeInTheDocument();
  });

  it("uses Preview's live open-note text instead of stale vault cache so deleted tasks are not resurrected", async () => {
    const cachedText = "- [ ] A\n- [ ] B\n- [ ] C\n\n```query\ntype: tasks\n```\n";
    const liveText = "- [ ] B\n- [ ] C\n\n```query\ntype: tasks\n```\n";
    const ctx = setupVault([
      {
        id: "n-abc",
        name: "ABC.md",
        folderId: "root",
        path: [],
        modifiedTime: "2026-11-27T10:00:00Z",
        text: cachedText,
      },
    ]);
    ctx.pkm.currentFileId = "n-abc";
    const onToggleTask = vi.fn();

    render(
      <QueryClientProvider client={ctx.queryClient}>
        <SyncQueueContext.Provider value={ctx.syncQueue}>
          <PkmContext.Provider value={ctx.pkm}>
            <Preview text={liveText} onToggleTask={onToggleTask} />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const queryRegion = await screen.findByRole("region", { name: "Query results" });
    const bCheckbox = await within(queryRegion).findByRole("checkbox", { name: "B" });
    fireEvent.click(bCheckbox);

    expect(onToggleTask).toHaveBeenCalledWith("- [x] B\n- [ ] C\n\n```query\ntype: tasks\n```\n");
    expect(ctx.enqueueSave).not.toHaveBeenCalled();
  });

  it("composes sequential toggles across two query blocks via the query cache and preserves focus on accepted toggle", async () => {
    const md =
      "```query\ntype: tasks\nfrom: Projects\n```\n\n```query\ntype: tasks\nfrom: Projects\n```\n";
    const onToggleTask = vi.fn();
    const { queryClient, enqueueSave } = renderWithVault(md, { onToggleTask });
    enqueueSave.mockImplementation((fileId, text, revision) => {
      queryClient.setQueryData(["files", fileId, "content"], { text, revision });
    });

    const regions = await screen.findAllByRole("region", { name: "Query results" });
    expect(regions).toHaveLength(2);
    const ship0 = await within(regions[0]).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    const draft1 = await within(regions[1]).findByRole("checkbox", { name: "Draft spec" });

    // Focus block 0's checkbox before toggling and confirm focus stays on it after accepted toggle.
    ship0.focus();
    expect(document.activeElement).toBe(ship0);
    fireEvent.click(ship0);
    expect(document.activeElement).toBe(ship0);
    expect(ship0).toBeChecked();

    // Toggle a different task in block 1 before the debounced docs reload.
    fireEvent.click(draft1);

    expect(enqueueSave).toHaveBeenCalledTimes(2);
    const expectedSecondText = FIXTURE_NOTES[0]
      .text!.replace("- [ ] Ship release @2026-12-01", "- [x] Ship release @2026-12-01")
      .replace("- [x] Draft spec", "- [ ] Draft spec");
    expect(enqueueSave).toHaveBeenNthCalledWith(
      2,
      "n-alpha",
      expectedSecondText,
      "rev-n-alpha",
      undefined,
    );
  });

  it("rejects a stale toggle on the same task from a second query block and refreshes it from cache", async () => {
    const md =
      "```query\ntype: tasks\nfrom: Projects\n```\n\n```query\ntype: tasks\nfrom: Projects\n```\n";
    const onToggleTask = vi.fn();
    const { queryClient, enqueueSave } = renderWithVault(md, { onToggleTask });
    enqueueSave.mockImplementation((fileId, text, revision) => {
      queryClient.setQueryData(["files", fileId, "content"], { text, revision });
    });

    const regions = await screen.findAllByRole("region", { name: "Query results" });
    expect(regions).toHaveLength(2);
    const ship0 = await within(regions[0]).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    const ship1 = await within(regions[1]).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    expect(ship1).not.toBeChecked();

    fireEvent.click(ship0);
    expect(enqueueSave).toHaveBeenCalledTimes(1);

    // Block 1 still renders "Ship release" as unchecked; clicking it must be rejected and refreshed.
    fireEvent.click(ship1);
    expect(enqueueSave).toHaveBeenCalledTimes(1);
    expect(
      within(regions[1]).getByRole("checkbox", { name: "Ship release @2026-12-01" }),
    ).toBeChecked();
  });

  it("prunes stale display overrides once docs advance so a remote revert shows the reverted state", async () => {
    readVaultDocumentsSpy.mockClear();
    const md = "```query\ntype: tasks\nfrom: Projects\n```\n";
    const onToggleTask = vi.fn();
    const { queryClient, enqueueSave } = renderWithVault(md, { onToggleTask });
    enqueueSave.mockImplementation((fileId, text, revision) => {
      queryClient.setQueryData(["files", fileId, "content"], { text, revision });
    });

    const queryRegion = await screen.findByRole("region", { name: "Query results" });
    const ship = await within(queryRegion).findByRole("checkbox", {
      name: "Ship release @2026-12-01",
    });
    expect(ship).not.toBeChecked();
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(ship);
    expect(enqueueSave).toHaveBeenCalledTimes(1);

    // Wait for the debounced docs reload that picks up the toggled text (evicting the override).
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(2);
    await act(async () => {
      await readVaultDocumentsSpy.mock.calls[1][0];
    });
    expect(
      within(screen.getByRole("region", { name: "Query results" })).getByRole("checkbox", {
        name: "Ship release @2026-12-01",
      }),
    ).toBeChecked();

    // Simulate a remote revert restoring n-alpha to its exact original text.
    act(() => {
      queryClient.setQueryData(["files", "n-alpha", "content"], {
        text: FIXTURE_NOTES[0].text!,
        revision: "rev-n-alpha-reverted",
      });
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(3);
    await act(async () => {
      await readVaultDocumentsSpy.mock.calls[2][0];
    });
    vi.useRealTimers();

    expect(
      within(screen.getByRole("region", { name: "Query results" })).getByRole("checkbox", {
        name: "Ship release @2026-12-01",
      }),
    ).not.toBeChecked();
  });

  describe("inline markdown in task text", () => {
    const MARKUP_NOTES: FixtureNote[] = [
      {
        id: "n-todo",
        name: "Todo.md",
        folderId: "root",
        path: [],
        modifiedTime: "2026-11-27T10:00:00Z",
        text: [
          "- [ ] **Close account** with *care*, `rm -rf`, [[Target]] and <b>raw</b>",
          "- [ ] 2. Call Bob",
          "- [ ] > quoted",
          "- [ ] Check ![diagram](x.png)",
          "",
        ].join("\n"),
      },
      {
        id: "n-target",
        name: "Target.md",
        folderId: "root",
        path: [],
        modifiedTime: "2026-11-27T10:00:00Z",
        text: "# Target\n",
      },
    ];
    const PLAIN = "Close account with care, rm -rf, Target and raw";

    function renderMarkup(view: string) {
      const ctx = setupVault(MARKUP_NOTES);
      const result = render(
        <QueryClientProvider client={ctx.queryClient}>
          <SyncQueueContext.Provider value={ctx.syncQueue}>
            <PkmContext.Provider value={ctx.pkm}>
              <Preview text={`\`\`\`query\ntype: tasks\nview: ${view}\n\`\`\`\n`} />
            </PkmContext.Provider>
          </SyncQueueContext.Provider>
        </QueryClientProvider>,
      );
      return { ...ctx, ...result };
    }

    async function expectInlineMarkup(cell: HTMLElement, openNote: PkmApi["openNote"]) {
      expect(cell).toHaveTextContent(PLAIN);
      expect(cell.textContent).not.toMatch(/[*`<>]|\[\[/);
      expect(cell.querySelector("strong")).toHaveTextContent("Close account");
      expect(cell.querySelector("em")).toHaveTextContent("care");
      expect(cell.querySelector("code")).toHaveTextContent("rm -rf");
      expect(cell.querySelector("b, p, div")).toBeNull();
      fireEvent.click(within(cell).getByRole("link", { name: "Target" }));
      expect(openNote).toHaveBeenCalledWith("n-target", { heading: undefined });
    }

    it("renders bold, italic, code and wikilinks in table text cells", async () => {
      const { openNote, container } = renderMarkup("table(text)");
      const table = await screen.findByRole("table");
      const cell = within(table).getAllByRole("cell")[0];
      await expectInlineMarkup(cell, openNote);
      expect(container.querySelector("[style]")).toBeNull();
    });

    it("renders inline markdown in the tasks view and keeps a plain-text checkbox name", async () => {
      const { openNote, container } = renderMarkup("tasks");
      const region = await screen.findByRole("region", { name: "Query results" });
      expect(await within(region).findByRole("checkbox", { name: PLAIN })).toBeInTheDocument();
      const text = container.querySelector<HTMLElement>(".query-block-task-text");
      expect(text).not.toBeNull();
      await expectInlineMarkup(text!, openNote);
    });

    it("keeps block markers literal and image alt text, as Preview shows them after a checkbox", async () => {
      renderMarkup("tasks");
      const region = await screen.findByRole("region", { name: "Query results" });
      for (const name of ["2. Call Bob", "> quoted", "Check diagram"]) {
        expect(await within(region).findByRole("checkbox", { name })).toBeInTheDocument();
      }
      expect(region.querySelector("img, ol, ul ul, blockquote")).toBeNull();
    });

    it("renders inline markdown in the task list view", async () => {
      const { openNote, container } = renderMarkup("list");
      await screen.findByRole("region", { name: "Query results" });
      const text = await waitFor(() => {
        const el = container.querySelector<HTMLElement>(".query-block-task-text");
        expect(el).not.toBeNull();
        return el!;
      });
      await expectInlineMarkup(text, openNote);
    });
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
