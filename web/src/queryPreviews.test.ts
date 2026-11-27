import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { matchCodeLanguage } from "./editorCodeLanguages";
import {
  queryCursorLineDown,
  queryCursorLineUp,
  queryPreviews,
  QueryWidgetRegistry,
} from "./queryPreviews";

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
      keymap.of(defaultKeymap),
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

function pressKey(view: EditorView, key: string, init?: KeyboardEventInit): boolean {
  return runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...init }), "editor");
}

describe("queryPreviews keyboard unfolding", () => {
  const doc = ["Before line", "```query", "type: tasks", "```", "After line"].join("\n");
  const fenceFrom = doc.indexOf("```query");
  const fenceTo = doc.indexOf("\nAfter line");

  it("ArrowDown stops on a folded query block and unfolds it when motion skips the block", () => {
    const { view, registry } = mountView(doc, 0);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(fenceTo + 1));
    pressKey(view, "ArrowDown");

    expect(view.state.selection.main.head).toBe(fenceFrom);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("ArrowDown stops at the opening edge when motion lands inside a folded block", () => {
    const { view, registry } = mountView(doc, 0);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(fenceFrom + 3));
    pressKey(view, "ArrowDown");

    expect(view.state.selection.main.head).toBe(fenceFrom);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("ArrowUp stops on a folded query block and unfolds it when motion skips the block", () => {
    const { view, registry } = mountView(doc, fenceTo + 1);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(fenceFrom - 1));
    pressKey(view, "ArrowUp");

    expect(view.state.selection.main.head).toBe(fenceTo);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("ArrowUp stops at the closing edge when motion lands inside a folded block", () => {
    const { view, registry } = mountView(doc, fenceTo + 1);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(fenceTo - 3));
    pressKey(view, "ArrowUp");

    expect(view.state.selection.main.head).toBe(fenceTo);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("ArrowDown does not intervene when moving between visual rows of a wrapped line before the block", () => {
    const wrappedDoc = [
      "A very long wrapped paragraph before the query block",
      "```query",
      "type: tasks",
      "```",
      "After line",
    ].join("\n");
    const { view, registry } = mountView(wrappedDoc, 2);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    const nextVisualRow = 28;
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(nextVisualRow));
    expect(queryCursorLineDown(view)).toBe(false);
    pressKey(view, "ArrowDown");

    expect(view.state.selection.main.head).toBe(nextVisualRow);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");
  });

  it("ArrowUp does not intervene when moving between visual rows of a wrapped line after the block", () => {
    const wrappedDoc = [
      "Before line",
      "```query",
      "type: tasks",
      "```",
      "A very long wrapped paragraph after the query block",
    ].join("\n");
    const afterStart = wrappedDoc.indexOf("A very long");
    const { view, registry } = mountView(wrappedDoc, afterStart + 35);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    const prevVisualRow = afterStart + 5;
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(prevVisualRow));
    expect(queryCursorLineUp(view)).toBe(false);
    pressKey(view, "ArrowUp");

    expect(view.state.selection.main.head).toBe(prevVisualRow);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");
  });

  it("Backspace at the start of the line after a folded block unfolds it without deleting the newline", () => {
    const { view, registry } = mountView(doc, fenceTo + 1);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    pressKey(view, "Backspace");

    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(fenceTo);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("Delete at the end of the line before a folded block unfolds it without deleting the newline", () => {
    const { view, registry } = mountView(doc, fenceFrom - 1);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    pressKey(view, "Delete");

    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(fenceFrom);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("keeps default behavior for non-empty selections and lines not adjacent to a folded block", () => {
    const spacedDoc = [
      "Line 1",
      "Line 2",
      "```query",
      "type: tasks",
      "```",
      "Line 3",
      "Line 4",
    ].join("\n");
    const line2Start = spacedDoc.indexOf("Line 2");
    const { view, registry } = mountView(spacedDoc, 0);

    // ArrowDown on a line not next to the folded block follows moveVertically normally.
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(line2Start));
    pressKey(view, "ArrowDown");
    expect(view.state.selection.main.head).toBe(line2Start);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    // Non-empty selection before the folded block collapses on ArrowDown instead of unfolding.
    const spacedFenceFrom = spacedDoc.indexOf("```query");
    view.dispatch({
      selection: EditorSelection.range(line2Start, spacedFenceFrom - 1),
    });
    pressKey(view, "ArrowDown");
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(spacedFenceFrom - 1);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    // Non-empty selection before the folded block deletes with default behavior.
    view.dispatch({
      selection: EditorSelection.range(line2Start, spacedFenceFrom - 1),
    });
    pressKey(view, "Delete");
    expect(view.state.doc.toString()).toBe(
      ["Line 1", "", "```query", "type: tasks", "```", "Line 3", "Line 4"].join("\n"),
    );

    // Non-empty selection starting at the line after the folded block deletes normally on Backspace.
    const line3Start = view.state.doc.toString().indexOf("Line 3");
    view.dispatch({ selection: EditorSelection.range(line3Start, line3Start + 4) });
    pressKey(view, "Backspace");
    expect(view.state.doc.toString()).toContain("\n 3\nLine 4");
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    // Backspace in normal text deletes normally.
    const line4Start = view.state.doc.toString().indexOf("Line 4");
    view.dispatch({ selection: EditorSelection.cursor(line4Start + 2) });
    pressKey(view, "Backspace");
    expect(view.state.doc.toString()).toContain("Lne 4");
  });
});
