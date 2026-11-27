import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkWikilinks } from "../remarkWikilinks";
import { MarkdownLink, WikilinkElement, WikilinkSourceContext } from "./MarkdownLinks";

const REMARK_PLUGINS = [remarkGfm, remarkWikilinks];

/** Phrasing elements kept; anything else (paragraphs, headings, lists, images) is unwrapped. */
const INLINE_ELEMENTS = ["strong", "em", "del", "code", "a", "br", "wikilink"];

const INLINE_COMPONENTS = {
  wikilink: WikilinkElement,
  a: MarkdownLink,
} as Components;

/**
 * One line of note text (e.g. a task) rendered as inline Markdown: emphasis, code, links and
 * `[[wikilinks]]` resolved from `sourceId`'s note. Raw HTML is dropped, as in Preview.
 */
export const InlineMarkdown = memo(function InlineMarkdown({
  text,
  sourceId,
}: {
  text: string;
  sourceId: string;
}) {
  return (
    <WikilinkSourceContext.Provider value={sourceId}>
      <Markdown
        components={INLINE_COMPONENTS}
        remarkPlugins={REMARK_PLUGINS}
        allowedElements={INLINE_ELEMENTS}
        unwrapDisallowed
        skipHtml
      >
        {text}
      </Markdown>
    </WikilinkSourceContext.Provider>
  );
});
