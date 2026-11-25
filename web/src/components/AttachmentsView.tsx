import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { type AttachmentItem, describeError, fetchAttachments, type UploadedRange } from "../api";
import { attachmentThumbUrl, attachmentUsage } from "../attachmentRefs";
import { canCopyImages, copyImage } from "../copyImage";
import { usePkm } from "../pkm";
import { useSettings } from "../settings";
import { useVaultDocuments } from "../useVaultDocuments";
import type { VaultDocument } from "../vaultDocuments";
import { useViewPrefs } from "../viewPrefs";
import { noteStem } from "../wikilinks";
import { attachmentsQueryKey, AttachmentThumb, DeleteAttachmentDialog } from "./AttachmentDialogs";
import { CloseIcon, CopyIcon, ImageIcon, TrashIcon } from "./icons";
import { type DayRange, UploadDateFilter } from "./UploadDateFilter";

const FEEDBACK_MS = 3_000;
/** Thumbnail sizes (longest edge, px): grid cards and the info sidebar, both at 2x density. */
const CARD_THUMB_PX = 640;
const INFO_THUMB_PX = 800;

/** `1.2 MB`-style size, or `null` when Drive reported none. */
export function formatBytes(size: number | undefined): string | null {
  if (size === undefined || !Number.isFinite(size) || size < 0) {
    return null;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDate(time: string | undefined, withTime = false): string | null {
  if (time === undefined) {
    return null;
  }
  const date = new Date(time);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      });
}

/** Whether the info sidebar would open as an overlay sheet (below Tailwind's `md`). */
function narrowScreen(): boolean {
  return (
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 47.99rem)").matches
  );
}

/** `image/png` → `PNG`. */
function imageKind(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? mimeType;
  return subtype.toUpperCase();
}

/**
 * The `[from, before)` upload window of two `<input type="date">` values (`YYYY-MM-DD`, or empty
 * for an open side), as ISO instants of local midnights: `to` counts as a whole day.
 */
export function uploadedRangeOf(fromDay: string, toDay: string): UploadedRange {
  const midnight = (day: string, plusDays: number): string | undefined => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (match === null) return undefined;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + plusDays);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  const from = midnight(fromDay, 0);
  const before = midnight(toDay, 1);
  return {
    ...(from === undefined ? {} : { from }),
    ...(before === undefined ? {} : { before }),
  };
}

/** Markdown that embeds `attachment`, alt text escaped like editor uploads. */
export function attachmentMarkdown(attachment: Pick<AttachmentItem, "name" | "url">): string {
  const alt = attachment.name.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
  return `![${alt}](${attachment.url})`;
}

const OVERLAY_ACTION_CLASS =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-neutral-200/80 bg-white/90 text-neutral-600 shadow-sm backdrop-blur-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700/80 dark:bg-neutral-900/85 dark:text-neutral-300";

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-200 dark:hover:bg-neutral-800";

/** The copy menu of a card: the image Markdown, or the original image itself. */
function CopyMenu({
  attachment,
  onFeedback,
}: {
  attachment: AttachmentItem;
  onFeedback: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const imageCopyable = canCopyImages();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label={`Copy ${attachment.name}`}
        title="Copy"
        className={`${OVERLAY_ACTION_CLASS} hover:bg-white hover:text-neutral-900 data-[open]:bg-white data-[open]:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:data-[open]:bg-neutral-800`}
      >
        <CopyIcon className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="z-50 w-40 rounded-xl border border-neutral-200 bg-white p-1 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            void navigator.clipboard?.writeText(attachmentMarkdown(attachment)).then(
              () => onFeedback("Copied Markdown."),
              () => onFeedback("Unable to copy Markdown."),
            );
          }}
          className={MENU_ITEM_CLASS}
        >
          <CopyIcon className="size-3.5 text-neutral-500 dark:text-neutral-400" />
          <span>Copy Markdown</span>
        </button>
        <button
          type="button"
          disabled={!imageCopyable}
          title={imageCopyable ? undefined : "This browser cannot copy images"}
          onClick={() => {
            setOpen(false);
            onFeedback("Copying image…");
            copyImage(attachment.url).then(
              () => onFeedback("Copied image."),
              () => onFeedback("Unable to copy the image."),
            );
          }}
          className={MENU_ITEM_CLASS}
        >
          <ImageIcon className="size-3.5 text-neutral-500 dark:text-neutral-400" />
          <span>Copy image</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

function AttachmentCard({
  attachment,
  selected,
  detailsId,
  canDelete,
  deleteHint,
  onSelect,
  onDelete,
  onFeedback,
}: {
  attachment: AttachmentItem;
  selected: boolean;
  detailsId: string;
  canDelete: boolean;
  deleteHint: string;
  onSelect: () => void;
  onDelete: () => void;
  onFeedback: (message: string) => void;
}) {
  return (
    <li
      aria-label={attachment.name}
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white dark:bg-neutral-900 ${
        selected
          ? "border-blue-500 ring-1 ring-blue-500 dark:border-blue-400 dark:ring-blue-400"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <div className="relative border-b border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          aria-label={`Details for ${attachment.name}`}
          aria-expanded={selected}
          aria-controls={selected ? detailsId : undefined}
          onClick={onSelect}
          className="block w-full cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600"
        >
          <AttachmentThumb
            src={attachmentThumbUrl(attachment.id, CARD_THUMB_PX)}
            alt=""
            className="aspect-video w-full"
          />
        </button>
        <div className="absolute right-1.5 bottom-1.5 flex gap-1">
          <CopyMenu attachment={attachment} onFeedback={onFeedback} />
          <button
            type="button"
            aria-label={`Delete ${attachment.name}`}
            title={canDelete ? "Move to Drive Trash" : deleteHint}
            disabled={!canDelete}
            onClick={onDelete}
            className={`${OVERLAY_ACTION_CLASS} hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white/90 disabled:hover:text-neutral-600 dark:hover:bg-red-950 dark:hover:text-red-400 dark:disabled:hover:bg-neutral-900/85 dark:disabled:hover:text-neutral-300`}
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      </div>
      <p
        className="min-w-0 truncate px-3 py-2 text-sm font-medium text-neutral-900 dark:text-neutral-100"
        title={attachment.name}
      >
        {attachment.name}
      </p>
    </li>
  );
}

const SECTION_TITLE_CLASS =
  "text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500";

/**
 * Right sidebar with one attachment's details and the notes that show it, laid out like the
 * Document info drawer: docked on desktop, an overlay sheet with a backdrop on narrow screens.
 */
function AttachmentDetails({
  id,
  attachment,
  usedIn,
  vaultPinned,
  onOpenNote,
  onClose,
}: {
  id: string;
  attachment: AttachmentItem;
  /** `null` while cached notes are still being read. */
  usedIn: readonly VaultDocument[] | null;
  vaultPinned: boolean;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const details: [string, string | null][] = [
    ["Type", imageKind(attachment.mimeType)],
    ["Size", formatBytes(attachment.size)],
    ["Uploaded", formatDate(attachment.createdTime, true)],
    ["Modified", formatDate(attachment.modifiedTime, true)],
  ];
  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-neutral-950/40 md:hidden"
      />
      <aside
        id={id}
        aria-label="Attachment info"
        className="fixed inset-y-0 right-0 z-40 flex w-[85vw] max-w-sm flex-col border-l border-neutral-200 bg-neutral-50 text-sm shadow-xl md:static md:z-auto md:w-72 md:max-w-none md:shrink-0 md:shadow-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3.5 py-2 dark:border-neutral-800">
          <p className="truncate text-sm font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            Attachment info
          </p>
          <button
            type="button"
            aria-label="Close attachment info"
            title="Close attachment info"
            onClick={onClose}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3.5 py-3.5">
          <div className="space-y-2">
            <a
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the full image in a new tab"
              className="block overflow-hidden rounded-lg border border-neutral-200 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700"
            >
              <AttachmentThumb
                src={attachmentThumbUrl(attachment.id, INFO_THUMB_PX)}
                alt={attachment.name}
                fit="contain"
                className="aspect-video w-full"
              />
            </a>
            <h2 className="break-all font-medium text-neutral-900 dark:text-neutral-100">
              {attachment.name}
            </h2>
          </div>

          <section aria-label="Details" className="space-y-1.5">
            <h3 className={SECTION_TITLE_CLASS}>Details</h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-neutral-800 dark:text-neutral-200">
              {details
                .filter((entry): entry is [string, string] => entry[1] !== null)
                .map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
                    <dd className="text-right tabular-nums">{value}</dd>
                  </div>
                ))}
            </dl>
          </section>

          <section aria-label="Used in" className="space-y-1.5">
            <h3 className={SECTION_TITLE_CLASS}>
              Used in
              {usedIn !== null && usedIn.length > 0 && (
                <span className="ml-1 tabular-nums">· {usedIn.length}</span>
              )}
            </h3>
            {usedIn === null ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">Checking notes…</p>
            ) : usedIn.length === 0 ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                Not used in any note cached on this device.
              </p>
            ) : (
              <ul className="space-y-1">
                {usedIn.map((doc) => (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => onOpenNote(doc.id)}
                      className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
                    >
                      <span className="block truncate font-medium text-neutral-800 dark:text-neutral-200">
                        {noteStem(doc.name)}
                      </span>
                      {doc.path.length > 0 && (
                        <span className="block truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                          {doc.path.join(" / ")}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!vaultPinned && (
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                Usage counts only notes cached on this device. Pin vault offline to check every
                note.
              </p>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

/** The vault's uploaded images: copy-as-Markdown, trash, and an info sidebar with their usage. */
export function AttachmentsPanel({
  docs,
  vaultPinned,
  offline,
  readOnly,
  onOpenNote,
  header,
}: {
  /** Cached notes to scan for references; `null` while they load. */
  docs: readonly VaultDocument[] | null;
  vaultPinned: boolean;
  offline: boolean;
  readOnly: boolean;
  onOpenNote: (id: string) => void;
  header?: ReactNode;
}) {
  const { attachmentsFolder } = useSettings();
  const [days, setDays] = useState<DayRange>(null);
  const range = useMemo(() => uploadedRangeOf(days?.[0] ?? "", days?.[1] ?? ""), [days]);
  const filtered = range.from !== undefined || range.before !== undefined;
  const query = useQuery({
    // The unfiltered list keeps the shared key the Document info drawer reads names from.
    queryKey: filtered
      ? [
          ...attachmentsQueryKey(attachmentsFolder),
          "uploaded",
          range.from ?? "",
          range.before ?? "",
        ]
      : attachmentsQueryKey(attachmentsFolder),
    queryFn: ({ signal }) => fetchAttachments(signal, attachmentsFolder, range),
    placeholderData: (previous) => previous,
  });
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Open from the start where it docks beside the grid; on narrow screens it would cover it.
  const [infoOpen, setInfoOpen] = useState(() => !narrowScreen());
  const [deleting, setDeleting] = useState<AttachmentItem | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const detailsId = useId();

  useEffect(() => {
    if (feedback === null) return;
    const timer = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const usage = useMemo(() => attachmentUsage(docs ?? []), [docs]);
  const attachments = useMemo(
    () =>
      [...(query.data?.attachments ?? [])].sort((a, b) =>
        b.modifiedTime.localeCompare(a.modifiedTime),
      ),
    [query.data],
  );
  const needle = search.trim().toLowerCase();
  const visible = attachments.filter(
    (item) => needle.length === 0 || item.name.toLowerCase().includes(needle),
  );
  // Nothing picked yet, or the pick left the list (trashed, outside the dates, filtered out by
  // name): the sidebar shows the first card instead.
  const selected = infoOpen
    ? (visible.find((item) => item.id === selectedId) ?? visible[0] ?? null)
    : null;
  const canDelete = !readOnly && !offline;
  const deleteHint = readOnly ? "Unlock editing to delete" : "Reconnect to delete";
  const usedNames = (id: string) => (usage.get(id) ?? []).map((doc) => noteStem(doc.name));

  const controlClass =
    "rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:[color-scheme:dark]";

  let body: ReactNode;
  if (query.data === undefined) {
    if (query.isError) {
      body = (
        <div role="alert" className="text-sm text-neutral-600 dark:text-neutral-300">
          <p>Unable to load attachments.</p>
          <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
            {describeError(query.error)}
          </p>
        </div>
      );
    } else if (offline) {
      body = (
        <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">
          You are offline. Attachments load when you are back online.
        </p>
      );
    } else {
      body = (
        <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">
          Loading attachments…
        </p>
      );
    }
  } else if (attachments.length === 0) {
    body = (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {filtered
          ? "No attachments were uploaded in these dates."
          : "No attachments yet. Paste or drop an image into a note to add one."}
      </p>
    );
  } else if (visible.length === 0) {
    body = <p className="text-sm text-neutral-500 dark:text-neutral-400">No attachments match.</p>;
  } else {
    body = (
      <ul
        aria-label="Attachment list"
        className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3"
      >
        {visible.map((attachment) => (
          <AttachmentCard
            key={attachment.id}
            attachment={attachment}
            selected={attachment.id === selected?.id}
            detailsId={detailsId}
            canDelete={canDelete}
            deleteHint={deleteHint}
            onSelect={() => {
              setSelectedId(attachment.id);
              setInfoOpen(true);
            }}
            onDelete={() => setDeleting(attachment)}
            onFeedback={setFeedback}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <section aria-label="Attachments" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 sm:px-6 dark:border-neutral-800">
          {header}
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Attachments
            {query.data !== undefined && (
              <span className="ml-1.5 font-normal text-neutral-400 tabular-nums dark:text-neutral-500">
                {attachments.length}
              </span>
            )}
          </h2>
          {feedback !== null && (
            <span role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
              {feedback}
            </span>
          )}
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={offline || query.isFetching}
            className="ml-auto rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 sm:px-6 dark:border-neutral-800">
          <input
            type="search"
            aria-label="Search attachments"
            placeholder="Search by filename…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`${controlClass} min-w-0 flex-1 basis-40`}
          />
          <UploadDateFilter value={days} onChange={setDays} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">{body}</div>
      </section>

      {selected !== null && (
        <AttachmentDetails
          id={detailsId}
          attachment={selected}
          usedIn={docs === null ? null : (usage.get(selected.id) ?? [])}
          vaultPinned={vaultPinned}
          onOpenNote={onOpenNote}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {deleting !== null && (
        <DeleteAttachmentDialog
          key={deleting.id}
          attachment={deleting}
          usedIn={usedNames(deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={() => setFeedback(`Moved “${deleting.name}” to Drive Trash.`)}
        />
      )}
    </div>
  );
}

/** The Attachments workspace over the vault's uploads and every locally cached note. */
export function AttachmentsView({ header, offline }: { header?: ReactNode; offline: boolean }) {
  const pkm = usePkm();
  const docs = useVaultDocuments();
  const prefs = useViewPrefs();
  return (
    <AttachmentsPanel
      docs={docs}
      vaultPinned={pkm?.vaultPinned ?? false}
      offline={offline}
      readOnly={prefs.readOnly}
      header={header}
      onOpenNote={(id) => pkm?.openNote(id)}
    />
  );
}
