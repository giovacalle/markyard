// Live inline previews for ` ```query ` fenced code blocks in the CodeMirror editor:
// - When the cursor is outside a closed top-level ` ```query ` fence, the raw YAML folds into the
//   rendered result block (with an "Edit" button to unfold it, Obsidian Live Preview style).
// - When the cursor is inside the fence (or for blockquoted / list-nested fences), the YAML stays
//   editable and a live preview renders right underneath the closing fence, updating as you type.
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import {
  executeQuery,
  type FieldValue,
  type NoteQueryRow,
  parseQuery,
  type TaskQueryRow,
} from "./queryEngine";
import { formatModifiedDate, formatQueryCountLabel, formatQueryFooter } from "./queryFormat";
import type { VaultDocument } from "./vaultDocuments";

export interface QueryPreviewSources {
  getDocs: () => readonly VaultDocument[] | null;
  getTotalNotes: () => number;
  openNote: (id: string) => void;
  /** Returns false when PkmContext is unavailable so note titles render as plain spans. */
  canOpenNote?: () => boolean;
  /** Returns whether task checkboxes should be enabled (read-only / missing SyncQueue => false). */
  canToggleTasks?: () => boolean;
  /** Toggles a task; returns false if the toggle did not apply so the checkbox can revert. */
  toggleTask?: (noteId: string, offset: number) => boolean;
}

export const queryPreviewSources = Facet.define<QueryPreviewSources, QueryPreviewSources | null>({
  combine: (values) => values.at(-1) ?? null,
});

/** Dispatched when the vault document cache or interactivity state updates. */
export const refreshQueryPreviews = StateEffect.define<number>();

function createNoteLink(
  id: string,
  title: string,
  sources: QueryPreviewSources | null,
  className = "cm-query-link",
): HTMLElement {
  const interactive = sources !== null && (sources.canOpenNote?.() ?? true);
  if (!interactive) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = title;
    return span;
  }
  const link = document.createElement("a");
  link.href = `/?file=${encodeURIComponent(id)}`;
  link.className = className;
  link.dataset.noteId = id;
  link.textContent = title;
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    sources.openNote(id);
  });
  return link;
}

function appendCellValue(
  cell: HTMLElement,
  row: NoteQueryRow | TaskQueryRow,
  column: string,
  sources: QueryPreviewSources | null,
): void {
  const lower = column.toLowerCase();
  if (lower === "title") {
    cell.appendChild(createNoteLink(row.id, row.title, sources));
    return;
  }
  const value: FieldValue = row.getField(column);
  if (value === undefined || value === "") {
    const muted = document.createElement("span");
    muted.className = "cm-query-muted";
    muted.textContent = "—";
    cell.appendChild(muted);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      const muted = document.createElement("span");
      muted.className = "cm-query-muted";
      muted.textContent = "—";
      cell.appendChild(muted);
      return;
    }
    if (lower === "tags") {
      const wrap = document.createElement("span");
      wrap.className = "cm-query-tags";
      for (const tag of value) {
        const pill = document.createElement("span");
        pill.className = "cm-query-tag";
        pill.textContent = `#${tag}`;
        wrap.appendChild(pill);
      }
      cell.appendChild(wrap);
      return;
    }
    cell.textContent = value.join(", ");
    return;
  }
  if (typeof value === "boolean") {
    cell.textContent = value ? "true" : "false";
    return;
  }
  if (typeof value === "string" && lower === "modified") {
    cell.textContent = formatModifiedDate(value);
    return;
  }
  cell.textContent = String(value);
}

type WidgetMode = "collapsed" | "live";

function renderWidgetContents(
  container: HTMLElement,
  source: string,
  mode: WidgetMode,
  view: EditorView,
): void {
  // Preserve keyboard focus on a toggled task checkbox across in-place updates.
  const activeEl = view.root.activeElement;
  const focusedTaskKey =
    activeEl instanceof HTMLInputElement && container.contains(activeEl)
      ? (activeEl.dataset.taskKey ?? null)
      : null;

  container.className =
    mode === "live" ? "cm-query-widget cm-query-widget-live" : "cm-query-widget";
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", mode === "live" ? "Query live preview" : "Query results");

  const sources = view.state.facet(queryPreviewSources);
  const docs = sources?.getDocs() ?? null;
  const parsed = parseQuery(source);
  const canToggle = sources?.toggleTask !== undefined && (sources.canToggleTasks?.() ?? true);

  const fragment = document.createDocumentFragment();

  const header = document.createElement("div");
  header.className = "cm-query-header";

  const badge = document.createElement("span");
  badge.className = "cm-query-badge";
  badge.textContent = mode === "live" ? "Live preview" : "Query";
  header.appendChild(badge);

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
    header.appendChild(editBtn);
  }

  fragment.appendChild(header);

  if (!parsed.ok) {
    const err = document.createElement("p");
    err.className = "cm-query-error";
    // Announce politely while typing live; use an assertive alert on collapsed query errors.
    err.setAttribute("role", mode === "live" ? "status" : "alert");
    err.textContent = parsed.error;
    fragment.appendChild(err);
    container.replaceChildren(fragment);
    return;
  }

  if (docs === null) {
    const loading = document.createElement("p");
    loading.className = "cm-query-empty";
    loading.setAttribute("role", "status");
    loading.textContent = "Running query…";
    fragment.appendChild(loading);
    container.replaceChildren(fragment);
    return;
  }

  const result = executeQuery(parsed.query, docs);

  if (result.view.kind === "count") {
    const countWrap = document.createElement("div");
    countWrap.className = "cm-query-count";
    const val = document.createElement("span");
    val.className = "cm-query-count-value";
    val.textContent = String(result.totalMatched);
    const label = document.createElement("span");
    label.className = "cm-query-count-label";
    label.textContent = formatQueryCountLabel(result.type, result.totalMatched);
    countWrap.append(val, label);
    fragment.appendChild(countWrap);
  } else if (result.rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cm-query-empty";
    empty.textContent = `No matching ${result.type}.`;
    fragment.appendChild(empty);
  } else if (result.view.kind === "table") {
    const wrap = document.createElement("div");
    wrap.className = "cm-query-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-query-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of result.view.columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of result.rows) {
      const tr = document.createElement("tr");
      for (const col of result.view.columns) {
        const td = document.createElement("td");
        appendCellValue(td, row, col, sources);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    fragment.appendChild(wrap);
  } else if (result.view.kind === "tasks" && result.type === "tasks") {
    const ul = document.createElement("ul");
    ul.className = "cm-query-tasks";
    for (const row of result.rows) {
      const li = document.createElement("li");
      li.className = "cm-query-task-item";

      const taskKey = `${row.id}:${row.offset}`;
      const label = document.createElement("label");
      label.className = "cm-query-task-label";

      // Native checkbox inside CodeMirror's imperative Shadow DOM WidgetType (per ADR 0004).
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "cm-query-checkbox";
      checkbox.dataset.taskKey = taskKey;
      checkbox.checked = row.done;
      checkbox.disabled = !canToggle;
      checkbox.setAttribute("aria-label", row.text || "Task item");
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener("change", () => {
        const ok = sources?.toggleTask?.(row.id, row.offset) ?? false;
        if (!ok) {
          checkbox.checked = row.done;
        }
      });
      label.appendChild(checkbox);

      const textSpan = document.createElement("span");
      textSpan.className = row.done
        ? "cm-query-task-text cm-query-task-done"
        : "cm-query-task-text";
      textSpan.textContent = row.text;
      label.appendChild(textSpan);

      li.appendChild(label);

      if (row.due !== undefined) {
        const due = document.createElement("span");
        due.className = "cm-query-due";
        due.textContent = `@${row.due}`;
        li.appendChild(due);
      }

      li.appendChild(createNoteLink(row.id, row.title, sources, "cm-query-link cm-query-source"));
      ul.appendChild(li);
    }
    fragment.appendChild(ul);
  } else {
    const ul = document.createElement("ul");
    ul.className = "cm-query-list";
    if (result.type === "notes") {
      for (const row of result.rows) {
        const li = document.createElement("li");
        li.className = "cm-query-list-item";
        li.appendChild(createNoteLink(row.id, row.title, sources));
        if (row.folder.length > 0) {
          const folder = document.createElement("span");
          folder.className = "cm-query-folder";
          folder.textContent = row.folder;
          li.appendChild(folder);
        }
        ul.appendChild(li);
      }
    } else {
      for (const row of result.rows) {
        const li = document.createElement("li");
        li.className = "cm-query-list-item";
        const textSpan = document.createElement("span");
        textSpan.className = row.done
          ? "cm-query-task-text cm-query-task-done"
          : "cm-query-task-text";
        textSpan.textContent = row.text;
        li.appendChild(textSpan);
        li.appendChild(createNoteLink(row.id, row.title, sources, "cm-query-link cm-query-source"));
        ul.appendChild(li);
      }
    }
    fragment.appendChild(ul);
  }

  const totalNotes = sources?.getTotalNotes() ?? docs.length;
  const meta = document.createElement("p");
  meta.className = "cm-query-meta";
  meta.textContent = formatQueryFooter(result, docs.length, totalNotes);
  fragment.appendChild(meta);

  container.replaceChildren(fragment);

  if (focusedTaskKey !== null) {
    const nextCheckbox = container.querySelector<HTMLInputElement>(
      `input[data-task-key="${CSS.escape(focusedTaskKey)}"]`,
    );
    nextCheckbox?.focus();
  }
}

class QueryPreviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly version: number,
    readonly mode: WidgetMode,
  ) {
    super();
  }

  eq(other: QueryPreviewWidget): boolean {
    return (
      other.source === this.source && other.version === this.version && other.mode === this.mode
    );
  }

  get estimatedHeight(): number {
    return 96;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    renderWidgetContents(container, this.source, this.mode, view);
    return container;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    renderWidgetContents(dom, this.source, this.mode, view);
    view.requestMeasure();
    return true;
  }

  ignoreEvent(event: Event): boolean {
    const target = event.target;
    const el =
      target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (el === null) {
      return false;
    }
    // Let clicks on links, checkboxes, labels, and the Edit button run natively without CodeMirror hijacking them.
    if (el.closest("a, input, button, label") !== null) {
      return true;
    }
    return this.mode === "live";
  }
}

interface QueryPreviewState {
  version: number;
  decorations: DecorationSet;
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

function buildDecorations(state: EditorState, version: number): DecorationSet {
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
            widget: new QueryPreviewWidget(source, version, "live"),
            block: true,
            side: 1,
          }).range(closeLine.to),
        );
      } else {
        ranges.push(
          Decoration.replace({
            widget: new QueryPreviewWidget(source, version, "collapsed"),
            block: true,
          }).range(replaceFrom, replaceTo),
        );
      }
      return false;
    },
  });

  return Decoration.set(ranges, true);
}

const queryPreviewField = StateField.define<QueryPreviewState>({
  create(state) {
    return { version: 0, decorations: buildDecorations(state, 0) };
  },
  update(value, tr) {
    let version = value.version;
    let refreshed = false;
    for (const effect of tr.effects) {
      if (effect.is(refreshQueryPreviews)) {
        version = effect.value;
        refreshed = true;
      }
    }
    const treeChanged = syntaxTree(tr.state) !== syntaxTree(tr.startState);
    if (!refreshed && !tr.docChanged && !treeChanged) {
      // O(1) fast path for cursor movement in notes with no query blocks.
      if (value.decorations.size === 0 || tr.selection === undefined) {
        return value;
      }
    }
    return { version, decorations: buildDecorations(tr.state, version) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const QUERY_PREVIEW_THEME = EditorView.theme({
  ".cm-query-widget": {
    margin: "0.5rem 0 0.75rem",
    padding: "0.75rem 0.875rem",
    borderRadius: "0.625rem",
    border: "1px solid var(--cm-widget-border, #d4d4d4)",
    backgroundColor: "var(--cm-code-bg, #f5f5f5)",
    color: "var(--cm-fg, #171717)",
    fontFamily:
      'var(--markyard-font-ui, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
    fontSize: "0.875rem",
    lineHeight: "1.5",
  },
  ".cm-query-widget-live": {
    marginTop: "0.375rem",
    borderStyle: "dashed",
  },
  ".cm-query-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    marginBottom: "0.5rem",
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
    fontSize: "0.75rem",
    fontWeight: "500",
    cursor: "pointer",
  },
  ".cm-query-edit-btn:hover": {
    opacity: "0.85",
  },
  ".cm-query-edit-btn:focus-visible, .cm-query-link:focus-visible, .cm-query-checkbox:focus-visible":
    {
      outline: "2px solid var(--markyard-accent, var(--cm-link, #2563eb))",
      outlineOffset: "2px",
    },
  ".cm-query-error": {
    margin: "0",
    color: "var(--cm-code-deleted, #b91c1c)",
    fontSize: "0.8125rem",
    fontWeight: "500",
  },
  ".cm-query-empty": {
    margin: "0",
    color: "var(--cm-quote, #525252)",
    fontSize: "0.8125rem",
  },
  ".cm-query-count": {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
  },
  ".cm-query-count-value": {
    fontSize: "1.625rem",
    fontWeight: "700",
    lineHeight: "1.1",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-query-count-label": {
    color: "var(--cm-quote, #525252)",
    fontSize: "0.8125rem",
  },
  ".cm-query-list, .cm-query-tasks": {
    listStyle: "none",
    margin: "0",
    padding: "0",
    display: "flex",
    flexDirection: "column",
    gap: "0.3125rem",
  },
  ".cm-query-list-item, .cm-query-task-item": {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  ".cm-query-task-item": {
    alignItems: "center",
  },
  ".cm-query-task-label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    flex: "1 1 auto",
    minWidth: "0",
    minHeight: "1.5rem",
    cursor: "pointer",
  },
  ".cm-query-checkbox": {
    margin: "0",
    width: "1rem",
    height: "1rem",
    flexShrink: "0",
    accentColor: "var(--markyard-accent, var(--cm-link, #2563eb))",
    cursor: "pointer",
  },
  ".cm-query-checkbox:disabled": {
    cursor: "not-allowed",
    opacity: "0.6",
  },
  ".cm-query-task-text": {
    flex: "1 1 auto",
    minWidth: "0",
  },
  ".cm-query-task-done": {
    textDecoration: "line-through",
    color: "var(--cm-quote, #525252)",
  },
  ".cm-query-due": {
    fontSize: "0.75rem",
    color: "var(--cm-quote, #525252)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-query-link": {
    color: "var(--markyard-accent, var(--cm-link, #2563eb))",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  ".cm-query-source": {
    fontSize: "0.75rem",
    marginLeft: "auto",
  },
  ".cm-query-folder": {
    fontSize: "0.75rem",
    color: "var(--cm-quote, #525252)",
  },
  ".cm-query-table-wrap": {
    overflowX: "auto",
  },
  ".cm-query-table": {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.8125rem",
    textAlign: "left",
  },
  ".cm-query-table th, .cm-query-table td": {
    padding: "0.375rem 0.5rem",
    borderBottom: "1px solid var(--cm-widget-border, #d4d4d4)",
  },
  ".cm-query-table th": {
    fontWeight: "600",
    fontSize: "0.75rem",
    color: "var(--cm-quote, #525252)",
  },
  ".cm-query-table tbody tr:last-child td": {
    borderBottom: "none",
  },
  ".cm-query-tags": {
    display: "inline-flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  ".cm-query-tag": {
    padding: "0.0625rem 0.375rem",
    borderRadius: "999px",
    backgroundColor: "var(--cm-popup-bg, #ffffff)",
    border: "1px solid var(--cm-widget-border, #d4d4d4)",
    fontSize: "0.75rem",
  },
  ".cm-query-muted": {
    color: "var(--cm-quote, #525252)",
  },
  ".cm-query-meta": {
    margin: "0.5rem 0 0",
    paddingTop: "0.375rem",
    borderTop: "1px solid var(--cm-widget-border, #d4d4d4)",
    fontSize: "0.75rem",
    color: "var(--cm-quote, #525252)",
  },
});

/** Live inline previews for ` ```query ` blocks inside CodeMirror. */
export function queryPreviews(sources: QueryPreviewSources): Extension {
  return [queryPreviewSources.of(sources), queryPreviewField, QUERY_PREVIEW_THEME];
}
