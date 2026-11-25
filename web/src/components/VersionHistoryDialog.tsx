import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { type KeyboardEvent, lazy, Suspense, useState } from "react";
import {
  describeError,
  fetchRevisionContent,
  fetchRevisions,
  isNotFound,
  isTooLarge,
  isUnauthenticated,
  NotUtf8Error,
  type Revision,
} from "../api";
import { isLocalId } from "../localIds";

function DiffLoadFailed() {
  return (
    <p className="text-sm text-red-600 dark:text-red-400" role="alert">
      Unable to load the diff view. Use Raw text, or reload the page and try again.
    </p>
  );
}

const RevisionDiff = lazy(() =>
  import("./RevisionDiff")
    .then((m) => ({ default: m.RevisionDiff }))
    .catch(() => ({ default: DiffLoadFailed })),
);

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, length] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= length) {
      return format.format(Math.round(seconds / length), unit);
    }
  }
  return "just now";
}

export function formatRevisionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function loadErrorMessage(error: unknown, what: "list" | "version"): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (what === "version" && error instanceof NotUtf8Error) {
    return "This version is not valid UTF-8 text and cannot be shown.";
  }
  if (what === "version" && isTooLarge(error)) {
    return "This version is larger than 10 MB and cannot be shown.";
  }
  if (isNotFound(error)) {
    return what === "list"
      ? "Drive has no version history for this note."
      : "Drive no longer has this version.";
  }
  return what === "list" ? "Unable to load the version history." : "Unable to load this version.";
}

const BUTTON_CLASS =
  "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800";

const TOGGLE_CLASS =
  "rounded-md px-2 py-0.5 text-xs font-medium text-neutral-600 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-blue-600 data-checked:bg-white data-checked:text-neutral-900 data-checked:shadow-xs dark:text-neutral-400 dark:hover:text-neutral-100 dark:data-checked:bg-neutral-700 dark:data-checked:text-neutral-50";

/**
 * Drive's stored versions of a note: pick one to compare with the current text, then restore
 * it. Restoring hands the text back through `onRestore`, which saves it like any other edit.
 */
export function VersionHistoryDialog({
  fileId,
  fileName,
  currentText,
  readOnly,
  offline,
  onRestore,
  onClose,
}: {
  fileId: string;
  fileName: string;
  currentText: string;
  readOnly: boolean;
  offline: boolean;
  onRestore: (text: string, revision: Revision) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-40 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(60rem,calc(100vw-1rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-xl border border-neutral-200 bg-white p-4 text-neutral-900 shadow-xl outline-none sm:p-6 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="space-y-1">
          <DialogTitle className="text-base font-semibold">Version history</DialogTitle>
          <DialogDescription className="truncate text-sm text-neutral-500 dark:text-neutral-400">
            Versions of {fileName} stored by Google Drive.
          </DialogDescription>
        </div>
        {isLocalId(fileId) ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            Version history is available after this note syncs to Drive.
          </p>
        ) : offline ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            Version history needs a connection. Reconnect to browse and restore earlier versions.
          </p>
        ) : (
          <HistoryBody
            fileId={fileId}
            currentText={currentText}
            readOnly={readOnly}
            onRestore={onRestore}
          />
        )}
        {(offline || isLocalId(fileId)) && (
          <div className="flex justify-end">
            <DialogClose type="button" className={BUTTON_CLASS}>
              Close
            </DialogClose>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryBody({
  fileId,
  currentText,
  readOnly,
  onRestore,
}: {
  fileId: string;
  currentText: string;
  readOnly: boolean;
  onRestore: (text: string, revision: Revision) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"diff" | "raw">("diff");
  const list = useQuery({
    queryKey: ["revisions", fileId],
    queryFn: ({ signal }) => fetchRevisions(fileId, signal),
    staleTime: 30_000,
    retry: false,
  });
  const revisions = list.data ?? [];
  const selected = revisions.find((r) => r.id === selectedId) ?? revisions[0];
  const content = useQuery({
    queryKey: ["revisions", fileId, selected?.id, "content"],
    queryFn: ({ signal }) => fetchRevisionContent(fileId, selected?.id ?? "", signal),
    enabled: selected !== undefined,
    // A stored revision never changes.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (list.isPending) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
        Loading versions…
      </p>
    );
  }
  if (list.isError) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-red-600 dark:text-red-400">{loadErrorMessage(list.error, "list")}</p>
        <p className="text-xs text-red-600/90 dark:text-red-300/80">
          Reason: {describeError(list.error)}
        </p>
        <button type="button" className={BUTTON_CLASS} onClick={() => void list.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (selected === undefined) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Drive has no stored versions of this note yet.
        </p>
        <div className="flex justify-end">
          <DialogClose type="button" className={BUTTON_CLASS}>
            Close
          </DialogClose>
        </div>
      </div>
    );
  }

  const move = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const next =
      event.key === "ArrowDown"
        ? Math.min(revisions.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? revisions.length - 1
              : null;
    if (next === null) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelectedId(revisions[index].id);
      }
      return;
    }
    event.preventDefault();
    setSelectedId(revisions[next].id);
    const sibling = event.currentTarget.parentElement?.children[next];
    if (sibling instanceof HTMLElement) {
      sibling.focus();
    }
  };

  const text = content.data;
  const identical = text !== undefined && text === currentText;
  const canRestore = text !== undefined && !identical && !readOnly;
  const when = formatRevisionDate(selected.modifiedTime);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        <ul
          role="listbox"
          aria-label="Revisions"
          className="max-h-48 space-y-1 overflow-y-auto md:max-h-[60vh]"
        >
          {revisions.map((revision, index) => (
            <li
              key={revision.id}
              role="option"
              aria-selected={revision === selected}
              tabIndex={revision === selected ? 0 : -1}
              onClick={() => setSelectedId(revision.id)}
              onKeyDown={(event) => move(event, index)}
              className="cursor-pointer rounded-lg border border-transparent px-2.5 py-2 text-sm hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-blue-600 aria-selected:border-neutral-200 aria-selected:bg-neutral-100 dark:hover:bg-neutral-800/60 dark:aria-selected:border-neutral-700 dark:aria-selected:bg-neutral-800"
            >
              <div className="flex items-center justify-between gap-2">
                <time dateTime={revision.modifiedTime} className="font-medium">
                  {formatRevisionDate(revision.modifiedTime)}
                </time>
                {index === 0 && (
                  <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[0.6875rem] font-medium text-blue-800 dark:bg-blue-950/70 dark:text-blue-300">
                    Current
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span>{formatRelativeTime(revision.modifiedTime)}</span>
                {revision.author !== undefined && <span>{revision.author}</span>}
                {revision.size !== undefined && <span>{formatBytes(revision.size)}</span>}
                {revision.keepForever && <span>Kept forever</span>}
              </div>
            </li>
          ))}
        </ul>

        <section aria-label="Selected version" className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {view === "diff"
                ? "Red lines are in the current note, green lines are in this version."
                : `Text of the version from ${when}.`}
            </p>
            <SegmentedControl
              aria-label="View"
              value={view}
              onValueChange={(next) => {
                if (next !== null) {
                  setView(next);
                }
              }}
              className="inline-flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800"
            >
              <SegmentedControlItem value="diff" className={TOGGLE_CLASS}>
                Diff vs current
              </SegmentedControlItem>
              <SegmentedControlItem value="raw" className={TOGGLE_CLASS}>
                Raw text
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {content.isPending ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
                Loading this version…
              </p>
            ) : content.isError ? (
              <div role="alert" className="space-y-2 text-sm">
                <p className="text-red-600 dark:text-red-400">
                  {loadErrorMessage(content.error, "version")}
                </p>
                {!(content.error instanceof NotUtf8Error) && (
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => void content.refetch()}
                  >
                    Retry
                  </button>
                )}
              </div>
            ) : identical ? (
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                This version matches the current note.
              </p>
            ) : view === "raw" ? (
              <pre
                data-testid="revision-raw"
                className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-neutral-800 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
              >
                {text}
              </pre>
            ) : (
              <Suspense
                fallback={
                  <p className="text-sm text-neutral-500 dark:text-neutral-400" role="status">
                    Loading diff…
                  </p>
                }
              >
                <RevisionDiff current={currentText} revision={text ?? ""} />
              </Suspense>
            )}
          </div>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {readOnly && (
          <p className="mr-auto text-xs text-amber-700 dark:text-amber-300">
            This note is read-only. Unlock the note to restore a version.
          </p>
        )}
        <DialogClose type="button" className={BUTTON_CLASS}>
          Close
        </DialogClose>
        <button
          type="button"
          disabled={!canRestore}
          title={identical ? "This version matches the current note" : undefined}
          onClick={() => {
            if (canRestore) {
              onRestore(text, selected);
            }
          }}
          className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          Restore this version
        </button>
      </div>
    </div>
  );
}
