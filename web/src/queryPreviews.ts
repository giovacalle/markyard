// Live inline previews for ` ```query ` fenced code blocks in the CodeMirror editor:
// - When the cursor is outside a closed top-level ` ```query ` fence, the raw YAML folds into a
//   widget shell whose body hosts the shared React `QueryBlock` via a portal from `Editor` (with
//   a native "Edit" button to unfold it, Obsidian Live Preview style).
// - When the cursor is inside the fence (or for blockquoted / list-nested fences), the YAML stays
//   editable and a live preview renders right underneath the closing fence, updating as you type.
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  Prec,
  type Range,
  StateField,
} from "@codemirror/state";
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";

export type QueryWidgetMode = "collapsed" | "live";

export interface QueryWidgetSlot {
  readonly key: number;
  readonly dom: HTMLElement;
  readonly source: string;
  readonly mode: QueryWidgetMode;
}

/**
 * Tracks active CodeMirror query widget containers so `Editor` can render the shared `QueryBlock`
 * into each slot via React portals (`useSyncExternalStore`) without per-widget React roots.
 */
export class QueryWidgetRegistry {
  private nextKey = 1;
  private readonly slots = new Map<HTMLElement, QueryWidgetSlot>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly QueryWidgetSlot[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): readonly QueryWidgetSlot[] => this.snapshot;

  mount(dom: HTMLElement, source: string, mode: QueryWidgetMode): void {
    const existing = this.slots.get(dom);
    if (existing !== undefined && existing.source === source && existing.mode === mode) {
      return;
    }
    const key = existing?.key ?? this.nextKey++;
    this.slots.set(dom, { key, dom, source, mode });
    this.emit();
  }

  update(dom: HTMLElement, source: string, mode: QueryWidgetMode): void {
    const existing = this.slots.get(dom);
    if (existing === undefined) {
      this.mount(dom, source, mode);
      return;
    }
    if (existing.source === source && existing.mode === mode) {
      return;
    }
    this.slots.set(dom, { key: existing.key, dom, source, mode });
    this.emit();
  }

  unmount(dom: HTMLElement): void {
    if (!this.slots.delete(dom)) {
      return;
    }
    this.emit();
  }

  private emit(): void {
    this.snapshot = Array.from(this.slots.values());
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const queryWidgetRegistry = Facet.define<QueryWidgetRegistry, QueryWidgetRegistry | null>({
  combine: (values) => values.at(-1) ?? null,
});

interface WidgetMount {
  header: HTMLElement;
  body: HTMLElement;
  mode: QueryWidgetMode;
  registry: QueryWidgetRegistry | null;
}

const widgetMounts = new WeakMap<HTMLElement, WidgetMount>();

function populateHeader(
  container: HTMLElement,
  header: HTMLElement,
  mode: QueryWidgetMode,
  view: EditorView,
): void {
  const badge = document.createElement("span");
  badge.className = "cm-query-badge";
  badge.textContent = mode === "live" ? "Live preview" : "Query";

  if (mode === "collapsed") {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "cm-query-edit-btn";
    editBtn.textContent = "Edit";
    editBtn.setAttribute("aria-label", "Edit query");
    editBtn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    editBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Compute the live fence position at click time so typing above the block never invalidates `eq()`.
      const blockStart = view.posAtDOM(container);
      const openLine = view.state.doc.lineAt(blockStart);
      const target = Math.min(openLine.to + 1, view.state.doc.length);
      view.dispatch({ selection: EditorSelection.cursor(target) });
      view.focus();
    });
    header.replaceChildren(badge, editBtn);
  } else {
    header.replaceChildren(badge);
  }
}

class QueryPreviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly mode: QueryWidgetMode,
  ) {
    super();
  }

  eq(other: QueryPreviewWidget): boolean {
    return other.source === this.source && other.mode === this.mode;
  }

  get estimatedHeight(): number {
    return 96;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className =
      this.mode === "live" ? "cm-query-widget cm-query-widget-live" : "cm-query-widget";

    const header = document.createElement("div");
    header.className = "cm-query-header";
    populateHeader(container, header, this.mode, view);

    const body = document.createElement("div");
    body.className = "cm-query-body";

    container.append(header, body);

    const registry = view.state.facet(queryWidgetRegistry);
    widgetMounts.set(container, { header, body, mode: this.mode, registry });
    registry?.mount(body, this.source, this.mode);
    return container;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const mount = widgetMounts.get(dom);
    if (mount === undefined) {
      return false;
    }
    if (mount.mode !== this.mode) {
      dom.className =
        this.mode === "live" ? "cm-query-widget cm-query-widget-live" : "cm-query-widget";
      populateHeader(dom, mount.header, this.mode, view);
      mount.mode = this.mode;
    }
    mount.registry?.update(mount.body, this.source, this.mode);
    view.requestMeasure();
    return true;
  }

  destroy(dom: HTMLElement): void {
    const mount = widgetMounts.get(dom);
    if (mount === undefined) {
      return;
    }
    widgetMounts.delete(dom);
    mount.registry?.unmount(mount.body);
  }

  ignoreEvent(event: Event): boolean {
    const target = event.target;
    const el =
      target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (el === null) {
      return false;
    }
    // Let clicks and keyboard events on links, checkboxes, labels, and the Edit button run natively.
    if (el.closest("a, input, button, label") !== null) {
      return true;
    }
    return this.mode === "live";
  }
}

const SKIP_NODES = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "Table",
  "HorizontalRule",
  "HTMLBlock",
  "Frontmatter",
]);

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const selection = state.selection.ranges;

  syntaxTree(state).iterate({
    enter(ref) {
      if (SKIP_NODES.has(ref.name)) {
        return false;
      }
      if (ref.name !== "FencedCode") {
        return;
      }
      const node = ref.node;
      const marks = node.getChildren("CodeMark");
      // Wait until the fence is closed so typing a new query block never swallows the rest of the doc.
      if (marks.length < 2) {
        return false;
      }
      const info = node.getChild("CodeInfo");
      if (info === null) {
        return false;
      }
      const token = /^\S+/.exec(state.sliceDoc(info.from, info.to).trim())?.[0]?.toLowerCase();
      if (token !== "query") {
        return false;
      }

      // Join Lezer `CodeText` children so blockquote prefixes (`> `) are cleanly excluded.
      const source = node
        .getChildren("CodeText")
        .map((chunk) => state.sliceDoc(chunk.from, chunk.to))
        .join("")
        .replace(/\r?\n$/, "");

      const openLine = state.doc.lineAt(node.from);
      const closeLine = state.doc.lineAt(marks[marks.length - 1].from);
      const isTopLevel =
        node.parent?.name === "Document" &&
        state.sliceDoc(openLine.from, node.from).trim().length === 0;
      const replaceFrom = isTopLevel ? openLine.from : node.from;
      const replaceTo = isTopLevel ? closeLine.to : node.to;

      const editing = selection.some((range) => range.from <= replaceTo && range.to >= replaceFrom);
      if (editing || !isTopLevel) {
        ranges.push(
          Decoration.widget({
            widget: new QueryPreviewWidget(source, "live"),
            block: true,
            side: 1,
          }).range(closeLine.to),
        );
      } else {
        ranges.push(
          Decoration.replace({
            widget: new QueryPreviewWidget(source, "collapsed"),
            block: true,
          }).range(replaceFrom, replaceTo),
        );
      }
      return false;
    },
  });

  return Decoration.set(ranges, true);
}

const queryPreviewField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    const treeChanged = syntaxTree(tr.state) !== syntaxTree(tr.startState);
    if (!tr.docChanged && !treeChanged) {
      // O(1) fast path for cursor movement in notes with no query blocks.
      if (value.size === 0 || tr.selection === undefined) {
        return value;
      }
    }
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface FoldedRange {
  readonly from: number;
  readonly to: number;
}

function foldedRanges(state: EditorState): FoldedRange[] {
  const decos = state.field(queryPreviewField, false);
  if (decos === undefined || decos.size === 0) {
    return [];
  }
  const ranges: FoldedRange[] = [];
  decos.between(0, state.doc.length, (from, to, value) => {
    if (
      from < to &&
      value.spec.widget instanceof QueryPreviewWidget &&
      value.spec.widget.mode === "collapsed"
    ) {
      ranges.push({ from, to });
    }
  });
  return ranges;
}

function moveIntoFolded(view: EditorView, pos: number): true {
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

function moveVerticallyAcrossFolded(view: EditorView, forward: boolean): boolean {
  const { selection } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return false;
  }
  const folded = foldedRanges(view.state);
  if (folded.length === 0) {
    return false;
  }
  const range = selection.main;
  const target = view.moveVertically(range, forward);
  if (forward) {
    if (target.head <= range.head) {
      return false;
    }
    for (const block of folded) {
      if (range.head < block.from && target.head >= block.from) {
        return moveIntoFolded(view, block.from);
      }
    }
    return false;
  }
  if (target.head >= range.head) {
    return false;
  }
  for (let i = folded.length - 1; i >= 0; i--) {
    const block = folded[i];
    if (range.head > block.to && target.head <= block.to) {
      return moveIntoFolded(view, block.to);
    }
  }
  return false;
}

/** Move down onto the opening edge of a folded query block instead of skipping over it. */
export const queryCursorLineDown: Command = (view) => moveVerticallyAcrossFolded(view, true);

/** Move up onto the closing edge of a folded query block instead of skipping over it. */
export const queryCursorLineUp: Command = (view) => moveVerticallyAcrossFolded(view, false);

/** Unfold a folded query block when pressing Backspace at the start of the line after it. */
export const queryDeleteBackward: Command = (view) => {
  const { selection } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return false;
  }
  const head = selection.main.head;
  for (const block of foldedRanges(view.state)) {
    if (head === block.to + 1) {
      return moveIntoFolded(view, block.to);
    }
  }
  return false;
};

/** Unfold a folded query block when pressing Delete at the end of the line before it. */
export const queryDeleteForward: Command = (view) => {
  const { selection } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return false;
  }
  const head = selection.main.head;
  for (const block of foldedRanges(view.state)) {
    if (head === block.from - 1) {
      return moveIntoFolded(view, block.from);
    }
  }
  return false;
};

const queryNavigationKeymap = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: queryCursorLineDown },
    { key: "ArrowUp", run: queryCursorLineUp },
    { mac: "Ctrl-n", run: queryCursorLineDown },
    { mac: "Ctrl-p", run: queryCursorLineUp },
  ]),
);

const queryDeleteKeymap = Prec.highest(
  keymap.of([
    { key: "Backspace", run: queryDeleteBackward, shift: queryDeleteBackward },
    { key: "Delete", run: queryDeleteForward },
  ]),
);

// Shadow-root styles for the shared `QueryBlock` rendered inside `.cm-query-widget`.
// Specificity comes from CodeMirror's theme scope class + `.cm-query-widget` (no `@layer`),
// beating unlayered editor rules under the strict CSP. Colors reuse existing `--cm-*` tokens.
const QUERY_PREVIEW_THEME = EditorView.theme({
  ".cm-query-widget": {
    margin: "0.5rem 0 0.75rem",
    padding: "0",
    border: "0 solid transparent",
    backgroundColor: "transparent",
    whiteSpace: "normal",
  },
  ".cm-query-widget-live": {
    marginTop: "0.375rem",
  },
  ".cm-query-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    marginBottom: "0.375rem",
    fontFamily:
      'var(--markyard-font-ui, var(--default-font-family, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif))',
    lineHeight: "1.25",
  },
  ".cm-query-badge": {
    fontSize: "0.6875rem",
    fontWeight: "600",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--cm-quote, #525252)",
  },
  ".cm-query-edit-btn": {
    padding: "0.125rem 0.5rem",
    borderRadius: "0.375rem",
    border: "1px solid var(--cm-widget-border, #d4d4d4)",
    backgroundColor: "var(--cm-popup-bg, #ffffff)",
    color: "var(--cm-fg, #171717)",
    fontFamily: "inherit",
    fontSize: "0.75rem",
    fontWeight: "500",
    lineHeight: "1.25",
    cursor: "pointer",
  },
  ".cm-query-edit-btn:hover": {
    opacity: "0.85",
  },
  ".cm-query-edit-btn:focus-visible": {
    outline: "2px solid var(--markyard-accent, var(--cm-link, #2563eb))",
    outlineOffset: "2px",
  },
  ".cm-query-widget :where(.query-block, .query-block *, .query-block ::before, .query-block ::after, .query-block-error, .query-block-error *, .query-block-error ::before, .query-block-error ::after)":
    {
      boxSizing: "border-box",
      border: "0 solid",
      margin: "0",
    },
  ".cm-query-widget .query-block": {
    overflow: "hidden",
    borderRadius: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "var(--cm-popup-border, #e5e5e5)",
    backgroundColor: "color-mix(in srgb, var(--cm-code-bg, #f5f5f5) 45%, transparent)",
    padding: "0",
    fontFamily:
      "var(--markyard-font-text, var(--default-font-family, ui-sans-serif, system-ui, sans-serif))",
    fontSize: "var(--markyard-text-size, 1rem)",
    lineHeight: "var(--markyard-line-height, var(--leading-relaxed, 1.625))",
    color: "var(--cm-fg, #171717)",
    whiteSpace: "normal",
  },
  ".cm-query-widget.cm-query-widget-live .query-block": {
    borderStyle: "dashed",
  },
  ".cm-query-widget .query-block-error": {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    borderRadius: "0.5rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "color-mix(in srgb, var(--cm-code-deleted, #b91c1c) 30%, transparent)",
    backgroundColor: "color-mix(in srgb, var(--cm-code-deleted, #b91c1c) 8%, transparent)",
    padding: "0.75rem",
    fontFamily:
      "var(--markyard-font-text, var(--default-font-family, ui-sans-serif, system-ui, sans-serif))",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "var(--cm-code-deleted, #b91c1c)",
    whiteSpace: "normal",
  },
  ".cm-query-widget .query-block-error :where(p)": {
    margin: "0",
    padding: "0",
  },
  ".cm-query-widget .query-block-error .query-block-error-message": {
    fontWeight: "500",
  },
  ".cm-query-widget .query-block-error pre": {
    overflowX: "auto",
    borderRadius: "0.25rem",
    backgroundColor: "var(--cm-code-bg, #f5f5f5)",
    padding: "0.75rem",
    margin: "0",
    fontFamily: "var(--markyard-font-mono, var(--default-mono-font-family, monospace))",
    fontSize: "0.75rem",
    lineHeight: "1.5",
    color: "var(--cm-code-fg, #171717)",
    whiteSpace: "pre",
  },
  ".cm-query-widget .query-block-error pre code": {
    backgroundColor: "transparent",
    padding: "0",
    fontFamily: "inherit",
    fontSize: "inherit",
  },
  ".cm-query-widget .query-block :where(ul, li, p)": {
    listStyle: "none",
    padding: "0",
    margin: "0",
  },
  ".cm-query-widget .query-block .query-block-empty": {
    padding: "0.75rem 0.875rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "var(--cm-muted, #737373)",
  },
  ".cm-query-widget .query-block .query-block-list > li + li, .cm-query-widget .query-block .query-block-tasks > li + li":
    {
      borderTopWidth: "1px",
      borderTopStyle: "solid",
      borderTopColor: "color-mix(in srgb, var(--cm-popup-border, #e5e5e5) 80%, transparent)",
    },
  ".cm-query-widget .query-block .query-block-list-item": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.5rem",
    padding: "0.5rem 0.875rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  ".cm-query-widget .query-block .query-block-folder": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "var(--cm-muted, #737373)",
  },
  ".cm-query-widget .query-block .query-block-task-item": {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.625rem",
    padding: "0.5rem 0.875rem",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
  },
  ".cm-query-widget .query-block .query-block-checkbox": {
    appearance: "none",
    padding: "0",
    font: "inherit",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    marginTop: "0.125rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "var(--cm-widget-border, #d4d4d4)",
    borderRadius: "0.25rem",
    backgroundColor: "var(--cm-popup-bg, #ffffff)",
    color: "#ffffff",
    transition: "color 150ms, background-color 150ms, border-color 150ms",
  },
  ".cm-query-widget .query-block .query-block-checkbox:hover": {
    borderColor: "var(--cm-muted, #737373)",
  },
  ".cm-query-widget .query-block .query-block-checkbox:focus-visible": {
    outline: "2px solid var(--markyard-accent, var(--cm-link, #2563eb))",
    outlineOffset: "2px",
  },
  ".cm-query-widget .query-block .query-block-checkbox:disabled": {
    cursor: "not-allowed",
    opacity: "0.6",
  },
  ".cm-query-widget .query-block .query-block-checkbox[data-checked]": {
    borderColor: "var(--markyard-accent, var(--cm-link, #2563eb))",
    backgroundColor: "var(--markyard-accent, var(--cm-link, #2563eb))",
  },
  ".cm-query-widget .query-block .query-block-checkbox-indicator": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-query-widget .query-block .query-block-checkbox-indicator svg": {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: "0",
  },
  ".cm-query-widget .query-block .query-block-task-text": {
    minWidth: "0",
    flex: "1 1 0%",
    overflowWrap: "break-word",
    color: "var(--cm-fg, #171717)",
  },
  ".cm-query-widget .query-block .query-block-task-done": {
    textDecoration: "line-through",
    color: "var(--cm-muted, #737373)",
  },
  ".cm-query-widget .query-block .query-block-due": {
    flexShrink: "0",
    borderRadius: "0.25rem",
    backgroundColor: "color-mix(in srgb, var(--cm-yaml-atom, #b45309) 14%, transparent)",
    padding: "0.125rem 0.375rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: "500",
    fontVariantNumeric: "tabular-nums",
    color: "var(--cm-yaml-atom, #b45309)",
  },
  ".cm-query-widget .query-block .query-block-source-link": {
    flexShrink: "0",
    fontSize: "0.75rem",
    lineHeight: "1rem",
  },
  ".cm-query-widget .query-block .wikilink": {
    color: "var(--markyard-accent, var(--cm-link, #2563eb))",
    textDecoration: "none",
    cursor: "pointer",
    borderRadius: "0.125rem",
  },
  ".cm-query-widget .query-block .wikilink:hover": {
    textDecoration: "underline",
  },
  ".cm-query-widget .query-block .wikilink:focus-visible": {
    outline: "2px solid var(--markyard-accent, var(--cm-link, #2563eb))",
    outlineOffset: "2px",
  },
  ".cm-query-widget .query-block .query-block-table-wrap": {
    width: "100%",
    overflowX: "auto",
  },
  ".cm-query-widget .query-block .query-block-table": {
    display: "table",
    width: "100%",
    borderCollapse: "collapse",
    borderSpacing: "0",
    textIndent: "0",
    textAlign: "left",
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    margin: "0",
  },
  ".cm-query-widget .query-block .query-block-table th, .cm-query-widget .query-block .query-block-table td":
    {
      textAlign: "left",
      fontWeight: "inherit",
      borderWidth: "0",
      borderBottomWidth: "1px",
      borderBottomStyle: "solid",
      borderBottomColor: "var(--cm-popup-border, #e5e5e5)",
      padding: "0.5rem 0.875rem",
    },
  ".cm-query-widget .query-block .query-block-table tbody tr:last-child td": {
    borderBottomWidth: "0",
  },
  ".cm-query-widget .query-block .query-block-table th": {
    backgroundColor: "color-mix(in srgb, var(--cm-code-bg, #f5f5f5) 80%, transparent)",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    fontWeight: "600",
    letterSpacing: "0.025em",
    textTransform: "uppercase",
    color: "var(--cm-quote, #525252)",
  },
  ".cm-query-widget .query-block .query-block-tags": {
    display: "inline-flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  ".cm-query-widget .query-block .query-block-tag": {
    borderRadius: "9999px",
    backgroundColor: "color-mix(in srgb, var(--cm-popup-border, #e5e5e5) 80%, transparent)",
    padding: "0.125rem 0.5rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "var(--cm-fg, #171717)",
  },
  ".cm-query-widget .query-block .query-block-muted": {
    color: "var(--cm-muted, #737373)",
  },
  ".cm-query-widget .query-block .query-block-count": {
    display: "flex",
    alignItems: "baseline",
    gap: "0.625rem",
    padding: "0.875rem 1rem",
  },
  ".cm-query-widget .query-block .query-block-count-value": {
    fontSize: "1.875rem",
    lineHeight: "2.25rem",
    fontWeight: "600",
    letterSpacing: "-0.025em",
    fontVariantNumeric: "tabular-nums",
    color: "var(--cm-heading, #0a0a0a)",
  },
  ".cm-query-widget .query-block .query-block-count-label": {
    fontSize: "0.875rem",
    lineHeight: "1.25rem",
    color: "var(--cm-muted, #737373)",
  },
  ".cm-query-widget .query-block .query-block-meta": {
    margin: "0",
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: "var(--cm-popup-border, #e5e5e5)",
    backgroundColor: "color-mix(in srgb, var(--cm-code-bg, #f5f5f5) 50%, transparent)",
    padding: "0.375rem 0.875rem",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: "var(--cm-muted, #737373)",
  },
});

/** Live inline previews for ` ```query ` blocks inside CodeMirror. */
export function queryPreviews(registry: QueryWidgetRegistry): Extension {
  return [
    queryWidgetRegistry.of(registry),
    queryPreviewField,
    queryNavigationKeymap,
    queryDeleteKeymap,
    QUERY_PREVIEW_THEME,
  ];
}
