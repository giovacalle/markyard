// Loaded through import() only when the user copies a note as rich text.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders Markdown to static HTML with raw HTML skipped, like the Preview. */
export function markdownToHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm], skipHtml: true }, markdown),
  );
}
