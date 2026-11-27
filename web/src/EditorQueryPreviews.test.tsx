import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DriveNode } from "./api";
import { Editor } from "./components/Editor";
import { type PkmApi, PkmContext } from "./pkm";
import { SyncQueue, SyncQueueContext } from "./syncQueue";
import { childrenKey } from "./treeCache";

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

    const { shadow, view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      expect(shadow.querySelector('input[aria-label="Self task"]')).not.toBeNull();
      expect(shadow.querySelector('input[aria-label="Other task"]')).not.toBeNull();
    });

    // Toggling a task in the currently open note uses the live unsaved draft (preserving "Unsaved paragraph").
    const selfCheckbox = shadow.querySelector<HTMLInputElement>('input[aria-label="Self task"]')!;
    fireEvent.click(selfCheckbox);
    expect(onToggleTask).toHaveBeenCalledWith(
      unsavedSelf.replace("- [ ] Self task", "- [x] Self task"),
    );
    expect(enqueueSave).not.toHaveBeenCalled();

    // Toggling a task in another note saves through SyncQueue.
    const otherCheckbox = shadow.querySelector<HTMLInputElement>('input[aria-label="Other task"]')!;
    fireEvent.click(otherCheckbox);
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

    const { shadow, view } = getShadowView(getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    });

    await waitFor(() => {
      const cb = shadow.querySelector<HTMLInputElement>('input[aria-label="Read only task"]');
      expect(cb).not.toBeNull();
      expect(cb?.disabled).toBe(true);
    });
    fireEvent.click(shadow.querySelector<HTMLInputElement>('input[aria-label="Read only task"]')!);
    expect(enqueueSave).not.toHaveBeenCalled();
    unmount();

    // Standalone <Editor /> without QueryClientProvider falls back to empty docs instead of "Running query…".
    const standalone = render(<Editor initialText={doc} onChange={vi.fn()} />);
    const standaloneView = getShadowView(standalone.getByTestId("editor-host"));
    act(() => {
      ensureSyntaxTree(standaloneView.view.state, standaloneView.view.state.doc.length, 5_000);
    });
    expect(standaloneView.shadow.querySelector(".cm-query-empty")?.textContent).toBe(
      "No matching tasks.",
    );
  });
});
