import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { matchCodeLanguage } from "./editorCodeLanguages";
import { type QueryPreviewSources, queryPreviews, refreshQueryPreviews } from "./queryPreviews";
import type { VaultDocument } from "./vaultDocuments";

const SAMPLE_DOCS: VaultDocument[] = [
  {
    id: "n-alpha",
    name: "Alpha.md",
    path: ["Projects"],
    folderId: "f-proj",
    modifiedTime: "2026-11-27T10:00:00Z",
    revision: "rev-alpha",
    text: "---\nstatus: active\npriority: 1\n---\n\n- [ ] Ship v1 @2026-12-01\n- [x] Draft spec\n",
  },
  {
    id: "n-beta",
    name: "Beta.md",
    path: ["Projects"],
    folderId: "f-proj",
    modifiedTime: "2026-11-26T10:00:00Z",
    revision: "rev-beta",
    text: "---\nstatus: active\npriority: 2\n---\n\n- [ ] Review PR\n",
  },
];

let activeViews: EditorView[] = [];

afterEach(() => {
  for (const view of activeViews) {
    view.destroy();
  }
  activeViews = [];
});

function mountView(doc: string, cursor: number, sources: QueryPreviewSources): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      yamlFrontmatter({
        content: markdown({ base: markdownLanguage, codeLanguages: matchCodeLanguage }),
      }),
      queryPreviews(sources),
    ],
  });
  const view = new EditorView({ state, parent });
  activeViews.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
  view.dispatch({ effects: refreshQueryPreviews.of(1) });
  return view;
}

describe("queryPreviews inline CodeMirror extension", () => {
  it("folds closed ```query blocks when cursor is outside, reuses DOM while typing above, and unfolds on Edit click", () => {
    const openNote = vi.fn();
    const getDocs = vi.fn(() => SAMPLE_DOCS);
    const doc = [
      "# Dashboard",
      "",
      "```query",
      "from: Projects",
      "sort: priority asc",
      "view: table(title, status)",
      "```",
      "",
      "Footer text",
    ].join("\n");

    const view = mountView(doc, 0, {
      getDocs,
      getTotalNotes: () => 3,
      openNote,
    });

    const widgetBefore = view.dom.querySelector<HTMLElement>(".cm-query-widget");
    expect(widgetBefore).not.toBeNull();
    expect(widgetBefore?.classList.contains("cm-query-widget-live")).toBe(false);
    expect(widgetBefore?.querySelector("table")).not.toBeNull();
    expect(widgetBefore?.textContent).toContain("Alpha");
    expect(widgetBefore?.textContent).toContain("Beta");
    expect(widgetBefore?.textContent).toContain("2 results · 2 of 3 notes cached");
    expect(widgetBefore?.querySelector("[style]")).toBeNull();

    // Typing above the collapsed query block must NOT destroy/recreate the widget DOM or re-query.
    const callsBeforeType = getDocs.mock.calls.length;
    view.dispatch({ changes: { from: 0, to: 0, insert: "Prefix " } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    const widgetAfter = view.dom.querySelector<HTMLElement>(".cm-query-widget");
    expect(widgetAfter).toBe(widgetBefore);
    expect(getDocs.mock.calls.length).toBe(callsBeforeType);

    // Clicking a note link opens the note without unfolding.
    const alphaLink = widgetAfter?.querySelector<HTMLAnchorElement>('a[data-note-id="n-alpha"]');
    expect(alphaLink).not.toBeNull();
    alphaLink?.click();
    expect(openNote).toHaveBeenCalledWith("n-alpha");

    // Clicking "Edit" computes the shifted fence position dynamically and unfolds into live preview.
    const editBtn = widgetAfter?.querySelector<HTMLButtonElement>(".cm-query-edit-btn");
    expect(editBtn).not.toBeNull();
    editBtn?.click();

    const liveWidget = view.dom.querySelector<HTMLElement>(".cm-query-widget-live");
    expect(liveWidget).not.toBeNull();
    expect(liveWidget?.textContent).toContain("Live preview");
    expect(view.contentDOM.textContent).toContain("from: Projects");

    // Live editing inside the YAML updates the live preview immediately.
    const fromIdx = view.state.doc.toString().indexOf("from: Projects");
    view.dispatch({
      changes: { from: fromIdx, to: fromIdx + "from: Projects".length, insert: "limit: 1" },
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    expect(view.dom.querySelector(".cm-query-widget-live")?.textContent).toContain(
      "1 of 2 results",
    );

    // Moving cursor back outside re-folds the block.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(view.dom.querySelector(".cm-query-widget-live")).toBeNull();
    expect(view.dom.querySelector(".cm-query-widget .cm-query-edit-btn")).not.toBeNull();
  });

  it("renders interactive task checkboxes, reverts on failed toggle, and respects canToggleTasks", () => {
    const toggleTask = vi.fn(() => true);
    const doc = ["```query", "type: tasks", "where: NOT done", "```", ""].join("\n");
    const view = mountView(doc, doc.indexOf("where:"), {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
      canToggleTasks: () => true,
      toggleTask,
    });

    const liveWidget = view.dom.querySelector<HTMLElement>(".cm-query-widget-live");
    const checkbox = liveWidget?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.disabled).toBe(false);
    checkbox?.click();
    expect(toggleTask).toHaveBeenCalledWith(
      "n-alpha",
      expect.objectContaining({
        offset: expect.any(Number),
        text: "Ship v1 @2026-12-01",
        done: false,
      }),
    );

    // When toggleTask returns false, checkbox reverts to row.done.
    const viewRevert = mountView(doc, doc.indexOf("where:"), {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
      canToggleTasks: () => true,
      toggleTask: () => false,
    });
    const cbRevert = viewRevert.dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
    cbRevert?.click();
    expect(cbRevert?.checked).toBe(false);

    // When canToggleTasks returns false (read-only), checkboxes are disabled.
    const viewRo = mountView(doc, doc.indexOf("where:"), {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
      canToggleTasks: () => false,
      toggleTask,
    });
    const cbRo = viewRo.dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(cbRo?.disabled).toBe(true);
  });

  it("supports tilde fences, 4-backtick fences, indented fences, blockquoted queries, and count view with limit", () => {
    const tildeDoc = "Header\n\n~~~query\ntype: tasks\nlimit: 1\nview: count\n~~~\n";
    const view1 = mountView(tildeDoc, 0, {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
    });
    const countWidget = view1.dom.querySelector<HTMLElement>(".cm-query-widget");
    expect(countWidget?.querySelector(".cm-query-count-value")?.textContent).toBe("3");
    expect(countWidget?.textContent).toContain("matching tasks");
    expect(countWidget?.querySelector(".cm-query-meta")?.textContent).toBe("2 cached notes");

    // Blockquoted query strips `> ` prefixes cleanly via CodeText children and renders below the fence.
    const quotedDoc = "> ```query\n> from: Projects\n> view: list\n> ```\n";
    const view2 = mountView(quotedDoc, 0, {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
    });
    const quotedWidget = view2.dom.querySelector<HTMLElement>(".cm-query-widget-live");
    expect(quotedWidget).not.toBeNull();
    expect(quotedWidget?.textContent).toContain("Alpha");
    expect(quotedWidget?.querySelector('[role="alert"], [role="status"]')).toBeNull();

    // 4-backtick indented top-level fence collapses cleanly without orphan whitespace line.
    const fourTickDoc = "Top\n\n  ````query\n  view: list\n  ````\n";
    const view3 = mountView(fourTickDoc, 0, {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
    });
    expect(view3.dom.querySelector(".cm-query-widget .cm-query-edit-btn")).not.toBeNull();
    expect(view3.dom.querySelector(".cm-query-widget")?.textContent).toContain("Alpha");
  });

  it("handles unclosed fences, loading state, empty results, non-interactive links, and live vs collapsed error roles", () => {
    const unclosed = "```query\nfrom: Projects\n";
    const view1 = mountView(unclosed, unclosed.length, {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
    });
    expect(view1.dom.querySelector(".cm-query-widget")).toBeNull();

    // Collapsed error -> role="alert"; live error -> role="status" (polite while typing).
    const invalid = "Top\n\n```query\nselect: *\n```\n";
    const viewCollapsedErr = mountView(invalid, 0, {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
    });
    expect(viewCollapsedErr.dom.querySelector('[role="alert"]')?.textContent).toContain(
      'Unknown key "select"',
    );

    const viewLiveErr = mountView(invalid, invalid.indexOf("select"), {
      getDocs: () => SAMPLE_DOCS,
      getTotalNotes: () => 2,
      openNote: vi.fn(),
    });
    expect(viewLiveErr.dom.querySelector('[role="status"]')?.textContent).toContain(
      'Unknown key "select"',
    );
    expect(viewLiveErr.dom.querySelector('[role="alert"]')).toBeNull();

    // Loading state + canOpenNote: false renders plain spans instead of links.
    const listDoc = "Top\n\n```query\nview: list\n```\n";
    let docs: VaultDocument[] | null = null;
    const viewLoading = mountView(listDoc, 0, {
      getDocs: () => docs,
      getTotalNotes: () => 2,
      canOpenNote: () => false,
      openNote: vi.fn(),
    });
    expect(viewLoading.dom.querySelector('[role="status"]')?.textContent).toBe("Running query…");

    docs = SAMPLE_DOCS;
    viewLoading.dispatch({ effects: refreshQueryPreviews.of(2) });
    expect(viewLoading.dom.querySelector("a.cm-query-link")).toBeNull();
    expect(viewLoading.dom.querySelector("span.cm-query-link")?.textContent).toBe("Alpha");
  });
});
