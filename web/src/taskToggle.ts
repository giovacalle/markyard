const TASK_ITEM = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/y;

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
