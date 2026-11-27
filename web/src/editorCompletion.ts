import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Frontmatter, parseFrontmatter } from "./frontmatter";
import { expandTemplate, slashCommands, type TemplateNote } from "./templates";
import type { VaultNoteRef } from "./vaultDocuments";
import { linkTargetFor, noteStem } from "./wikilinks";

/** What the editor's `[[` and `/` completions read from the app. */
export interface CompletionSources {
  getNotes: () => readonly VaultNoteRef[];
  /** Templates loaded so far (from the vault's `Templates/` folder). */
  getTemplates: () => readonly TemplateNote[];
  /** Asked when the `/` menu opens; resolves once fresher templates are available. */
  loadTemplates?: () => Promise<void>;
  /** The current note's stem, for `{{title}}`. */
  getTitle: () => string;
  /** The current note's folder path below the root (joined by `/`), for `{{folder}}`. */
  getFolder?: () => string;
  /** The current note's frontmatter, for `{{fm.<key>}}`; falls back to parsing the editor doc. */
  getFrontmatter?: () => Frontmatter | null;
  now?: () => Date;
}

export type CompletionTrigger =
  | { kind: "wikilink"; from: number; query: string }
  | { kind: "slash"; from: number; query: string };

const MAX_OPTIONS = 50;

/**
 * The completion the text before the cursor asks for: `[[query` (no closing `]]`, `|` or `#` yet),
 * or `/query` at the line start or after whitespace. `from` is the trigger's offset in `before`.
 */
export function detectTrigger(before: string): CompletionTrigger | null {
  const open = before.lastIndexOf("[[");
  if (open !== -1) {
    const query = before.slice(open + 2);
    if (!/[[\]|#]/.test(query) && query.length <= 200) {
      return { kind: "wikilink", from: open, query };
    }
  }
  const slash = /(?:^|\s)\/([\p{L}\p{N}_-]*)$/u.exec(before);
  if (slash !== null) {
    return { kind: "slash", from: before.length - slash[1].length - 1, query: slash[1] };
  }
  return null;
}

export interface CompletionOption {
  id: string;
  label: string;
  detail?: string;
  apply: (view: EditorView) => void;
}

interface CompletionState {
  trigger: CompletionTrigger;
  /** Cursor position the trigger was read at. */
  to: number;
  options: CompletionOption[];
  selected: number;
}

export const completionSources = Facet.define<CompletionSources, CompletionSources | null>({
  combine: (values) => values.at(-1) ?? null,
});

const moveSelection = StateEffect.define<number>();
const dismiss = StateEffect.define<number>();
/** Re-reads options from the sources (e.g. after templates finish loading). */
export const refreshCompletions = StateEffect.define<null>();

const IN_CODE = /^(InlineCode|FencedCode|CodeBlock|CodeText|CodeInfo|CodeMark)$/;

function inCode(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(
      pos,
      -1,
    );
    node !== null;
    node = node.parent
  ) {
    if (IN_CODE.test(node.name)) {
      return true;
    }
  }
  return false;
}

function fuzzyIncludes(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n.length === 0) {
    return 1;
  }
  if (h.startsWith(n)) {
    return 3;
  }
  if (h.includes(n)) {
    return 2;
  }
  return 0;
}

function wikilinkOptions(
  sources: CompletionSources,
  from: number,
  to: number,
  query: string,
): CompletionOption[] {
  const notes = sources.getNotes();
  const scored: { note: VaultNoteRef; score: number }[] = [];
  for (const note of notes) {
    const stem = noteStem(note.name);
    const full = [...note.path, stem].join("/");
    const score = Math.max(fuzzyIncludes(stem, query), fuzzyIncludes(full, query) > 0 ? 1 : 0);
    if (score > 0) {
      scored.push({ note, score });
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.note.path.length - b.note.path.length ||
      noteStem(a.note.name).localeCompare(noteStem(b.note.name)) ||
      a.note.path.join("/").localeCompare(b.note.path.join("/")),
  );
  return scored.slice(0, MAX_OPTIONS).map(({ note }) => {
    const target = linkTargetFor(note, notes);
    return {
      id: note.id,
      label: noteStem(note.name),
      detail: note.path.length > 0 ? note.path.join("/") : undefined,
      apply: (view) => {
        const closing = view.state.sliceDoc(to, to + 2) === "]]" ? 2 : 0;
        const insert = `[[${target}]]`;
        view.dispatch({
          changes: { from, to: to + closing, insert },
          selection: EditorSelection.cursor(from + insert.length),
          userEvent: "input.complete",
        });
      },
    };
  });
}

function slashOptions(
  sources: CompletionSources,
  from: number,
  to: number,
  query: string,
): CompletionOption[] {
  return slashCommands(sources.getTemplates(), query)
    .slice(0, MAX_OPTIONS)
    .map((command) => ({
      id: command.id,
      label: `/${command.label}`,
      detail: command.detail,
      apply: (view) => {
        const frontmatter =
          sources.getFrontmatter?.() ?? parseFrontmatter(view.state.doc.toString());
        const expanded = expandTemplate(command.template.replace(/\r\n?/g, "\n"), {
          now: sources.now?.() ?? new Date(),
          title: sources.getTitle(),
          folder: sources.getFolder?.() ?? "",
          frontmatter,
        });
        view.dispatch({
          changes: { from, to, insert: expanded.text },
          selection: EditorSelection.cursor(from + expanded.cursor),
          userEvent: "input.complete",
        });
      },
    }));
}

function compute(
  state: EditorState,
  previous: CompletionState | null,
  dismissedAt: number | null,
): CompletionState | null {
  const sources = state.facet(completionSources);
  const range = state.selection.main;
  if (sources === null || !range.empty) {
    return null;
  }
  const line = state.doc.lineAt(range.head);
  const trigger = detectTrigger(line.text.slice(0, range.head - line.from));
  if (trigger === null) {
    return null;
  }
  const from = line.from + trigger.from;
  if (from === dismissedAt || inCode(state, from + 1)) {
    return null;
  }
  const options =
    trigger.kind === "wikilink"
      ? wikilinkOptions(sources, from, range.head, trigger.query)
      : slashOptions(sources, from, range.head, trigger.query);
  // An empty `/` menu stays tracked (hidden) so templates still load while typing.
  if (options.length === 0 && trigger.kind === "wikilink") {
    return null;
  }
  const keep =
    previous !== null && previous.trigger.kind === trigger.kind && previous.trigger.from === from
      ? options.findIndex((option) => option.id === previous.options[previous.selected]?.id)
      : -1;
  return {
    trigger: { ...trigger, from },
    to: range.head,
    options,
    selected: Math.max(keep, 0),
  };
}

interface FieldValue {
  active: CompletionState | null;
  dismissedAt: number | null;
}

const completionField = StateField.define<FieldValue>({
  create: () => ({ active: null, dismissedAt: null }),
  update(value, tr) {
    let { active, dismissedAt } = value;
    if (dismissedAt !== null && tr.docChanged) {
      dismissedAt = tr.changes.mapPos(dismissedAt);
    }
    let recompute = tr.docChanged || tr.selection !== undefined;
    for (const effect of tr.effects) {
      if (effect.is(dismiss)) {
        dismissedAt = effect.value;
        active = null;
        recompute = false;
      } else if (effect.is(refreshCompletions)) {
        recompute = true;
      } else if (effect.is(moveSelection) && active !== null) {
        const count = active.options.length;
        active = { ...active, selected: (active.selected + effect.value + count) % count };
      }
    }
    if (recompute) {
      // Only typing (or moving within the trigger) reopens the menu; a fresh trigger clears dismissal.
      const next = compute(tr.state, active, dismissedAt);
      if (next === null && dismissedAt !== null && tr.docChanged) {
        const line = tr.state.doc.lineAt(tr.state.selection.main.head);
        const trigger = detectTrigger(line.text.slice(0, tr.state.selection.main.head - line.from));
        if (trigger === null || line.from + trigger.from !== dismissedAt) {
          dismissedAt = null;
        }
      }
      active = next;
      if (
        active !== null &&
        !tr.docChanged &&
        tr.selection !== undefined &&
        value.active === null
      ) {
        // Moving the cursor into an old trigger does not pop the menu open.
        active = null;
      }
    }
    return { active, dismissedAt };
  },
});

function trackedState(view: EditorView): CompletionState | null {
  return view.state.field(completionField, false)?.active ?? null;
}

/** The completion menu currently showing (with at least one option). */
function activeState(view: EditorView): CompletionState | null {
  const active = trackedState(view);
  return active !== null && active.options.length > 0 ? active : null;
}

function accept(view: EditorView): boolean {
  const active = activeState(view);
  const option = active?.options[active.selected];
  if (option === undefined) {
    return false;
  }
  option.apply(view);
  return true;
}

const completionKeymap = Prec.highest(
  keymap.of([
    {
      key: "ArrowDown",
      run: (view) => {
        if (activeState(view) === null) return false;
        view.dispatch({ effects: moveSelection.of(1) });
        return true;
      },
    },
    {
      key: "ArrowUp",
      run: (view) => {
        if (activeState(view) === null) return false;
        view.dispatch({ effects: moveSelection.of(-1) });
        return true;
      },
    },
    { key: "Enter", run: accept },
    { key: "Tab", run: accept },
    {
      key: "Escape",
      run: (view) => {
        const active = activeState(view);
        if (active === null) return false;
        view.dispatch({ effects: dismiss.of(active.trigger.from) });
        return true;
      },
    },
  ]),
);

class CompletionPopup implements PluginValue {
  private readonly dom: HTMLElement;
  private rendered: CompletionState | null = null;
  private templatesRequested = false;

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-pkm-completions";
    this.dom.setAttribute("role", "listbox");
    this.dom.id = `cm-pkm-completions-${Math.random().toString(36).slice(2)}`;
    this.dom.hidden = true;
    this.dom.addEventListener("mousedown", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
      const active = activeState(this.view);
      if (target === null || active === null) {
        return;
      }
      event.preventDefault();
      active.options[Number(target.dataset.index)]?.apply(this.view);
      this.view.focus();
    });
    view.dom.appendChild(this.dom);
    this.render(trackedState(view));
  }

  update(update: ViewUpdate): void {
    const active = trackedState(update.view);
    if (active !== this.rendered) {
      this.render(active);
    }
  }

  private render(active: CompletionState | null): void {
    this.rendered = active;
    const content = this.view.contentDOM;
    if (active === null) {
      this.dom.hidden = true;
      this.dom.replaceChildren();
      content.removeAttribute("aria-activedescendant");
      content.setAttribute("aria-expanded", "false");
      this.templatesRequested = false;
      return;
    }
    if (active.trigger.kind === "slash" && !this.templatesRequested) {
      this.templatesRequested = true;
      const sources = this.view.state.facet(completionSources);
      void sources?.loadTemplates?.().then(() => {
        if (trackedState(this.view) !== null) {
          this.view.dispatch({ effects: refreshCompletions.of(null) });
        }
      });
    }
    if (active.options.length === 0) {
      this.dom.hidden = true;
      this.dom.replaceChildren();
      content.removeAttribute("aria-activedescendant");
      content.setAttribute("aria-expanded", "false");
      return;
    }
    this.dom.setAttribute(
      "aria-label",
      active.trigger.kind === "wikilink" ? "Link to note" : "Insert block",
    );
    this.dom.replaceChildren(
      ...active.options.map((option, index) => {
        const item = document.createElement("div");
        item.id = `${this.dom.id}-${index}`;
        item.className = "cm-pkm-completion";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === active.selected));
        item.dataset.index = String(index);
        const label = document.createElement("span");
        label.className = "cm-pkm-completion-label";
        label.textContent = option.label;
        item.append(label);
        if (option.detail !== undefined) {
          const detail = document.createElement("span");
          detail.className = "cm-pkm-completion-detail";
          detail.textContent = option.detail;
          item.append(detail);
        }
        return item;
      }),
    );
    this.dom.hidden = false;
    content.setAttribute("aria-expanded", "true");
    content.setAttribute("aria-activedescendant", `${this.dom.id}-${active.selected}`);
    this.dom.children[active.selected]?.scrollIntoView?.({ block: "nearest" });
    this.view.requestMeasure({
      read: (view) => {
        const coords = view.coordsAtPos(active.trigger.from);
        const box = view.dom.getBoundingClientRect();
        return coords === null
          ? null
          : { left: coords.left - box.left, top: coords.bottom - box.top };
      },
      write: (position) => {
        // CSSOM writes are allowed by the strict CSP (unlike style attributes).
        this.dom.style.setProperty("left", `${Math.max(0, position?.left ?? 0)}px`);
        this.dom.style.setProperty("top", `${position?.top ?? 0}px`);
      },
    });
  }

  destroy(): void {
    this.dom.remove();
  }
}

const completionTheme = EditorView.baseTheme({
  ".cm-pkm-completions": {
    position: "absolute",
    zIndex: "20",
    minWidth: "14rem",
    maxWidth: "22rem",
    maxHeight: "16rem",
    overflowY: "auto",
    padding: "0.25rem",
    marginTop: "0.25rem",
    borderRadius: "0.5rem",
    border: "1px solid var(--cm-popup-border, #e5e5e5)",
    backgroundColor: "var(--cm-popup-bg, #ffffff)",
    color: "var(--cm-fg, #171717)",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
    fontSize: "0.8125rem",
    lineHeight: "1.4",
  },
  ".cm-pkm-completions[hidden]": { display: "none" },
  ".cm-pkm-completion": {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.3rem 0.5rem",
    borderRadius: "0.375rem",
    cursor: "pointer",
  },
  ".cm-pkm-completion[aria-selected=true]": {
    backgroundColor: "var(--cm-selection, rgba(37, 99, 235, 0.16))",
  },
  ".cm-pkm-completion-label": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-pkm-completion-detail": {
    flexShrink: "0",
    color: "var(--cm-muted, #737373)",
    fontSize: "0.75rem",
  },
});

/** `[[` note links and `/` blocks/templates completion menu for the Markdown editor. */
export function pkmCompletions(sources: CompletionSources): Extension {
  return [
    completionSources.of(sources),
    completionField,
    completionKeymap,
    ViewPlugin.fromClass(CompletionPopup),
    completionTheme,
    EditorView.contentAttributes.of({ "aria-autocomplete": "list", "aria-haspopup": "listbox" }),
  ];
}
