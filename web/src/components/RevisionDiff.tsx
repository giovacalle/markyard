// Loaded through import() only when a revision is compared, so @codemirror/merge stays out of the
// main bundle. Like the Editor, CodeMirror mounts in a shadow root to keep styles CSP-safe.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

const DIFF_THEME = EditorView.theme({
  "&": {
    maxHeight: "55vh",
    color: "var(--cm-fg, #171717)",
    fontSize: "0.8125rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
});

/**
 * Read-only unified diff: the revision's text, with the current note as the original, so
 * removed lines are what restoring would drop and added lines are what it would bring back.
 */
export function RevisionDiff({ current, revision }: { current: string; revision: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const view = new EditorView({
      state: EditorState.create({
        doc: revision,
        extensions: [
          DIFF_THEME,
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "Changes in this version" }),
          unifiedMergeView({ original: current, mergeControls: false, gutter: true }),
        ],
      }),
      parent: shadow,
      root: shadow,
    });
    return () => view.destroy();
  }, [current, revision]);

  return (
    <div
      ref={hostRef}
      data-testid="revision-diff-host"
      className="overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
    />
  );
}
