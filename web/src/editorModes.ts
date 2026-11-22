// CodeMirror extensions for the Focus and Typewriter writing modes. Their styles go through
// EditorView.theme, so they mount inside the editor's shadow root like the rest (strict CSP).
import { EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const DIMMED = Decoration.line({ class: "cm-dimmed" });

/** First and last line numbers of the paragraph (run of non-blank lines) holding the cursor. */
function activeBlock(state: EditorState): { first: number; last: number } {
  const doc = state.doc;
  const line = doc.lineAt(state.selection.main.head).number;
  const blank = (n: number) => doc.line(n).text.trim() === "";
  if (blank(line)) {
    return { first: line, last: line };
  }
  let first = line;
  let last = line;
  while (first > 1 && !blank(first - 1)) first -= 1;
  while (last < doc.lines && !blank(last + 1)) last += 1;
  return { first, last };
}

function dimDecorations(view: EditorView): DecorationSet {
  const { first, last } = activeBlock(view.state);
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (line.number < first || line.number > last) {
        ranges.push(DIMMED.range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/** Dims every line outside the paragraph holding the cursor. */
export const focusMode: Extension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = dimDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = dimDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  EditorView.theme({
    ".cm-line": { transition: "opacity 120ms ease-out" },
    ".cm-line.cm-dimmed": { opacity: "0.32" },
  }),
];

/**
 * Keeps the cursor line vertically centered on every edit and keyboard move. Pointer
 * selections are left alone so the text never jumps under the mouse while selecting.
 */
export const typewriterMode: Extension = [
  EditorState.transactionExtender.of((tr) =>
    tr.docChanged || (tr.selection !== undefined && !tr.isUserEvent("select.pointer"))
      ? { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }) }
      : null,
  ),
  EditorView.editorAttributes.of({ class: "cm-typewriter" }),
  // Room below the last line, so it can reach the middle of the screen too.
  EditorView.theme({ "&.cm-typewriter .cm-content": { paddingBottom: "50vh" } }),
];
