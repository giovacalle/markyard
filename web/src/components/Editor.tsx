import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  redo,
  undo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter, yamlLanguage } from "@codemirror/lang-yaml";
import { foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { QueryClientContext } from "@tanstack/react-query";
import { Toggle } from "@ui-sdk/react/toggle";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "@ui-sdk/react/toolbar";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ATTACHMENT_TYPES, uploadAttachment } from "../api";
import { adoptUserSheet } from "../customCss";
import { matchCodeLanguage } from "../editorCodeLanguages";
import { type CompletionSources, pkmCompletions } from "../editorCompletion";
import { focusMode, typewriterMode } from "../editorModes";
import type { Frontmatter } from "../frontmatter";
import { imagePreviews } from "../imagePreviews";
import { dragHasFiles, imageFiles, imagePlaceholders, insertImages } from "../imageUploads";
import {
  continueListItem,
  cycleHeading,
  indentListItem,
  insertWikilink,
  outdentListItem,
  smartPaste,
  toggleTask,
} from "../markdownEditing";
import { usePkm } from "../pkm";
import { hasQueryFence } from "../queryFormat";
import { type QueryPreviewSources, queryPreviews, refreshQueryPreviews } from "../queryPreviews";
import { getSettings } from "../settings";
import { SyncQueueContext } from "../syncQueue";
import { toggleTaskAt } from "../taskToggle";
import type { TemplateNote } from "../templates";
import { useVaultDocuments } from "../useVaultDocuments";
import { saveVaultDocument, type VaultDocument } from "../vaultDocuments";
import { getViewPrefs, setViewPref, useViewPrefs } from "../viewPrefs";
import { noteStem } from "../wikilinks";
import { AccessoryBar, type AccessoryAction } from "./AccessoryBar";
import {
  BoldIcon,
  CheckSquareIcon,
  CodeBlockIcon,
  CodeIcon,
  FocusIcon,
  HashIcon,
  ImageIcon,
  IndentIcon,
  ItalicIcon,
  KeyboardDismissIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  OutdentIcon,
  QuoteIcon,
  RedoIcon,
  StrikethroughIcon,
  TypewriterIcon,
  UndoIcon,
} from "./icons";

function detectLineSeparator(text: string): string {
  return /\r\n|\n|\r/.exec(text)?.[0] ?? "\n";
}

const MARKDOWN_EDITING = [
  Prec.high(
    keymap.of([
      { key: "Enter", run: continueListItem },
      { key: "Tab", run: indentListItem, shift: outdentListItem },
    ]),
  ),
  foldGutter(),
  keymap.of(foldKeymap),
  EditorView.domEventHandlers({
    paste: (event, view) => {
      const spec = smartPaste(view.state, event.clipboardData?.getData("text/plain") ?? "");
      if (spec === null) {
        return false;
      }
      event.preventDefault();
      view.dispatch(spec);
      return true;
    },
  }),
];

function wrapSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
): boolean {
  const tr = view.state.changeByRange((range) => {
    const selected = view.state.sliceDoc(range.from, range.to);
    if (selected.length === 0) {
      const insert = `${before}${placeholder}${after}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(
          range.from + before.length,
          range.from + before.length + placeholder.length,
        ),
      };
    }

    // Unwrap if the surrounding markers match.
    const prefixStart = range.from - before.length;
    const suffixEnd = range.to + after.length;
    if (
      prefixStart >= 0 &&
      suffixEnd <= view.state.doc.length &&
      view.state.sliceDoc(prefixStart, range.from) === before &&
      view.state.sliceDoc(range.to, suffixEnd) === after
    ) {
      return {
        changes: [
          { from: prefixStart, to: range.from, insert: "" },
          { from: range.to, to: suffixEnd, insert: "" },
        ],
        range: EditorSelection.range(prefixStart, prefixStart + selected.length),
      };
    }

    // Unwrap if the selection itself includes the markers.
    if (
      selected.length >= before.length + after.length &&
      selected.startsWith(before) &&
      selected.endsWith(after)
    ) {
      const inner = selected.slice(before.length, selected.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }

    const insert = `${before}${selected}${after}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(
        range.from + before.length,
        range.from + before.length + selected.length,
      ),
    };
  });

  view.dispatch(tr);
  view.focus();
  return true;
}

function toggleHeading(view: EditorView, level: 1 | 2 | 3): boolean {
  const prefix = `${"#".repeat(level)} `;
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const existing = /^(#{1,6})\s+/.exec(line.text);

  if (existing && existing[1].length === level) {
    view.dispatch({
      changes: { from: line.from, to: line.from + existing[0].length, insert: "" },
    });
  } else if (existing) {
    view.dispatch({
      changes: { from: line.from, to: line.from + existing[0].length, insert: prefix },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: prefix },
    });
  }
  view.focus();
  return true;
}

function toggleLinePrefix(view: EditorView, prefix: string, numbered = false): boolean {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const lines = [];
  for (let n = startLine.number; n <= endLine.number; n += 1) {
    lines.push(view.state.doc.line(n));
  }

  const allPrefixed = numbered
    ? lines.every((l) => /^\d+\.\s+/.test(l.text))
    : lines.every((l) => l.text.startsWith(prefix));

  const changes = lines.map((line, index) => {
    if (allPrefixed) {
      const matchLen = numbered ? (/^\d+\.\s+/.exec(line.text)?.[0].length ?? 0) : prefix.length;
      return { from: line.from, to: line.from + matchLen, insert: "" };
    }
    const insert = numbered ? `${index + 1}. ` : prefix;
    return { from: line.from, to: line.from, insert };
  });

  view.dispatch({ changes });
  view.focus();
  return true;
}

function insertCodeBlock(view: EditorView): boolean {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  const body = selected || "code";
  const insert = `\`\`\`\n${body}\n\`\`\``;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(range.from + 4, range.from + 4 + body.length),
  });
  view.focus();
  return true;
}

function insertLink(view: EditorView): boolean {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  const label = selected || "link text";
  const url = "https://";
  const insert = `[${label}](${url})`;
  const urlStart = range.from + 1 + label.length + 2;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + url.length),
  });
  view.focus();
  return true;
}

const MARKDOWN_HIGHLIGHT = HighlightStyle.define([
  {
    tag: t.heading1,
    fontSize: "1.6em",
    fontWeight: "700",
    lineHeight: "1.3",
    color: "var(--cm-heading, #0a0a0a)",
  },
  {
    tag: t.heading2,
    fontSize: "1.35em",
    fontWeight: "700",
    lineHeight: "1.35",
    color: "var(--cm-heading, #0a0a0a)",
  },
  {
    tag: t.heading3,
    fontSize: "1.15em",
    fontWeight: "600",
    lineHeight: "1.4",
    color: "var(--cm-heading, #0a0a0a)",
  },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    fontWeight: "600",
    color: "var(--cm-heading, #0a0a0a)",
  },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--cm-muted, #737373)" },
  {
    tag: t.monospace,
    fontFamily:
      "var(--markyard-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
    fontSize: "0.9em",
    backgroundColor: "var(--cm-code-bg, #f5f5f5)",
    color: "var(--cm-code-fg, #171717)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
  {
    tag: [t.link, t.url],
    color: "var(--markyard-accent, var(--cm-link, #2563eb))",
    textDecoration: "underline",
  },
  { tag: t.quote, color: "var(--cm-quote, #525252)", fontStyle: "italic" },
  { tag: t.processingInstruction, color: "var(--cm-muted, #737373)" },
  { tag: t.propertyName, color: "var(--cm-yaml-key, #0369a1)" },
  { tag: t.string, color: "var(--cm-yaml-string, #047857)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--cm-yaml-atom, #b45309)" },
  { tag: t.comment, color: "var(--cm-yaml-comment, #737373)", fontStyle: "italic" },
  {
    tag: [t.meta, t.separator, t.punctuation, t.squareBracket, t.brace],
    color: "var(--cm-yaml-fence, var(--cm-muted, #737373))",
  },
]);

const CODE_HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.modifier], color: "var(--cm-code-keyword, #6d28d9)" },
  {
    tag: [t.typeName, t.className, t.tagName, t.namespace, t.macroName, t.standard(t.variableName)],
    color: "var(--cm-code-type, #be123c)",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)],
    color: "var(--cm-code-function, var(--cm-link, #2563eb))",
  },
  {
    tag: [t.attributeName, t.special(t.variableName)],
    color: "var(--cm-yaml-key, #0369a1)",
  },
  {
    tag: [t.regexp, t.special(t.string), t.inserted],
    color: "var(--cm-yaml-string, #047857)",
  },
  { tag: t.self, color: "var(--cm-yaml-atom, #b45309)" },
  {
    tag: [t.operator, t.derefOperator, t.definitionOperator, t.typeOperator, t.controlOperator],
    color: "var(--cm-quote, #525252)",
  },
  { tag: [t.paren, t.angleBracket], color: "var(--cm-yaml-fence, var(--cm-muted, #737373))" },
  { tag: [t.deleted, t.invalid], color: "var(--cm-code-deleted, #b91c1c)" },
]);

const YAML_HIGHLIGHT = HighlightStyle.define(
  [
    { tag: t.content, color: "var(--cm-yaml-string, #047857)" },
    { tag: [t.labelName, t.typeName, t.keyword], color: "var(--cm-yaml-atom, #b45309)" },
  ],
  { scope: yamlLanguage },
);

const EDITOR_THEME = EditorView.theme({
  "&": {
    minHeight: "60vh",
    height: "100%",
    cursor: "text",
    backgroundColor: "var(--cm-bg, transparent)",
    color: "var(--cm-fg, #171717)",
    fontFamily:
      'var(--markyard-font-text, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
    fontSize: "var(--markyard-text-size, 0.9375rem)",
    lineHeight: "var(--markyard-line-height, 1.7)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    outline: "none",
    padding: "0.25rem 0 4rem",
    caretColor: "var(--cm-caret, #171717)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--cm-caret, #171717)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "var(--cm-selection, rgba(37, 99, 235, 0.16))",
    },
  ".cm-scroller": {
    minHeight: "60vh",
    fontFamily: "inherit",
    overflow: "visible",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--cm-muted, #737373)",
  },
});

const TOOLBAR_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-950 focus-visible:outline-2 focus-visible:outline-blue-600 data-pressed:bg-blue-100 data-pressed:text-blue-700 data-pressed:ring-1 data-pressed:ring-inset data-pressed:ring-blue-300 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-50 dark:data-pressed:bg-blue-950/70 dark:data-pressed:text-blue-300 dark:data-pressed:ring-blue-800";

/** Indents a list item, or the line with the default indent unit elsewhere. */
function indent(view: EditorView): boolean {
  return indentListItem(view) || indentMore(view);
}

function outdent(view: EditorView): boolean {
  return outdentListItem(view) || indentLess(view);
}

/** Marks a transaction that re-syncs the editor with text changed outside it (not a user edit). */
const externalSync = Annotation.define<boolean>();

/**
 * Brings a kept-alive editor up to date with `text` (e.g. a task ticked in Preview) using the
 * smallest single replacement, so the selection and undo history around it survive.
 */
function syncDocument(view: EditorView, text: string, addToHistory = false): void {
  const current = view.state.doc.toString();
  const target = text.split(/\r\n|\r|\n/).join("\n");
  if (current === target) {
    return;
  }
  let start = 0;
  const maxStart = Math.min(current.length, target.length);
  while (start < maxStart && current.charCodeAt(start) === target.charCodeAt(start)) {
    start += 1;
  }
  let endCurrent = current.length;
  let endTarget = target.length;
  while (
    endCurrent > start &&
    endTarget > start &&
    current.charCodeAt(endCurrent - 1) === target.charCodeAt(endTarget - 1)
  ) {
    endCurrent -= 1;
    endTarget -= 1;
  }
  view.dispatch({
    changes: { from: start, to: endCurrent, insert: target.slice(start, endTarget) },
    annotations: [externalSync.of(true), Transaction.addToHistory.of(addToHistory)],
  });
}

export interface EditorHandle {
  focus: (toEnd?: boolean) => void;
  goToLine: (lineNumber: number) => void;
  /**
   * Replaces the text with `text` as one undoable edit (smallest single change), without
   * reporting it through `onChange`: the caller already owns the new text.
   */
  replaceText: (text: string) => void;
  /**
   * Syncs the editor buffer to `text` without recording an undo entry or firing `onChange`
   * (e.g. when switching between Visual body-only and Raw YAML full-doc mode), optionally moving
   * the cursor to `cursorPos`.
   */
  syncText: (text: string, cursorPos?: number) => void;
}

const IMAGE_ACCEPT = ATTACHMENT_TYPES.join(",");

interface ImageHandlers {
  insert: (view: EditorView, files: readonly File[], pos: number) => void;
  setDropTarget: (active: boolean) => void;
}

/** Mounted only when the open note has a ` ```query ` block, so normal notes do zero IndexedDB scans. */
function QueryDocsBridge({
  enabled,
  onDocs,
}: {
  enabled: boolean;
  onDocs: (docs: readonly VaultDocument[] | null) => void;
}) {
  const docs = useVaultDocuments(enabled);
  useEffect(() => {
    onDocs(docs);
  }, [docs, onDocs]);
  return null;
}

export function Editor({
  initialText,
  onChange,
  onToggleTask,
  getFullText,
  onUploadingChange,
  editorRef,
  autoFocus = false,
  initialCursor,
  frontmatter,
  active = true,
  text,
  aboveEditor,
}: {
  initialText: string;
  onChange: (text: string) => void;
  /** Called when an inline query widget toggles a task inside the currently open note. */
  onToggleTask?: (nextText: string) => void;
  /** Returns the open note's latest full Markdown (frontmatter + body) so live queries never read stale autosave buffers. */
  getFullText?: () => string;
  /** Called when inline image uploads start or finish (`true` while at least one is in flight). */
  onUploadingChange?: (uploading: boolean) => void;
  editorRef?: RefObject<EditorHandle | null>;
  autoFocus?: boolean;
  /** Optional initial caret offset inside `initialText` (overrides the autoFocus end-of-doc jump). */
  initialCursor?: number;
  /** Parsed frontmatter of the full note (for `/` template `{{fm.<key>}}` lookups in visual mode). */
  frontmatter?: Frontmatter | null;
  /**
   * Whether the editor is showing. A kept-alive editor stays mounted while hidden, so switching
   * back from Preview is instant; on becoming active it catches up with `text` and takes focus
   * when `autoFocus` asks for it, keeping its last cursor position.
   */
  active?: boolean;
  /** The note's current text, for catching up after it changed while the editor was hidden. */
  text?: string;
  /** Optional content rendered between the formatting toolbar and the CodeMirror editor surface. */
  aboveEditor?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialTextRef = useRef(initialText);
  const initialCursorRef = useRef(initialCursor);
  const frontmatterRef = useRef(frontmatter);
  frontmatterRef.current = frontmatter;
  const onChangeRef = useRef(onChange);
  const onToggleTaskRef = useRef(onToggleTask);
  onToggleTaskRef.current = onToggleTask;
  const getFullTextRef = useRef(getFullText);
  getFullTextRef.current = getFullText;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const textRef = useRef(text);
  textRef.current = text;
  const activeRef = useRef(active);
  const focusModeRef = useRef(new Compartment());
  const typewriterRef = useRef(new Compartment());
  const prefs = useViewPrefs();
  const pkm = usePkm();
  const pkmRef = useRef(pkm);
  pkmRef.current = pkm;
  const queryClient = useContext(QueryClientContext);
  const syncQueue = useContext(SyncQueueContext);
  const syncQueueRef = useRef(syncQueue);
  syncQueueRef.current = syncQueue;
  const queryDocsRef = useRef<readonly VaultDocument[] | null>(queryClient ? null : []);
  const queryOverridesRef = useRef<Map<string, { baseText: string; text: string }>>(new Map());
  const queryVersionRef = useRef(0);
  const [hasQueryBlocks, setHasQueryBlocks] = useState(() => hasQueryFence(text ?? initialText));
  const bumpQueryWidgets = useCallback(() => {
    queryVersionRef.current += 1;
    viewRef.current?.dispatch({
      effects: refreshQueryPreviews.of(queryVersionRef.current),
    });
  }, []);
  const handleQueryDocs = useCallback(
    (docs: readonly VaultDocument[] | null) => {
      if (docs === queryDocsRef.current) {
        return;
      }
      queryDocsRef.current = docs;
      bumpQueryWidgets();
    },
    [bumpQueryWidgets],
  );
  const templatesRef = useRef<readonly TemplateNote[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const imageHandlersRef = useRef<ImageHandlers>(null as unknown as ImageHandlers);
  imageHandlersRef.current = {
    insert: (view, files, pos) => {
      if (files.length === 0) {
        return;
      }
      setUploadError(null);
      insertImages(view, files, pos, {
        upload: (file) => uploadAttachment(file, undefined, getSettings().attachmentsFolder),
        onStart: () => setUploading((n) => n + 1),
        onSettled: () => setUploading((n) => Math.max(0, n - 1)),
        onError: setUploadError,
      });
    },
    setDropTarget,
  };

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onUploadingChange?.(uploading > 0);
  }, [uploading, onUploadingChange]);

  useEffect(() => () => onUploadingChange?.(false), [onUploadingChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const separator = detectLineSeparator(initialTextRef.current);
    const initialPrefs = getViewPrefs();
    const formattingKeymap = keymap.of([
      { key: "Mod-b", run: (view) => wrapSelection(view, "**", "**", "bold") },
      { key: "Mod-i", run: (view) => wrapSelection(view, "*", "*", "italic") },
      { key: "Mod-e", run: (view) => wrapSelection(view, "`", "`", "code") },
      { key: "Mod-Shift-k", run: (view) => insertLink(view) },
    ]);

    const completionSources: CompletionSources = {
      getNotes: () => pkmRef.current?.notes ?? [],
      getTemplates: () => templatesRef.current,
      loadTemplates: async () => {
        const load = pkmRef.current?.loadTemplates;
        if (load !== undefined) {
          templatesRef.current = await load();
        }
      },
      getTitle: () => {
        const current = pkmRef.current;
        const note = current?.notes.find((n) => n.id === current.currentFileId);
        return note === undefined ? "" : noteStem(note.name);
      },
      getFolder: () => {
        const current = pkmRef.current;
        const note = current?.notes.find((n) => n.id === current.currentFileId);
        return note === undefined ? "" : note.path.join("/");
      },
      getFrontmatter: () => frontmatterRef.current ?? null,
    };

    const getEffectiveQueryDocs = (): readonly VaultDocument[] | null => {
      const docs = queryDocsRef.current;
      if (docs === null) {
        return null;
      }
      const currentFileId = pkmRef.current?.currentFileId ?? null;
      const liveFullText = getFullTextRef.current?.();
      return docs.map((doc) => {
        if (currentFileId !== null && doc.id === currentFileId && liveFullText !== undefined) {
          return doc.text === liveFullText ? doc : { ...doc, text: liveFullText };
        }
        const override = queryOverridesRef.current.get(doc.id);
        if (override !== undefined && override.baseText === doc.text) {
          return { ...doc, text: override.text };
        }
        return doc;
      });
    };

    const querySources: QueryPreviewSources = {
      getDocs: getEffectiveQueryDocs,
      getTotalNotes: () => pkmRef.current?.notes.length ?? queryDocsRef.current?.length ?? 0,
      canOpenNote: () => pkmRef.current !== null,
      openNote: (id) => pkmRef.current?.openNote(id),
      canToggleTasks: () => onToggleTaskRef.current !== undefined && syncQueueRef.current !== null,
      toggleTask: (noteId, offset) => {
        const onToggle = onToggleTaskRef.current;
        const queue = syncQueueRef.current;
        const docs = getEffectiveQueryDocs();
        const rawDocs = queryDocsRef.current;
        if (onToggle === undefined || queue === null || docs === null || rawDocs === null) {
          return false;
        }
        const current = docs.find((entry) => entry.id === noteId);
        const original = rawDocs.find((entry) => entry.id === noteId);
        if (current === undefined || original === undefined) {
          return false;
        }
        const next = toggleTaskAt(current.text, offset);
        if (next === null) {
          return false;
        }
        if (noteId === pkmRef.current?.currentFileId) {
          onToggle(next);
          queryVersionRef.current += 1;
          viewRef.current?.dispatch({
            effects: refreshQueryPreviews.of(queryVersionRef.current),
          });
        } else {
          queryOverridesRef.current.set(noteId, { baseText: original.text, text: next });
          saveVaultDocument(queue, current, next);
          queryVersionRef.current += 1;
          viewRef.current?.dispatch({
            effects: refreshQueryPreviews.of(queryVersionRef.current),
          });
        }
        return true;
      },
    };

    const images = () => imageHandlersRef.current;
    const imageEvents = Prec.high(
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const files = imageFiles(event.clipboardData);
          // Office apps put a rendered image next to the copied text: keep those as text.
          if (files.length === 0 || (event.clipboardData?.getData("text/plain") ?? "") !== "") {
            return false;
          }
          event.preventDefault();
          images().insert(view, files, view.state.selection.main.head);
          return true;
        },
        dragover: (event) => {
          if (!dragHasFiles(event.dataTransfer)) {
            return false;
          }
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "copy";
          }
          images().setDropTarget(true);
          return true;
        },
        dragleave: (event, view) => {
          if (event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget)) {
            return false;
          }
          images().setDropTarget(false);
          return false;
        },
        dragend: () => {
          images().setDropTarget(false);
          return false;
        },
        drop: (event, view) => {
          images().setDropTarget(false);
          const files = imageFiles(event.dataTransfer);
          if (files.length === 0) {
            return false;
          }
          event.preventDefault();
          let pos: number | null = null;
          try {
            pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          } catch {
            // Layout is unavailable (e.g. a hidden editor): fall back to the cursor.
          }
          images().insert(view, files, pos ?? view.state.selection.main.head);
          return true;
        },
      }),
    );

    const state = EditorState.create({
      doc: initialTextRef.current,
      extensions: [
        EDITOR_THEME,
        yamlFrontmatter({
          content: markdown({ base: markdownLanguage, codeLanguages: matchCodeLanguage }),
        }),
        syntaxHighlighting(MARKDOWN_HIGHLIGHT),
        syntaxHighlighting(CODE_HIGHLIGHT),
        syntaxHighlighting(YAML_HIGHLIGHT),
        history(),
        imagePlaceholders,
        imagePreviews,
        queryPreviews(querySources),
        imageEvents,
        MARKDOWN_EDITING,
        pkmCompletions(completionSources),
        formattingKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        focusModeRef.current.of(initialPrefs.focusMode ? focusMode : []),
        typewriterRef.current.of(initialPrefs.typewriterMode ? typewriterMode : []),
        EditorView.contentAttributes.of({ "aria-label": "Note text" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const serialized = update.state.doc.sliceString(0, undefined, separator);
            const found = hasQueryFence(serialized);
            setHasQueryBlocks((prev) => (prev === found ? prev : found));
            if (!update.transactions.some((tr) => tr.annotation(externalSync) === true)) {
              onChangeRef.current(serialized);
            }
          }
        }),
      ],
    });
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const view = new EditorView({ state, parent: shadow, root: shadow });
    adoptUserSheet(shadow);
    viewRef.current = view;
    if (editorRef) {
      editorRef.current = {
        focus: (toEnd = false) => {
          if (toEnd) {
            const end = view.state.doc.length;
            view.dispatch({ selection: EditorSelection.cursor(end) });
          }
          view.focus();
        },
        goToLine: (lineNumber: number) => {
          const clamped = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
          const line = view.state.doc.line(clamped);
          view.dispatch({
            selection: EditorSelection.cursor(line.from),
            effects: EditorView.scrollIntoView(line.from, { y: "center" }),
          });
          view.focus();
        },
        replaceText: (nextText: string) => syncDocument(view, nextText, true),
        syncText: (nextText: string, cursorPos?: number) => {
          syncDocument(view, nextText, false);
          if (cursorPos !== undefined) {
            const clamped = Math.max(0, Math.min(cursorPos, view.state.doc.length));
            view.dispatch({ selection: EditorSelection.cursor(clamped) });
          }
        },
      };
    }
    if (initialCursorRef.current !== undefined) {
      const pos = Math.max(0, Math.min(initialCursorRef.current, view.state.doc.length));
      view.dispatch({ selection: EditorSelection.cursor(pos) });
      if (autoFocusRef.current) {
        view.focus();
      }
    } else if (autoFocusRef.current) {
      const end = view.state.doc.length;
      if (end > 0) {
        view.dispatch({ selection: EditorSelection.cursor(end) });
      }
      view.focus();
    }
    return () => {
      if (editorRef) {
        editorRef.current = null;
      }
      viewRef.current = null;
      view.destroy();
    };
  }, [editorRef]);

  // Hidden → shown: catch up with text edited elsewhere, then focus where the cursor was left.
  useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    const view = viewRef.current;
    if (!active || wasActive || view === null) {
      return;
    }
    if (textRef.current !== undefined) {
      syncDocument(view, textRef.current);
    }
    if (autoFocusRef.current) {
      view.focus();
    }
  }, [active]);

  const canToggleQueryTasks = onToggleTask !== undefined && syncQueue !== null;
  const canOpenQueryNote = pkm !== null;
  useEffect(() => {
    if (!hasQueryBlocks) {
      return;
    }
    bumpQueryWidgets();
  }, [hasQueryBlocks, canToggleQueryTasks, canOpenQueryNote, bumpQueryWidgets]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        focusModeRef.current.reconfigure(prefs.focusMode ? focusMode : []),
        typewriterRef.current.reconfigure(prefs.typewriterMode ? typewriterMode : []),
      ],
    });
  }, [prefs.focusMode, prefs.typewriterMode]);

  const run = (command: (view: EditorView) => boolean) => {
    if (viewRef.current) {
      command(viewRef.current);
    }
  };

  const keepFocus = (event: React.MouseEvent) => {
    event.preventDefault();
  };

  const pickImage = () => fileInputRef.current?.click();

  const accessoryActions: AccessoryAction[] = [
    {
      label: "Toggle task",
      icon: <CheckSquareIcon className="size-4" />,
      run: () => run(toggleTask),
    },
    { label: "Outdent", icon: <OutdentIcon className="size-4" />, run: () => run(outdent) },
    { label: "Indent", icon: <IndentIcon className="size-4" />, run: () => run(indent) },
    {
      label: "Wikilink",
      icon: <span className="font-mono">[[</span>,
      run: () => run(insertWikilink),
    },
    { label: "Heading", icon: <HashIcon className="size-4" />, run: () => run(cycleHeading) },
    {
      label: "Bold",
      icon: <BoldIcon className="size-4" />,
      run: () => run((v) => wrapSelection(v, "**", "**", "bold")),
    },
    { label: "Link", icon: <LinkIcon className="size-4" />, run: () => run(insertLink) },
    { label: "Insert image", icon: <ImageIcon className="size-4" />, run: pickImage },
    { label: "Undo", icon: <UndoIcon className="size-4" />, run: () => run(undo) },
    { label: "Redo", icon: <RedoIcon className="size-4" />, run: () => run(redo) },
    {
      label: "Dismiss keyboard",
      icon: <KeyboardDismissIcon className="size-4" />,
      run: () => viewRef.current?.contentDOM.blur(),
    },
  ];

  return (
    <div className="flex flex-1 flex-col space-y-3">
      <Toolbar
        aria-label="Markdown formatting"
        className="sticky top-0 z-10 flex items-center gap-0.5 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50/95 p-1 backdrop-blur-xs dark:border-neutral-800 dark:bg-neutral-900/95"
      >
        <ToolbarButton
          type="button"
          aria-label="Heading 1"
          title="Heading 1"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleHeading(v, 1))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Heading 2"
          title="Heading 2"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleHeading(v, 2))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Heading 3"
          title="Heading 3"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleHeading(v, 3))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          H3
        </ToolbarButton>

        <ToolbarSeparator className="mx-1 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />

        <ToolbarButton
          type="button"
          aria-label="Bold"
          title="Bold (Cmd/Ctrl+B)"
          onMouseDown={keepFocus}
          onClick={() => run((v) => wrapSelection(v, "**", "**", "bold"))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <BoldIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Italic"
          title="Italic (Cmd/Ctrl+I)"
          onMouseDown={keepFocus}
          onClick={() => run((v) => wrapSelection(v, "*", "*", "italic"))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <ItalicIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Strikethrough"
          title="Strikethrough"
          onMouseDown={keepFocus}
          onClick={() => run((v) => wrapSelection(v, "~~", "~~", "text"))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <StrikethroughIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Inline code"
          title="Inline code (Cmd/Ctrl+E)"
          onMouseDown={keepFocus}
          onClick={() => run((v) => wrapSelection(v, "`", "`", "code"))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <CodeIcon className="size-3.5" />
        </ToolbarButton>

        <ToolbarSeparator className="mx-1 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />

        <ToolbarButton
          type="button"
          aria-label="Bullet list"
          title="Bullet list"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleLinePrefix(v, "- "))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <ListIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Numbered list"
          title="Numbered list"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleLinePrefix(v, "1. ", true))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <ListOrderedIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Task list"
          title="Task list"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleLinePrefix(v, "- [ ] "))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <CheckSquareIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Quote"
          title="Quote"
          onMouseDown={keepFocus}
          onClick={() => run((v) => toggleLinePrefix(v, "> "))}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <QuoteIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Code block"
          title="Code block"
          onMouseDown={keepFocus}
          onClick={() => run(insertCodeBlock)}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <CodeBlockIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Link"
          title="Link (Cmd/Ctrl+Shift+K)"
          onMouseDown={keepFocus}
          onClick={() => run(insertLink)}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <LinkIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton
          type="button"
          aria-label="Insert image"
          title="Insert image (or paste / drop one)"
          onMouseDown={keepFocus}
          onClick={pickImage}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <ImageIcon className="size-3.5" />
        </ToolbarButton>

        <ToolbarSeparator className="mx-1 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />

        <Toggle
          aria-label="Focus mode"
          title="Focus mode: dim everything but the current paragraph"
          pressed={prefs.focusMode}
          onPressedChange={(pressed) => setViewPref("focusMode", pressed)}
          onMouseDown={keepFocus}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <FocusIcon className="size-3.5" />
        </Toggle>
        <Toggle
          aria-label="Typewriter mode"
          title="Typewriter mode: keep the current line centered"
          pressed={prefs.typewriterMode}
          onPressedChange={(pressed) => setViewPref("typewriterMode", pressed)}
          onMouseDown={keepFocus}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <TypewriterIcon className="size-3.5" />
        </Toggle>
      </Toolbar>

      {aboveEditor}

      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        aria-label="Choose an image to insert"
        onChange={(event) => {
          const input = event.currentTarget;
          const files = Array.from(input.files ?? []);
          input.value = "";
          const view = viewRef.current;
          if (view !== null) {
            imageHandlersRef.current.insert(view, files, view.state.selection.main.head);
          }
        }}
      />
      {uploading > 0 && (
        <p role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
          Uploading {uploading} {uploading === 1 ? "image" : "images"}…
        </p>
      )}
      {uploadError !== null && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300"
        >
          <p>{uploadError}</p>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300"
          >
            Dismiss
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        data-testid="editor-host"
        data-drop-target={dropTarget ? "true" : undefined}
        className="min-h-[60vh] flex-1 cursor-text rounded-lg transition-shadow data-[drop-target=true]:bg-blue-50/40 data-[drop-target=true]:ring-2 data-[drop-target=true]:ring-blue-400/60 dark:data-[drop-target=true]:bg-blue-950/20"
      />
      {hasQueryBlocks && queryClient && (
        <QueryDocsBridge enabled={active} onDocs={handleQueryDocs} />
      )}
      <AccessoryBar actions={accessoryActions} />
    </div>
  );
}
