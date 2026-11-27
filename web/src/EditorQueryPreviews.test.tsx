import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DriveNode } from "./api";
import { Editor, type EditorHandle } from "./components/Editor";
import { parseFrontmatter } from "./frontmatter";
import { type PkmApi, PkmContext } from "./pkm";
import { SyncQueue, SyncQueueContext } from "./syncQueue";
import { childrenKey } from "./treeCache";

const readVaultDocumentsSpy = vi.hoisted(() => vi.fn());
vi.mock("./vaultDocuments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vaultDocuments")>();
  return {
    ...actual,
    readVaultDocuments: (...args: Parameters<typeof actual.readVaultDocuments>) => {
      readVaultDocumentsSpy(...args);
      return actual.readVaultDocuments(...args);
    },
  };
});

function setupEditorVault(notes: { id: string; name: string; text: string }[], currentId: string) {
  const queryClient = new QueryClient();
  const root: DriveNode = {
    id: "root",
    name: "Vault",
    kind: "folder",
    modifiedTime: "2026-11-27T00:00:00Z",
  };
  queryClient.setQueryData(["root"], root);
  queryClient.setQueryData(
    childrenKey("root"),
    notes.map<DriveNode>((n) => ({
      id: n.id,
      name: n.name,
      kind: "markdown",
      modifiedTime: "2026-11-27T10:00:00Z",
    })),
  );
  for (const n of notes) {
    queryClient.setQueryData(["files", n.id, "content"], {
      text: n.text,
      revision: `rev-${n.id}`,
    });
  }

  const openNote = vi.fn();
  const pkm: PkmApi = {
    notes: notes.map((n) => ({
      id: n.id,
      name: n.name,
      path: [],
      folderId: "root",
      modifiedTime: "2026-11-27T10:00:00Z",
    })),
    currentFileId: currentId,
    vaultPinned: false,
    openNote,
    createNote: vi.fn(),
    loadTemplates: vi.fn(async () => []),
  };

  const syncQueue = new SyncQueue(queryClient);
  const enqueueSave = vi.spyOn(syncQueue, "enqueueSave").mockImplementation(() => {});
  return { queryClient, pkm, openNote, syncQueue, enqueueSave };
}

function getShadowView(host: HTMLElement): { shadow: ShadowRoot; view: EditorView } {
  const shadow = host.shadowRoot;
  if (!shadow) throw new Error("Missing shadow root");
  const textbox = shadow.querySelector<HTMLElement>('[role="textbox"]');
  const view = textbox ? EditorView.findFromDOM(textbox) : null;
  if (!view) throw new Error("Missing EditorView");
  return { shadow, view };
}

describe("Editor inline query previews integration", () => {
  it("hydrates query widgets, routes self-note toggles through onToggleTask with live unsaved draft, and saves other-note toggles through SyncQueue", async () => {
    const savedSelf = "# Self\n\n- [ ] Self task\n\n```query\ntype: tasks\nwhere: NOT done\n```\n";
    const unsavedSelf =
      "# Self\n\nUnsaved paragraph\n\n- [ ] Self task\n\n```query\ntype: tasks\nwhere: NOT done\n```\n";
    const otherText = "# Other\n\n- [ ] Other task\n";

    const { queryClient, pkm, syncQueue, enqueueSave } = setupEditorVault(
      [
        { id: "n-self", name: "Self.md", text: savedSelf },
        { id: "n-other", name: "Other.md", text: otherText },
      ],
      "n-self",
    );

    const onToggleTask = vi.fn();
    let liveDraft = unsavedSelf;

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={unsavedSelf}
              text={unsavedSelf}
              onChange={(next) => {
                liveDraft = next;
              }}
              onToggleTask={onToggleTask}
              getFullText={() => liveDraft}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Self task" })).toBeInTheDocument();
      expect(within(view.dom).getByRole("checkbox", { name: "Other task" })).toBeInTheDocument();
    });

    // Toggling a task in the currently open note uses the live unsaved draft (preserving "Unsaved paragraph").
    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "Self task" }));
    expect(onToggleTask).toHaveBeenCalledWith(
      unsavedSelf.replace("- [ ] Self task", "- [x] Self task"),
    );
    expect(enqueueSave).not.toHaveBeenCalled();

    // Toggling a task in another note saves through SyncQueue.
    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "Other task" }));
    expect(enqueueSave).toHaveBeenCalledWith(
      "n-other",
      otherText.replace("- [ ] Other task", "- [x] Other task"),
      "rev-n-other",
      undefined,
    );
  });

  it("disables checkboxes when onToggleTask is omitted (read-only) and never hangs when QueryClientProvider is absent", async () => {
    const doc = "# Note\n\n```query\ntype: tasks\nwhere: NOT done\n```\n";
    const { queryClient, pkm, syncQueue, enqueueSave } = setupEditorVault(
      [{ id: "n-1", name: "Note.md", text: `${doc}\n- [ ] Read only task\n` }],
      "n-1",
    );

    const { getByTestId, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor initialText={doc} text={doc} onChange={vi.fn()} />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Read only task" })).toBeDisabled();
    });
    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "Read only task" }));
    expect(enqueueSave).not.toHaveBeenCalled();
    unmount();

    // Standalone <Editor /> without QueryClientProvider falls back to empty docs instead of "Running query…".
    const standalone = render(<Editor initialText={doc} onChange={vi.fn()} />);
    const standaloneView = getShadowView(standalone.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(standaloneView.view.state, standaloneView.view.state.doc.length, 5_000);
    });
    expect(within(standaloneView.view.dom).getByText("No matching tasks.")).toBeInTheDocument();
  });

  it("never toggles a different task after the open note is edited outside the query (stale offset)", async () => {
    const text = "- [ ] A\n- [ ] B\n- [ ] C\n\n```query\ntype: tasks\n```\n";
    const { queryClient, pkm, syncQueue, enqueueSave } = setupEditorVault(
      [{ id: "n-abc", name: "ABC.md", text }],
      "n-abc",
    );

    const onToggleTask = vi.fn();
    let live = text;

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={text}
              text={text}
              onChange={(next) => {
                live = next;
              }}
              onToggleTask={onToggleTask}
              getFullText={() => live}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "B" })).toBeInTheDocument();
    });

    // Delete "- [ ] A\n" (8 chars) outside the query block so the widget's cached offsets are stale.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 8 } });
    });

    // Clicking B with the stale offset must write nothing, keep B unchecked, and refresh results.
    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "B" }));
    expect(onToggleTask).not.toHaveBeenCalled();
    expect(enqueueSave).not.toHaveBeenCalled();

    const refreshedB = within(view.dom).getByRole("checkbox", { name: "B" });
    expect(refreshedB).not.toBeChecked();
    expect(within(view.dom).queryByRole("checkbox", { name: "A" })).toBeNull();

    // After the refresh, clicking B toggles B cleanly and immediately shows it checked without waitFor.
    fireEvent.click(refreshedB);
    expect(onToggleTask).toHaveBeenCalledWith("- [x] B\n- [ ] C\n\n```query\ntype: tasks\n```\n");
    expect(enqueueSave).not.toHaveBeenCalled();
    expect(within(view.dom).getByRole("checkbox", { name: "B" })).toBeChecked();
  });

  it("toggles another note from the freshest query cache before the debounced docs reload", async () => {
    const selfText = "# Self\n\n```query\ntype: tasks\n```\n";
    const otherText = "- [ ] X\n- [ ] Y\n";
    const { queryClient, pkm, syncQueue, enqueueSave } = setupEditorVault(
      [
        { id: "n-self", name: "Self.md", text: selfText },
        { id: "n-other", name: "Other.md", text: otherText },
      ],
      "n-self",
    );

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={selfText}
              text={selfText}
              onChange={vi.fn()}
              onToggleTask={vi.fn()}
              getFullText={() => selfText}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Y" })).toBeInTheDocument();
    });

    // Update the cache for n-other (as if another widget or provider just toggled X) before reload.
    act(() => {
      queryClient.setQueryData(["files", "n-other", "content"], {
        text: "- [x] X\n- [ ] Y\n",
        revision: "rev-n-other",
      });
    });

    fireEvent.click(within(view.dom).getByRole("checkbox", { name: "Y" }));
    expect(enqueueSave).toHaveBeenCalledWith(
      "n-other",
      "- [x] X\n- [x] Y\n",
      "rev-n-other",
      undefined,
    );
  });

  it("renders the shared QueryBlock inside the editor shadow root", async () => {
    const doc = "# Self\n\n- [ ] Shared task\n\n```query\ntype: tasks\n```\n";
    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [{ id: "n-self", name: "Self.md", text: doc }],
      "n-self",
    );

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={doc}
              text={doc}
              onChange={vi.fn()}
              onToggleTask={vi.fn()}
              getFullText={() => doc}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { shadow, view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Shared task" })).toBeInTheDocument();
    });

    const widget = shadow.querySelector<HTMLElement>(".cm-query-widget")!;
    expect(within(widget).getByRole("region", { name: "Query results" })).toBeInTheDocument();
    expect(widget.querySelector('section[data-slot="query-block"]')).not.toBeNull();
    expect(widget.querySelector('[data-slot="checkbox"]')).not.toBeNull();
    expect(widget.querySelector('a.wikilink[data-note-id="n-self"]')).not.toBeNull();
    expect(widget.querySelector(".cm-query-task-item")).toBeNull();
    expect(widget.querySelector(".cm-query-list")).toBeNull();
    expect(widget.querySelector('[style]:not([data-slot="checkbox-input"])')).toBeNull();

    // Unfolding into live mode switches the region label to "Query live preview".
    act(() => {
      view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("type: tasks")) });
    });
    expect(
      within(view.dom).getByRole("region", { name: "Query live preview" }),
    ).toBeInTheDocument();
  });

  it("updates open-note results as the live draft changes in the editor and keeps focus on accepted toggle", async () => {
    const text = "- [ ] A\n- [ ] B\n\n```query\ntype: tasks\n```\n";
    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [{ id: "n-live", name: "Live.md", text }],
      "n-live",
    );

    let live = text;
    const onToggleTask = vi.fn((next: string) => {
      live = next;
    });

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={text}
              text={text}
              onChange={(next) => {
                live = next;
              }}
              onToggleTask={onToggleTask}
              getFullText={() => live}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { shadow, view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "B" })).toBeInTheDocument();
    });

    // Focus B, click it -> immediately reads checked without waitFor and keeps shadow.activeElement.
    const checkboxB = within(view.dom).getByRole("checkbox", { name: "B" });
    checkboxB.focus();
    expect(shadow.activeElement).toBe(checkboxB);
    fireEvent.click(checkboxB);
    expect(within(view.dom).getByRole("checkbox", { name: "B" })).toBeChecked();
    expect(shadow.activeElement).toBe(checkboxB);

    // Inserting a new task via view.dispatch updates the widget from the live draft.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "- [ ] D\n" } });
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "D" })).toBeInTheDocument();
    });
  });

  it("updates open-note results when Visual-mode frontmatter changes without a body edit", async () => {
    const body = '# Plan\n\n```query\ntype: notes\nwhere: status = "done"\n```\n';
    const draftText = `---\nstatus: draft\n---\n${body}`;
    const doneText = `---\nstatus: done\n---\n${body}`;
    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [{ id: "n-plan", name: "Plan.md", text: draftText }],
      "n-plan",
    );

    let live = draftText;
    const renderEditor = () => (
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={body}
              text={body}
              frontmatter={parseFrontmatter(live)}
              onChange={vi.fn()}
              onToggleTask={vi.fn()}
              getFullText={() => live}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>
    );

    const { getByTestId, rerender } = render(renderEditor());
    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByText("No matching notes.")).toBeInTheDocument();
    });

    live = doneText;
    rerender(renderEditor());

    await waitFor(() => {
      expect(within(view.dom).getByRole("link", { name: "Plan" })).toBeInTheDocument();
    });
  });

  it("shares one vault-documents subscription across widgets, skips scans when hidden, and keeps docs across fence round-trip", async () => {
    readVaultDocumentsSpy.mockClear();
    const doc = [
      "# Dashboard",
      "",
      "```query",
      "type: notes",
      "```",
      "",
      "```query",
      "type: tasks",
      "```",
      "",
    ].join("\n");

    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [{ id: "n-dash", name: "Dashboard.md", text: `${doc}\n- [ ] Ship\n` }],
      "n-dash",
    );

    // Hidden editor with query blocks makes zero vault scans.
    const hidden = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor initialText={doc} text={doc} active={false} onChange={vi.fn()} />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );
    const hiddenView = getShadowView(hidden.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(hiddenView.view.state, hiddenView.view.state.doc.length, 5_000);
    });
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(0);
    hidden.unmount();

    // Two query blocks mount under one provider -> exactly one scan.
    readVaultDocumentsSpy.mockClear();
    const multi = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor initialText={doc} text={doc} onChange={vi.fn()} />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );
    const multiView = getShadowView(multi.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(multiView.view.state, multiView.view.state.doc.length, 5_000);
    });
    await waitFor(() => {
      expect(
        within(multiView.view.dom).getAllByRole("link", { name: "Dashboard" }).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(1);
    multi.unmount();

    // Closing-fence round-trip: slot drops to 0 while hasQueryFence stays true, then restores with no re-scan or "Running query…" flash.
    const singleDoc = "# One\n\n```query\ntype: notes\n```\n";
    const {
      queryClient: qc2,
      pkm: pkm2,
      syncQueue: sq2,
    } = setupEditorVault([{ id: "n-one", name: "One.md", text: singleDoc }], "n-one");
    readVaultDocumentsSpy.mockClear();
    const rt = render(
      <QueryClientProvider client={qc2}>
        <SyncQueueContext.Provider value={sq2}>
          <PkmContext.Provider value={pkm2}>
            <Editor initialText={singleDoc} text={singleDoc} onChange={vi.fn()} />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );
    const { shadow, view } = getShadowView(rt.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });
    await waitFor(() => {
      expect(within(view.dom).getByRole("link", { name: "One" })).toBeInTheDocument();
    });
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(1);

    const closeStart = view.state.doc.toString().lastIndexOf("```");
    act(() => {
      view.dispatch({
        changes: { from: closeStart, to: closeStart + 3, insert: "" },
        selection: EditorSelection.cursor(0),
      });
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });
    expect(shadow.querySelector(".cm-query-widget")).toBeNull();

    act(() => {
      view.dispatch({
        changes: { from: closeStart, to: closeStart, insert: "```" },
        selection: EditorSelection.cursor(0),
      });
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });
    expect(within(view.dom).queryByText("Running query…")).toBeNull();
    expect(within(view.dom).getByRole("link", { name: "One" })).toBeInTheDocument();
    expect(readVaultDocumentsSpy).toHaveBeenCalledTimes(1);
  });

  it("handles links with and without PkmContext, count view, and collapsed alert vs live status error roles", async () => {
    const notes = [
      { id: "n-alpha", name: "Alpha.md", text: "---\nstatus: active\n---\n- [ ] One\n- [ ] Two\n" },
      { id: "n-beta", name: "Beta.md", text: "- [ ] Three\n" },
    ];
    const { queryClient, pkm, openNote, syncQueue } = setupEditorVault(notes, "n-alpha");

    const countAndList =
      "Top\n\n```query\ntype: tasks\nlimit: 1\nview: count\n```\n\n```query\nview: list\n```\n";
    const { getByTestId, unmount } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor initialText={countAndList} text={countAndList} onChange={vi.fn()} />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );
    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByText("3")).toBeInTheDocument();
      expect(within(view.dom).getByText("matching tasks")).toBeInTheDocument();
    });

    fireEvent.click(within(view.dom).getByRole("link", { name: "Alpha" }));
    expect(openNote).toHaveBeenCalledWith("n-alpha");
    unmount();

    // Without PkmContext, note titles render as plain spans (not links).
    const noPkm = render(
      <QueryClientProvider client={queryClient}>
        <Editor initialText={"Top\n\n```query\nview: list\n```\n"} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const noPkmView = getShadowView(noPkm.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(noPkmView.view.state, noPkmView.view.state.doc.length, 5_000);
    });
    await waitFor(() => {
      expect(within(noPkmView.view.dom).getByText("Alpha")).toBeInTheDocument();
    });
    expect(within(noPkmView.view.dom).queryByRole("link", { name: "Alpha" })).toBeNull();
    noPkm.unmount();

    // Collapsed parse error uses role="alert"; live parse error uses role="status".
    const invalid = "Top\n\n```query\nselect: *\n```\n";
    const errRender = render(
      <QueryClientProvider client={queryClient}>
        <Editor initialText={invalid} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const errView = getShadowView(errRender.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(errView.view.state, errView.view.state.doc.length, 5_000);
    });
    expect(within(errView.view.dom).getByRole("alert")).toHaveTextContent('Unknown key "select"');

    act(() => {
      errView.view.dispatch({ selection: EditorSelection.cursor(invalid.indexOf("select")) });
    });
    expect(within(errView.view.dom).queryByRole("alert")).toBeNull();
    expect(within(errView.view.dom).getByRole("status")).toHaveTextContent('Unknown key "select"');
  });

  it("reuses both the widget node and QueryBlock section across a vault-docs refresh", async () => {
    const selfText = "# Self\n\n```query\ntype: tasks\n```\n";
    const otherText = "- [ ] Initial task\n";
    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [
        { id: "n-self", name: "Self.md", text: selfText },
        { id: "n-other", name: "Other.md", text: otherText },
      ],
      "n-self",
    );

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={selfText}
              text={selfText}
              onChange={vi.fn()}
              onToggleTask={vi.fn()}
              getFullText={() => selfText}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { shadow, view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Initial task" })).toBeInTheDocument();
    });

    const widgetBefore = shadow.querySelector<HTMLElement>(".cm-query-widget");
    const sectionBefore = shadow.querySelector<HTMLElement>('section[data-slot="query-block"]');
    expect(widgetBefore).not.toBeNull();
    expect(sectionBefore).not.toBeNull();

    // Trigger a cache update on another note and wait for the debounced 300ms docs reload.
    act(() => {
      queryClient.setQueryData(["files", "n-other", "content"], {
        text: "- [ ] Updated task\n",
        revision: "rev-n-other-2",
      });
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Updated task" })).toBeInTheDocument();
    });

    expect(shadow.querySelector(".cm-query-widget")).toBe(widgetBefore);
    expect(shadow.querySelector('section[data-slot="query-block"]')).toBe(sectionBefore);
  });

  it("flushes liveDraft synchronously on open-note task toggles so sibling widgets update immediately", async () => {
    const initial = [
      "- [ ] Open task",
      "",
      "```query",
      "type: tasks",
      "```",
      "",
      "```query",
      "type: tasks",
      "where: NOT done",
      "view: count",
      "```",
      "",
      "```query",
      "type: tasks",
      "```",
      "",
    ].join("\n");

    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [{ id: "n-self", name: "Self.md", text: initial }],
      "n-self",
    );

    let live = initial;
    const editorRef: { current: EditorHandle | null } = { current: null };
    const onToggleTask = vi.fn((next: string) => {
      live = next;
      editorRef.current?.replaceText(next);
    });

    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={initial}
              text={initial}
              editorRef={editorRef}
              onChange={(next) => {
                live = next;
              }}
              onToggleTask={onToggleTask}
              getFullText={() => live}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { shadow, view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getAllByRole("checkbox", { name: "Open task" })).toHaveLength(2);
      expect(shadow.querySelector(".query-block-count-value")?.textContent).toBe("1");
    });

    // Toggle in widget 0: sibling count widget and sibling tasks widget must update synchronously (no waitFor).
    fireEvent.click(within(view.dom).getAllByRole("checkbox", { name: "Open task" })[0]);
    expect(shadow.querySelector(".query-block-count-value")?.textContent).toBe("0");
    expect(within(view.dom).getAllByRole("checkbox", { name: "Open task" })[1]).toBeChecked();

    // Toggling back immediately in sibling widget 2 must succeed without hitting the stale-offset guard.
    fireEvent.click(within(view.dom).getAllByRole("checkbox", { name: "Open task" })[1]);
    expect(onToggleTask).toHaveBeenCalledTimes(2);
    expect(onToggleTask).toHaveBeenLastCalledWith(initial);
    expect(shadow.querySelector(".query-block-count-value")?.textContent).toBe("1");
    expect(within(view.dom).getAllByRole("checkbox", { name: "Open task" })[0]).not.toBeChecked();
  });

  it("flushes liveDraft synchronously when a hidden editor becomes active again", async () => {
    const unchecked = "# Note\n\n- [ ] Toggle me\n\n```query\ntype: tasks\n```\n";
    const checked = "# Note\n\n- [x] Toggle me\n\n```query\ntype: tasks\n```\n";
    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [{ id: "n-self", name: "Note.md", text: unchecked }],
      "n-self",
    );

    let live = unchecked;
    let active = true;
    const renderEditor = () => (
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={unchecked}
              text={live}
              active={active}
              onChange={vi.fn()}
              onToggleTask={vi.fn()}
              getFullText={() => live}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>
    );

    const { getByTestId, rerender } = render(renderEditor());
    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Toggle me" })).not.toBeChecked();
    });

    // Switch to Preview (hidden editor), toggle the task there, then switch back to Edit.
    active = false;
    rerender(renderEditor());
    live = checked;
    rerender(renderEditor());

    active = true;
    rerender(renderEditor());

    // Immediately reflects the Preview toggle without waiting for LIVE_DRAFT_DEBOUNCE_MS.
    expect(within(view.dom).getByRole("checkbox", { name: "Toggle me" })).toBeChecked();
  });

  it("keeps the same collapsed error alert DOM node across vault-docs refreshes and edits outside the block", async () => {
    const selfText = "Top\n\n```query\nselect: *\n```\n\n```query\ntype: tasks\n```\n";
    const otherText = "- [ ] Initial\n";
    const { queryClient, pkm, syncQueue } = setupEditorVault(
      [
        { id: "n-self", name: "Self.md", text: selfText },
        { id: "n-other", name: "Other.md", text: otherText },
      ],
      "n-self",
    );

    let live = selfText;
    const { getByTestId } = render(
      <QueryClientProvider client={queryClient}>
        <SyncQueueContext.Provider value={syncQueue}>
          <PkmContext.Provider value={pkm}>
            <Editor
              initialText={selfText}
              text={selfText}
              onChange={(next) => {
                live = next;
              }}
              onToggleTask={vi.fn()}
              getFullText={() => live}
            />
          </PkmContext.Provider>
        </SyncQueueContext.Provider>
      </QueryClientProvider>,
    );

    const { view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Initial" })).toBeInTheDocument();
    });
    const alertBefore = within(view.dom).getByRole("alert");
    expect(alertBefore).toHaveTextContent('Unknown key "select"');

    // Unrelated vault-docs refresh (300ms reload) must keep the exact same alert DOM node.
    act(() => {
      queryClient.setQueryData(["files", "n-other", "content"], {
        text: "- [ ] Changed\n",
        revision: "rev-n-other-2",
      });
    });
    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Changed" })).toBeInTheDocument();
    });
    expect(within(view.dom).getByRole("alert")).toBe(alertBefore);

    // Typing outside the folded error block (and its live-draft refresh) also keeps the same alert node.
    act(() => {
      view.dispatch({ changes: { from: 0, to: 0, insert: "- [ ] Typed\n" } });
    });
    await waitFor(() => {
      expect(within(view.dom).getByRole("checkbox", { name: "Typed" })).toBeInTheDocument();
    });
    expect(within(view.dom).getByRole("alert")).toBe(alertBefore);
  });
});
