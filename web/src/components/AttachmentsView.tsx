import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type AttachmentItem, describeError, fetchAttachments } from "../api";
import { attachmentUsage } from "../attachmentRefs";
import { usePkm } from "../pkm";
import { useSettings } from "../settings";
import { useVaultDocuments } from "../useVaultDocuments";
import type { VaultDocument } from "../vaultDocuments";
import { useViewPrefs } from "../viewPrefs";
import { noteStem } from "../wikilinks";
import { attachmentsQueryKey, AttachmentThumb, DeleteAttachmentDialog } from "./AttachmentDialogs";
import { CheckIcon, CopyIcon, TrashIcon } from "./icons";

const FEEDBACK_MS = 3_000;
const COPIED_MS = 1_500;

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

function formatModified(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Markdown that embeds `attachment`, alt text escaped like editor uploads. */
export function attachmentMarkdown(attachment: Pick<AttachmentItem, "name" | "url">): string {
  const alt = attachment.name.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
  return `![${alt}](${attachment.url})`;
}

function CopyMarkdownButton({ attachment }: { attachment: AttachmentItem }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : `Copy Markdown for ${attachment.name}`}
      title="Copy Markdown"
      onClick={() => {
        void navigator.clipboard?.writeText(attachmentMarkdown(attachment)).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      <span>{copied ? "Copied" : "Copy Markdown"}</span>
    </button>
  );
}

function AttachmentCard({
  attachment,
  usedIn,
  canDelete,
  deleteHint,
  onOpenNote,
  onDelete,
}: {
  attachment: AttachmentItem;
  /** `null` while cached notes are still being read. */
  usedIn: readonly VaultDocument[] | null;
  canDelete: boolean;
  deleteHint: string;
  onOpenNote: (id: string) => void;
  onDelete: () => void;
}) {
  const size = formatBytes(attachment.size);
  const modified = formatModified(attachment.modifiedTime);
  return (
    <li
      aria-label={attachment.name}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <AttachmentThumb
        src={attachment.url}
        alt={attachment.name}
        className="aspect-video w-full border-b border-neutral-200 dark:border-neutral-800"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <p
          className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100"
          title={attachment.name}
        >
          {attachment.name}
        </p>
        <p className="text-xs text-neutral-500 tabular-nums dark:text-neutral-400">
          {[size, modified].filter(Boolean).join(" · ")}
        </p>
        {usedIn === null ? (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">Checking notes…</span>
        ) : usedIn.length === 0 ? (
          <span className="w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
            Unused
          </span>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Used in {usedIn.length} {usedIn.length === 1 ? "note" : "notes"}
            </p>
            <div className="flex flex-wrap gap-1">
              {usedIn.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  title={[...doc.path, doc.name].join(" / ")}
                  onClick={() => onOpenNote(doc.id)}
                  className="max-w-full truncate rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-700 transition-colors hover:border-neutral-400 hover:text-neutral-950 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500 dark:hover:text-neutral-50"
                >
                  {noteStem(doc.name)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center justify-between gap-1 pt-1">
          <CopyMarkdownButton attachment={attachment} />
          <button
            type="button"
            aria-label={`Delete ${attachment.name}`}
            title={canDelete ? "Move to Drive Trash" : deleteHint}
            disabled={!canDelete}
            onClick={onDelete}
            className="inline-flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500 dark:text-neutral-400 dark:hover:bg-red-950/50 dark:hover:text-red-400"
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      </div>
    </li>
  );
}

/** The vault's uploaded images: where each is used, copy-as-Markdown, and trash. */
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
  const query = useQuery({
    queryKey: attachmentsQueryKey(attachmentsFolder),
    queryFn: ({ signal }) => fetchAttachments(signal, attachmentsFolder),
  });
  const [search, setSearch] = useState("");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [deleting, setDeleting] = useState<AttachmentItem | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

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
  const unusedCount = attachments.filter((item) => !usage.has(item.id)).length;
  const needle = search.trim().toLowerCase();
  const visible = attachments.filter(
    (item) =>
      (!unusedOnly || !usage.has(item.id)) &&
      (needle.length === 0 || item.name.toLowerCase().includes(needle)),
  );
  const canDelete = !readOnly && !offline;
  const deleteHint = readOnly ? "Unlock editing to delete" : "Reconnect to delete";
  const usedNames = (id: string) => (usage.get(id) ?? []).map((doc) => noteStem(doc.name));

  const controlClass =
    "rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200";

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
        No attachments yet. Paste or drop an image into a note to add one.
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
            usedIn={docs === null ? null : (usage.get(attachment.id) ?? [])}
            canDelete={canDelete}
            deleteHint={deleteHint}
            onOpenNote={onOpenNote}
            onDelete={() => setDeleting(attachment)}
          />
        ))}
      </ul>
    );
  }

  return (
    <section aria-label="Attachments" className="flex min-h-0 flex-1 flex-col">
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
          className={`${controlClass} min-w-0 flex-1`}
        />
        <button
          type="button"
          aria-pressed={unusedOnly}
          onClick={() => setUnusedOnly((prev) => !prev)}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            unusedOnly
              ? "border-blue-600 bg-blue-600 text-white"
              : "border-neutral-200 text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
          }`}
        >
          Unused only <span className="tabular-nums">({unusedCount})</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {body}
        {!vaultPinned && query.data !== undefined && attachments.length > 0 && (
          <p className="mt-6 text-xs text-neutral-400 dark:text-neutral-500">
            Usage counts only notes cached on this device. Pin vault offline to check every note.
          </p>
        )}
      </div>

      {deleting !== null && (
        <DeleteAttachmentDialog
          key={deleting.id}
          attachment={deleting}
          usedIn={usedNames(deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={() => setFeedback(`Moved “${deleting.name}” to Drive Trash.`)}
        />
      )}
    </section>
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
