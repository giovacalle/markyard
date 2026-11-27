import { type ComponentPropsWithoutRef, createContext, type ReactNode, useContext } from "react";
import { usePkm } from "../pkm";
import { isExternalHref } from "../safeUrl";
import { resolveWikilink } from "../wikilinks";
import { ExternalLink } from "./LinkPreview";

/**
 * The note that relative `[[wikilinks]]` resolve against. `undefined` means the open note; a
 * query row sets it to the note the row came from.
 */
export const WikilinkSourceContext = createContext<string | undefined>(undefined);

/** A `[[wikilink]]`: opens the note it resolves to, or creates it when it does not exist yet. */
export function Wikilink({
  target,
  heading,
  children,
}: {
  target?: string;
  heading?: string;
  children?: ReactNode;
}) {
  const pkm = usePkm();
  const sourceId = useContext(WikilinkSourceContext);
  if (pkm === null) {
    return <span className="wikilink">{children}</span>;
  }
  const linkHeading = heading || undefined;
  const fromId = sourceId ?? pkm.currentFileId;
  const current = pkm.notes.find((note) => note.id === fromId);
  const resolved = target ? resolveWikilink(target, pkm.notes, current?.path) : (current ?? null);
  if (resolved === null) {
    const stem = (target ?? "").split("/").at(-1)?.trim() ?? "";
    return (
      <button
        type="button"
        className="wikilink wikilink-unresolved"
        title={`Create note “${stem}”`}
        onClick={(event) => {
          event.stopPropagation();
          if (stem.length > 0) {
            pkm.createNote(stem);
          }
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <a
      href={`/?file=${encodeURIComponent(resolved.id)}`}
      className="wikilink"
      data-note-id={resolved.id}
      onClick={(event) => {
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        pkm.openNote(resolved.id, { heading: linkHeading });
      }}
    >
      {children}
    </a>
  );
}

/** react-markdown renderer for the `wikilink` element emitted by `remarkWikilinks`. */
export function WikilinkElement({
  node: _node,
  ...props
}: {
  node?: unknown;
  target?: string;
  heading?: string;
  children?: ReactNode;
}) {
  return <Wikilink {...props} />;
}

/** react-markdown renderer for `a`: external links get the link-preview treatment. */
export function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  return isExternalHref(href) ? (
    <ExternalLink {...props} href={href}>
      {children}
    </ExternalLink>
  ) : (
    <a {...props} href={href}>
      {children}
    </a>
  );
}
