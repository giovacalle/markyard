// Pure CodeMirror commands for Markdown outliner editing and smart paste. They touch only the
// lines they edit, so the rest of the note keeps its exact bytes.
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";

const INDENT = "  ";
// indent, marker (`-`, `*`, `+`, `1.`, `1)`), spacing, optional task box.
const LIST_ITEM = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

function selectedLines(state: EditorState) {
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n += 1) {
      lines.set(n, state.doc.line(n));
    }
  }
  return [...lines.values()];
}

/** Tab on list items: indents every selected list line by two spaces. */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state);
  if (!lines.every((line) => LIST_ITEM.test(line.text))) {
    return false;
  }
  dispatch(
    state.update({
      changes: lines.map((line) => ({ from: line.from, insert: INDENT })),
      userEvent: "input.indent",
    }),
  );
  return true;
};

/** Shift+Tab on list items: removes up to two leading spaces from every selected list line. */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state);
  if (!lines.every((line) => LIST_ITEM.test(line.text))) {
    return false;
  }
  const changes = lines.map((line) => ({
    from: line.from,
    to: line.from + Math.min(INDENT.length, /^ */.exec(line.text)?.[0].length ?? 0),
  }));
  if (changes.some((change) => change.to > change.from)) {
    dispatch(state.update({ changes, userEvent: "delete.dedent" }));
  }
  return true;
};

const TASK_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Flips the task box of every selected line; plain lines and bullets become open tasks. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes = selectedLines(state).map((line) => {
    const task = TASK_BOX.exec(line.text);
    if (task) {
      const at = line.from + task[1].length + 1;
      return { from: at, to: at + 1, insert: task[2] === " " ? "x" : " " };
    }
    const marker = LIST_MARKER.exec(line.text);
    if (marker) {
      return { from: line.from + marker[0].length, insert: "[ ] " };
    }
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    return { from: line.from + indent, insert: "- [ ] " };
  });
  dispatch(state.update({ changes, userEvent: "input" }));
  return true;
};

/** Cycles the current line through no heading, `#`, `##` and `###`. */
export const cycleHeading: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const existing = /^(#{1,6})[ \t]+/.exec(line.text);
  const level = existing?.[1].length ?? 0;
  const next = level >= 3 ? 0 : level + 1;
  dispatch(
    state.update({
      changes: {
        from: line.from,
        to: line.from + (existing?.[0].length ?? 0),
        insert: next === 0 ? "" : `${"#".repeat(next)} `,
      },
      userEvent: "input",
    }),
  );
  return true;
};

/** Inserts `[[]]` with the cursor inside, or wraps each selection as `[[selection]]`. */
export const insertWikilink: StateCommand = ({ state, dispatch }) => {
  const spec = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: `[[${selected}]]` },
      range:
        selected.length === 0
          ? EditorSelection.cursor(range.from + 2)
          : EditorSelection.range(range.from + 2, range.from + 2 + selected.length),
    };
  });
  dispatch(state.update(spec, { userEvent: "input" }));
  return true;
};

function insideCode(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node.parent; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      return true;
    }
  }
  return false;
}

/**
 * Enter in a list item: continues the list (a task always continues as an empty `[ ]` box), or
 * clears the marker when the item is still empty.
 */
export const continueListItem: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || !range.empty) {
    return false;
  }
  const line = state.doc.lineAt(range.head);
  const match = LIST_ITEM.exec(line.text);
  if (!match || range.head - line.from < match[0].length || insideCode(state, line.from)) {
    return false;
  }

  if (line.text.slice(match[0].length).trim() === "") {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to },
        selection: EditorSelection.cursor(line.from),
        userEvent: "delete",
      }),
    );
    return true;
  }

  const [, indent, bullet, number, delimiter, spacing, task] = match;
  const marker = number === undefined ? bullet : `${Number(number) + 1}${delimiter}`;
  const insert = `${state.lineBreak}${indent}${marker}${spacing}${task === undefined ? "" : "[ ] "}`;
  dispatch(
    state.update({
      changes: { from: range.head, insert },
      selection: EditorSelection.cursor(range.head + insert.length),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

const HTTP_URL = /^https?:\/\/\S+$/i;

/** Converts tab-separated rows (2+ rows, 2+ columns) into a GFM table, or `null`. */
export function tsvToMarkdownTable(text: string): string | null {
  const rows = text
    .replace(/(\r\n|\r|\n)+$/, "")
    .split(/\r\n|\r|\n/)
    .map((row) => row.split("\t").map((cell) => cell.trim().replace(/\|/g, "\\|")));
  if (rows.length < 2 || rows.some((row) => row.length < 2)) {
    return null;
  }
  const width = Math.max(...rows.map((row) => row.length));
  const format = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [header, ...body] = rows;
  return [format(header), format(Array(width).fill("---")), ...body.map(format)].join("\n");
}

/** Returns the transaction for a smart paste (URL onto selection, TSV table), or `null`. */
export function smartPaste(state: EditorState, clipboard: string): TransactionSpec | null {
  const range = state.selection.main;
  const url = clipboard.trim();
  if (state.selection.ranges.length === 1 && !range.empty && HTTP_URL.test(url)) {
    const selected = state.sliceDoc(range.from, range.to);
    if (HTTP_URL.test(selected.trim())) {
      return null;
    }
    const insert = `[${selected}](${url})`;
    return {
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      userEvent: "input.paste",
    };
  }
  const table = tsvToMarkdownTable(clipboard);
  if (table === null) {
    return null;
  }
  return { ...state.replaceSelection(table), userEvent: "input.paste" };
}
