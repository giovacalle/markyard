import { vi } from "vite-plus/test";

vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
});

import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { matchCodeLanguage } from "./editorCodeLanguages";
import { queryPreviews, QueryWidgetRegistry } from "./queryPreviews";

let activeViews: EditorView[] = [];

afterEach(() => {
  for (const view of activeViews) {
    view.destroy();
  }
  activeViews = [];
});

function mountMacView(
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

describe("queryPreviews macOS Ctrl-n / Ctrl-p unfolding", () => {
  const doc = ["Before line", "```query", "type: tasks", "```", "After line"].join("\n");
  const fenceFrom = doc.indexOf("```query");
  const fenceTo = doc.indexOf("\nAfter line");

  it("Ctrl-n stops on a folded query block and unfolds it on macOS", () => {
    const { view, registry } = mountMacView(doc, 0);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(fenceTo + 1));
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "n", ctrlKey: true }), "editor");

    expect(view.state.selection.main.head).toBe(fenceFrom);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });

  it("Ctrl-p stops on a folded query block and unfolds it on macOS", () => {
    const { view, registry } = mountMacView(doc, fenceTo + 1);
    expect(registry.getSnapshot()[0]?.mode).toBe("collapsed");

    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(fenceFrom - 1));
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "p", ctrlKey: true }), "editor");

    expect(view.state.selection.main.head).toBe(fenceTo);
    expect(registry.getSnapshot()[0]?.mode).toBe("live");
  });
});
