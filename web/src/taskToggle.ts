import { parseTasks } from "./tasks";

const TASK_ITEM = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/y;

/** Identity of a rendered task row used to guard toggles against stale offsets. */
export interface TaskSnapshot {
  offset: number;
  text: string;
  done: boolean;
}

/**
 * Toggles the GFM task checkbox of the list item whose source starts at `offset` (the parser's
 * `position.start.offset`). Only the single `[ ]`/`[x]` character changes, so every other byte
 * (frontmatter, line endings, spacing, wikilinks) survives untouched. Returns null when no task
 * marker starts there.
 */
export function toggleTaskAt(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) {
    return null;
  }
  TASK_ITEM.lastIndex = offset;
  const match = TASK_ITEM.exec(text);
  if (match === null) {
    return null;
  }
  const charIndex = offset + match[0].length - 2;
  const next = match[1] === " " ? "x" : " ";
  return `${text.slice(0, charIndex)}${next}${text.slice(charIndex + 1)}`;
}

/**
 * Toggles `task` in `text` only when the task parsed at `task.offset` still has the same trimmed
 * text and done state. Returns null when the note changed around `task.offset` (or the offset is
 * no longer a task outside a code fence) so stale clicks never mutate a different task.
 */
export function toggleTaskIfUnchanged(text: string, task: TaskSnapshot): string | null {
  const current = parseTasks(text).find((entry) => entry.offset === task.offset);
  if (current === undefined || current.text !== task.text || current.done !== task.done) {
    return null;
  }
  return toggleTaskAt(text, task.offset);
}
