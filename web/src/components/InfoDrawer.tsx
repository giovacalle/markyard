import { useQuery } from "@tanstack/react-query";
import { type RefObject, useMemo, useRef, useState } from "react";
import { fetchAttachments } from "../api";
import {
  type AttachmentRef,
  attachmentUrl,
  extractAttachmentRefs,
  removeAttachmentRefs,
} from "../attachmentRefs";
import { extractHeadings, type HeadingItem } from "../commandSearch";
import { documentStats } from "../documentStats";
import type { Frontmatter } from "../frontmatter";
import { findBacklinks } from "../linkIndex";
import { usePkm } from "../pkm";
import { useSettings } from "../settings";
import { useVaultDocuments } from "../useVaultDocuments";
import { noteStem } from "../wikilinks";
import { attachmentsQueryKey, AttachmentThumb, RemoveAttachmentDialog } from "./AttachmentDialogs";
import { CloseIcon, TrashIcon } from "./icons";

const LEVEL_INDENT = ["pl-2", "pl-2", "pl-5", "pl-8", "pl-11", "pl-14", "pl-17"];

/**
 * Full-height right sidebar mirroring the left file sidebar: shows the note's outline, stats and
 * frontmatter properties. Docked beside the document column on desktop; a fixed overlay sheet with
 * a backdrop on narrow screens.
 */
/** "Linked mentions": every locally cached note whose wikilinks resolve to `fileId`. */
function Backlinks({ fileId }: { fileId: string }) {
  const pkm = usePkm();
  const docs = useVaultDocuments(pkm !== null);
  const backlinks = useMemo(
    () => (pkm === null || docs === null ? null : findBacklinks(fileId, docs, pkm.notes)),
    [fileId, docs, pkm],
  );
  if (pkm === null) {
    return null;
  }
  return (
    <section aria-label="Backlinks" className="space-y-1.5">
      <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
        Linked mentions
        {backlinks !== null && backlinks.length > 0 && (
          <span className="ml-1 tabular-nums">· {backlinks.length}</span>
        )}
      </h3>
      {backlinks === null ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">Scanning notes…</p>
      ) : backlinks.length === 0 ? (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">No notes link here yet.</p>
      ) : (
        <ul className="space-y-1">
          {backlinks.map(({ note, contexts }) => (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => pkm.openNote(note.id)}
                className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
              >
                <span className="block truncate font-medium text-neutral-800 dark:text-neutral-200">
                  {noteStem(note.name)}
                </span>
                {note.path.length > 0 && (
                  <span className="block truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                    {note.path.join(" / ")}
                  </span>
                )}
                {contexts.map((context) => (
                  <span
                    key={context.line}
                    className="mt-0.5 block line-clamp-2 break-words text-xs text-neutral-500 dark:text-neutral-400"
                  >
                    {context.text}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!pkm.vaultPinned && (
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
          Pin vault offline for full-vault backlinks.
        </p>
      )}
    </section>
  );
}

/** The images the open note embeds from `_attachments`, each removable from the note or Drive. */
function NoteAttachments({
  text,
  readOnly,
  offline,
  onEditText,
}: {
  text: string;
  readOnly: boolean;
  offline: boolean;
  onEditText?: (nextText: string) => void;
}) {
  const { attachmentsFolder } = useSettings();
  const refs = useMemo(() => extractAttachmentRefs(text), [text]);
  const textRef = useRef(text);
  textRef.current = text;
  const [removing, setRemoving] = useState<AttachmentRef | null>(null);
  // Filenames, when the Attachments list was already loaded; never fetched from here.
  const listing = useQuery({
    queryKey: attachmentsQueryKey(attachmentsFolder),
    queryFn: ({ signal }) => fetchAttachments(signal, attachmentsFolder),
    enabled: false,
  });
  const names = useMemo(
    () => new Map((listing.data?.attachments ?? []).map((item) => [item.id, item.name])),
    [listing.data],
  );
  if (refs.length === 0) {
    return null;
  }
  const label = (ref: AttachmentRef) => ref.alt.trim() || names.get(ref.id) || ref.id;
  const editable = !readOnly && onEditText !== undefined;

  return (
    <section aria-label="Attachments" className="space-y-1.5">
      <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
        Attachments
        <span className="ml-1 tabular-nums">· {refs.length}</span>
      </h3>
      <ul className="space-y-1">
        {refs.map((ref) => (
          <li
            key={ref.id}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60"
          >
            <AttachmentThumb
              src={attachmentUrl(ref.id)}
              alt={label(ref)}
              className="size-8 shrink-0 rounded border border-neutral-200 dark:border-neutral-700"
            />
            <span className="min-w-0 flex-1 truncate text-neutral-800 dark:text-neutral-200">
              {label(ref)}
            </span>
            {ref.count > 1 && (
              <span
                title={`Shown ${ref.count} times`}
                className="shrink-0 rounded-full bg-neutral-200 px-1.5 text-[11px] text-neutral-600 tabular-nums dark:bg-neutral-800 dark:text-neutral-300"
              >
                ×{ref.count}
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove ${label(ref)}`}
              title={editable ? "Remove image" : "Unlock editing to remove"}
              disabled={!editable}
              onClick={() => setRemoving(ref)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400 dark:text-neutral-500 dark:hover:bg-red-950/50 dark:hover:text-red-400"
            >
              <TrashIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {removing !== null && (
        <RemoveAttachmentDialog
          key={removing.id}
          label={label(removing)}
          attachmentId={removing.id}
          count={removing.count}
          offline={offline}
          onRemoveFromNote={() => onEditText?.(removeAttachmentRefs(textRef.current, removing.id))}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

export function InfoDrawer({
  id,
  fileId,
  text,
  frontmatter,
  drawerRef,
  readOnly = false,
  offline = false,
  onEditText,
  onJump,
  onClose,
}: {
  id: string;
  /** The open note, for its backlinks. */
  fileId?: string;
  text: string;
  readOnly?: boolean;
  offline?: boolean;
  /** Saves `nextText` as the note's whole content (e.g. with an image removed). */
  onEditText?: (nextText: string) => void;
  frontmatter: Frontmatter | null;
  drawerRef: RefObject<HTMLElement | null>;
  onJump: (heading: HeadingItem) => void;
  onClose: () => void;
}) {
  const headings = useMemo(() => extractHeadings(text), [text]);
  const stats = useMemo(() => documentStats(text), [text]);
  const properties = frontmatter?.properties ?? [];

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-neutral-950/40 md:hidden"
      />
      <aside
        id={id}
        ref={drawerRef}
        aria-label="Document info"
        className="fixed inset-y-0 right-0 z-40 flex w-[85vw] max-w-sm flex-col border-l border-neutral-200 bg-neutral-50 text-sm shadow-xl md:static md:z-auto md:w-72 md:max-w-none md:shrink-0 md:shadow-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-2 dark:border-neutral-800">
          <h2 className="truncate text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            Document info
          </h2>
          <button
            type="button"
            aria-label="Close document info"
            title="Close document info"
            onClick={onClose}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3.5 py-3.5">
          <nav aria-label="Outline" className="space-y-1.5">
            <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
              Outline
            </h3>
            {headings.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">No headings yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {headings.map((heading) => (
                  <li key={`${heading.line}-${heading.index}`}>
                    <button
                      type="button"
                      data-level={heading.level}
                      onClick={() => onJump(heading)}
                      className={`block w-full truncate rounded-md py-1 pr-2 text-left text-neutral-700 transition-colors hover:bg-neutral-200/70 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50 ${
                        LEVEL_INDENT[heading.level] ?? "pl-2"
                      } ${heading.level === 1 ? "font-medium" : ""}`}
                    >
                      {heading.text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>

          {fileId !== undefined && <Backlinks fileId={fileId} />}

          <NoteAttachments
            text={text}
            readOnly={readOnly}
            offline={offline}
            onEditText={onEditText}
          />

          <section aria-label="Stats" className="space-y-1.5">
            <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
              Stats
            </h3>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-neutral-800 dark:text-neutral-200">
              <dt className="text-neutral-500 dark:text-neutral-400">Words</dt>
              <dd className="text-right tabular-nums">{stats.words.toLocaleString()}</dd>
              <dt className="text-neutral-500 dark:text-neutral-400">Characters</dt>
              <dd className="text-right tabular-nums">{stats.characters.toLocaleString()}</dd>
              <dt className="text-neutral-500 dark:text-neutral-400">Lines</dt>
              <dd className="text-right tabular-nums">{stats.lines.toLocaleString()}</dd>
              {stats.tasks.total > 0 && (
                <>
                  <dt className="text-neutral-500 dark:text-neutral-400">Tasks</dt>
                  <dd className="text-right tabular-nums">
                    {stats.tasks.done} / {stats.tasks.total}
                  </dd>
                </>
              )}
              <dt className="text-neutral-500 dark:text-neutral-400">Reading time</dt>
              <dd className="text-right tabular-nums">{stats.readingMinutes} min</dd>
            </dl>
          </section>

          {properties.length > 0 && (
            <div role="group" aria-label="Properties" className="space-y-1.5">
              <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
                Properties
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                {properties.map((property) => (
                  <div key={property.key} className="contents">
                    <dt className="text-neutral-500 dark:text-neutral-400">{property.key}</dt>
                    <dd className="break-words text-neutral-800 dark:text-neutral-200">
                      {Array.isArray(property.value) ? property.value.join(", ") : property.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
