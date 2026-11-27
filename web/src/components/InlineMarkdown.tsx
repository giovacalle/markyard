import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkWikilinks } from "../remarkWikilinks";
import { MarkdownLink, WikilinkElement, WikilinkSourceContext } from "./MarkdownLinks";

const REMARK_PLUGINS = [remarkGfm, remarkWikilinks];

/** Phrasing elements kept; anything else (the task list wrapper, its checkbox) is unwrapped. */
const INLINE_ELEMENTS = ["strong", "em", "del", "code", "a", "br", "img", "wikilink"];

const INLINE_COMPONENTS = {
  wikilink: WikilinkElement,
  a: MarkdownLink,
  img: ({ alt }) => alt ?? null,
} as Components;

/** Text that could hold inline Markdown; anything else renders as-is without parsing. */
const MARKUP = /[*_`~[\]<>\\!&]|:\/\/|www\.|\w@/;

/**
 * A task's text rendered as inline Markdown, as Preview shows it after the checkbox: emphasis,
 * code, links and `[[wikilinks]]` resolved from `sourceId`'s note. Raw HTML is dropped.
 */
export const InlineMarkdown = memo(function InlineMarkdown({
  text,
  sourceId,
}: {
  text: string;
  sourceId: string;
}) {
  if (!MARKUP.test(text)) {
    return text;
  }
  // Parsed as a task item so a leading `2.`, `-`, `>` or `#` stays text, as in Preview.
  return (
    <WikilinkSourceContext.Provider value={sourceId}>
      <Markdown
        components={INLINE_COMPONENTS}
        remarkPlugins={REMARK_PLUGINS}
        allowedElements={INLINE_ELEMENTS}
        unwrapDisallowed
        skipHtml
      >
        {`- [ ] ${text}`}
      </Markdown>
    </WikilinkSourceContext.Provider>
  );
});
