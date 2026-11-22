// Loaded through import() only after a refused (412) save, so @codemirror/merge costs nothing
// otherwise. Like the Editor, CodeMirror mounts in a shadow root to keep styles CSP-safe.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

const MERGE_THEME = EditorView.theme({
  "&": {
    maxHeight: "60vh",
    color: "var(--cm-fg, #171717)",
    fontSize: "0.875rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-content": { caretColor: "var(--cm-caret, #171717)" },
});

const BUTTON_CLASS =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800";

/**
 * Unified diff of the user's text (editable) against the Drive version: each hunk can be
 * accepted (keep mine) or rejected (take Drive's), or the text edited freely before saving.
 */
export function ConflictMerge({
  mine,
  remote,
  onSave,
  onCancel,
}: {
  mine: string;
  remote: string;
  onSave: (merged: string) => void;
  onCancel: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const separator = /\r\n|\n|\r/.exec(mine)?.[0] ?? /\r\n|\n|\r/.exec(remote)?.[0] ?? "\n";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const view = new EditorView({
      state: EditorState.create({
        doc: mine,
        extensions: [
          MERGE_THEME,
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Merged text" }),
          unifiedMergeView({ original: remote, mergeControls: true, gutter: true }),
        ],
      }),
      parent: shadow,
      root: shadow,
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [mine, remote]);

  return (
    <section
      aria-label="Compare and merge"
      className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30"
    >
      <p className="text-neutral-700 dark:text-neutral-300">
        Removed lines are the Drive version, added lines are yours. Accept or reject each change, or
        edit the text, then save.
      </p>
      <div
        ref={hostRef}
        data-testid="merge-host"
        className="overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      />
      <div className="flex gap-2">
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={() => {
            const view = viewRef.current;
            if (view) {
              onSave(view.state.doc.sliceString(0, undefined, separator));
            }
          }}
        >
          Save merged
        </button>
        <button type="button" className={BUTTON_CLASS} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
