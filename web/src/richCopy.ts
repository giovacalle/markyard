import { parseFrontmatter } from "./frontmatter";

type RichClipboard = Pick<Clipboard, "writeText"> & Partial<Pick<Clipboard, "write">>;

/** The note without its leading frontmatter block. */
export function noteBody(markdown: string): string {
  const frontmatter = parseFrontmatter(markdown);
  return frontmatter === null ? markdown : markdown.slice(frontmatter.end).replace(/^\r?\n/, "");
}

/**
 * Copies the note body as `text/html` + `text/plain`, or as plain Markdown without ClipboardItem.
 * The ClipboardItem is created synchronously (Safari needs that inside the user gesture) while
 * the HTML renderer loads lazily behind a promise.
 */
export function copyAsRichText(
  markdown: string,
  clipboard: RichClipboard = navigator.clipboard,
): Promise<void> {
  const plain = noteBody(markdown);
  if (typeof ClipboardItem === "undefined" || clipboard.write === undefined) {
    return clipboard.writeText(plain);
  }
  const html = import("./richHtml").then(
    ({ markdownToHtml }) => new Blob([markdownToHtml(plain)], { type: "text/html" }),
  );
  return clipboard.write([
    new ClipboardItem({
      "text/html": html,
      "text/plain": new Blob([plain], { type: "text/plain" }),
    }),
  ]);
}
