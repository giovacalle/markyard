import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { matchCodeLanguage } from "./editorCodeLanguages";
import { queryPreviews, QueryWidgetRegistry } from "./queryPreviews";

let activeViews: EditorView[] = [];

afterEach(() => {
  for (const view of activeViews) {
    view.destroy();
  }
  activeViews = [];
});

function mountView(
  doc: string,
  cursor: number,
): {
  view: EditorView;
  registry: QueryWidgetRegistry;
} {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const registry = new QueryWidgetRegistry();
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      yamlFrontmatter({
        content: markdown({ base: markdownLanguage, codeLanguages: matchCodeLanguage }),
      }),
      queryPreviews(registry),
    ],
  });
  const view = new EditorView({ state, parent });
  activeViews.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
  return { view, registry };
}

describe("queryPreviews inline CodeMirror extension", () => {
  it("folds closed ```query blocks when cursor is outside, reuses DOM and slot while typing above, and unfolds on Edit click", () => {
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

    const { view, registry } = mountView(doc, 0);

    const slotsBefore = registry.getSnapshot();
    expect(slotsBefore).toHaveLength(1);
    expect(slotsBefore[0].mode).toBe("collapsed");
    expect(slotsBefore[0].source).toBe(
      "from: Projects\nsort: priority asc\nview: table(title, status)",
    );

    const widgetBefore = view.dom.querySelector<HTMLElement>(".cm-query-widget");
    expect(widgetBefore).not.toBeNull();
    expect(widgetBefore?.classList.contains("cm-query-widget-live")).toBe(false);
    expect(widgetBefore?.contains(slotsBefore[0].dom)).toBe(true);

    // Typing above the collapsed query block must NOT destroy/recreate the widget DOM or slot.
    const onChange = vi.fn();
    const unsubscribe = registry.subscribe(onChange);
    view.dispatch({ changes: { from: 0, to: 0, insert: "Prefix " } });
    ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    unsubscribe();

    const widgetAfter = view.dom.querySelector<HTMLElement>(".cm-query-widget");
    expect(widgetAfter).toBe(widgetBefore);
    expect(onChange).not.toHaveBeenCalled();
    expect(registry.getSnapshot()).toBe(slotsBefore);

    // Clicking "Edit" computes the shifted fence position dynamically and unfolds into live preview.
    const editBtn = widgetAfter?.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit query"]',
    );
    expect(editBtn).not.toBeNull();
    editBtn?.click();

    const liveWidget = view.dom.querySelector<HTMLElement>(".cm-query-widget-live");
    expect(liveWidget).not.toBeNull();
    expect(liveWidget?.textContent).toContain("Live preview");
    expect(view.contentDOM.textContent).toContain("from: Projects");
    const liveSlots = registry.getSnapshot();
    expect(liveSlots).toHaveLength(1);
    expect(liveSlots[0].mode).toBe("live");

    // Live editing inside the YAML updates the existing slot source in place.
    const liveKey = liveSlots[0].key;
    const liveDom = liveSlots[0].dom;
    const fromIdx = view.state.doc.toString().indexOf("from: Projects");
    view.dispatch({
      changes: { from: fromIdx, to: fromIdx + "from: Projects".length, insert: "limit: 1" },
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
    const updatedSlots = registry.getSnapshot();
    expect(updatedSlots).toHaveLength(1);
    expect(updatedSlots[0].key).toBe(liveKey);
    expect(updatedSlots[0].dom).toBe(liveDom);
    expect(updatedSlots[0].source).toContain("limit: 1");

    // Moving cursor back outside re-folds the block.
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(view.dom.querySelector(".cm-query-widget-live")).toBeNull();
    expect(view.dom.querySelector('button[aria-label="Edit query"]')).not.toBeNull();
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");
  });

  it("extracts source from tilde fences, 4-backtick indented fences, and blockquoted queries", () => {
    const tildeDoc = "Header\n\n~~~query\ntype: tasks\nlimit: 1\nview: count\n~~~\n";
    const { registry: tildeReg } = mountView(tildeDoc, 0);
    expect(tildeReg.getSnapshot()).toHaveLength(1);
    expect(tildeReg.getSnapshot()[0]).toMatchObject({
      mode: "collapsed",
      source: "type: tasks\nlimit: 1\nview: count",
    });

    // Blockquoted query strips `> ` prefixes cleanly via CodeText children and renders below the fence.
    const quotedDoc = "> ```query\n> from: Projects\n> view: list\n> ```\n";
    const { view: quotedView, registry: quotedReg } = mountView(quotedDoc, 0);
    expect(quotedView.dom.querySelector(".cm-query-widget-live")).not.toBeNull();
    expect(quotedReg.getSnapshot()).toHaveLength(1);
    expect(quotedReg.getSnapshot()[0]).toMatchObject({
      mode: "live",
      source: "from: Projects\nview: list",
    });

    // 4-backtick indented top-level fence collapses cleanly without orphan whitespace line.
    const fourTickDoc = "Top\n\n  ````query\n  view: list\n  ````\n";
    const { view: fourView, registry: fourReg } = mountView(fourTickDoc, 0);
    expect(fourView.dom.querySelector('button[aria-label="Edit query"]')).not.toBeNull();
    expect(fourReg.getSnapshot()).toHaveLength(1);
    expect(fourReg.getSnapshot()[0]).toMatchObject({
      mode: "collapsed",
      source: "  view: list",
    });
  });

  it("leaves unclosed fences as plain text with zero slots and unmounts slots on view destroy", () => {
    const unclosed = "```query\nfrom: Projects\n";
    const { view: unclosedView, registry: unclosedReg } = mountView(unclosed, unclosed.length);
    expect(unclosedView.dom.querySelector(".cm-query-widget")).toBeNull();
    expect(unclosedReg.getSnapshot()).toHaveLength(0);

    const closed = "Top\n\n```query\nview: list\n```\n";
    const { view, registry } = mountView(closed, 0);
    expect(registry.getSnapshot()).toHaveLength(1);
    view.destroy();
    expect(registry.getSnapshot()).toHaveLength(0);
  });
});
