import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type AttachmentItem,
  type AttachmentsResponse,
  fetchAttachment,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
  updateAttachmentTags,
} from "../api";
import { attachmentThumbUrl } from "../attachmentRefs";
import { addAttachmentTags, isValidAttachmentTag, removeAttachmentTag } from "../attachmentTags";
import { canCopyImages, copyImage } from "../copyImage";
import { ATTACHMENTS_QUERY_KEY, AttachmentThumb } from "./AttachmentDialogs";
import { CloseIcon, CopyIcon, ImageIcon } from "./icons";

const MODAL_THUMB_PX = 800;
const FEEDBACK_MS = 2_500;

/** Prefix of every per-image tag mutation key (for checking in-flight tag saves). */
export const ATTACHMENT_TAGS_MUTATION_KEY = ["attachment-tags"] as const;

/** Mutation key for one attachment's tag saves. */
export function attachmentTagsMutationKey(id: string) {
  return ["attachment-tags", id] as const;
}

/** Query key for a single attachment's metadata & tags (used by the Document info modal). */
export function attachmentDetailQueryKey(id: string) {
  return ["attachment", id] as const;
}

function tagUpdateErrorMessage(error: unknown): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "This image could not be found on Google Drive.";
  }
  if (error instanceof TypeError) {
    return "You are offline. Try again when you are back online.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to save tags. Try again.";
}

function patchItemTags(item: AttachmentItem, nextTags: string[]): AttachmentItem {
  if (nextTags.length === 0) {
    const { tags: _dropped, ...rest } = item;
    return rest;
  }
  return { ...item, tags: nextTags };
}

function patchListWithTags(
  prev: AttachmentsResponse | undefined,
  id: string,
  next: { tags: string[]; item?: AttachmentItem },
): AttachmentsResponse | undefined {
  if (prev === undefined) {
    return prev;
  }
  let changed = false;
  const attachments = prev.attachments.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    changed = true;
    return next.item !== undefined ? next.item : patchItemTags(entry, next.tags);
  });
  return changed ? { ...prev, attachments } : prev;
}

function readCachedTags(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  fallback: readonly string[],
): string[] {
  const detail = queryClient.getQueryData<AttachmentItem>(attachmentDetailQueryKey(id));
  if (detail !== undefined) {
    return [...(detail.tags ?? [])];
  }
  for (const [, list] of queryClient.getQueriesData<AttachmentsResponse>({
    queryKey: ATTACHMENTS_QUERY_KEY,
  })) {
    const found = list?.attachments.find((entry) => entry.id === id);
    if (found !== undefined) {
      return [...(found.tags ?? [])];
    }
  }
  return [...fallback];
}

function applyTagsToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  next: { tags: string[]; item?: AttachmentItem },
): void {
  queryClient.setQueriesData<AttachmentsResponse>({ queryKey: ATTACHMENTS_QUERY_KEY }, (prev) =>
    patchListWithTags(prev, id, next),
  );
  queryClient.setQueryData<AttachmentItem>(attachmentDetailQueryKey(id), (prev) => {
    if (next.item !== undefined) {
      return next.item;
    }
    return prev === undefined ? prev : patchItemTags(prev, next.tags);
  });
}

/**
 * Persists an attachment's `appProperties` tags to Drive serially per image (`scope`), with
 * synchronous item-level optimistic updates and rollback that never clobber concurrent edits.
 */
export function useUpdateAttachmentTags(attachmentId: string) {
  const queryClient = useQueryClient();
  const mutationKey = attachmentTagsMutationKey(attachmentId);
  return useMutation({
    mutationKey,
    scope: { id: `attachment-tags:${attachmentId}` },
    mutationFn: ({ id, tags }: { id: string; tags: readonly string[]; previousTags: string[] }) =>
      updateAttachmentTags(id, tags),
    onMutate: ({ id }) => {
      void queryClient.cancelQueries({ queryKey: attachmentDetailQueryKey(id) });
    },
    onError: (_error, { id, previousTags }) => {
      // Only roll back if no newer tag save for this image is queued behind us.
      if (queryClient.isMutating({ mutationKey: attachmentTagsMutationKey(id) }) > 1) {
        return;
      }
      applyTagsToCache(queryClient, id, { tags: previousTags });
    },
    onSuccess: (updated) => {
      // Skip writing an older server response over a newer optimistic edit still in flight.
      if (queryClient.isMutating({ mutationKey: attachmentTagsMutationKey(updated.id) }) > 1) {
        return;
      }
      applyTagsToCache(queryClient, updated.id, { tags: updated.tags ?? [], item: updated });
    },
    onSettled: (_data, error, { id }) => {
      if (queryClient.isMutating({ mutationKey: attachmentTagsMutationKey(id) }) > 1) {
        return;
      }
      if (error !== null) {
        void queryClient.invalidateQueries({ queryKey: attachmentDetailQueryKey(id) });
      }
    },
  });
}

/**
 * Shared direct-tag editor for an image attachment (used in the Attachment info sidebar and in the
 * Document info modal). Supports pills, inline `+ tag…` entry, vault suggestions, and optional
 * one-click "From this note" suggestions.
 */
export function AttachmentTagsEditor({
  attachmentId,
  tags,
  suggestions = [],
  noteTags = [],
  disabled = false,
  disabledHint,
  onTagClick,
}: {
  attachmentId: string;
  tags: readonly string[];
  /** Existing vault & attachment tags offered as autocomplete pills. */
  suggestions?: readonly string[];
  /** Frontmatter tags from the currently open note, surfaced for 1-click assignment. */
  noteTags?: readonly string[];
  disabled?: boolean;
  disabledHint?: string;
  /** Optional click handler on an existing tag pill (e.g. filter Attachments by `#tag`). */
  onTagClick?: (tag: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const latestTagsRef = useRef<readonly string[]>(tags);
  const mutation = useUpdateAttachmentTags(attachmentId);

  // Sync the synchronous tag ref from props whenever no save is in flight for this image.
  if (queryClient.isMutating({ mutationKey: attachmentTagsMutationKey(attachmentId) }) === 0) {
    latestTagsRef.current = tags;
  }

  // Clear stale draft and errors when switching to a different attachment.
  useEffect(() => {
    latestTagsRef.current = tags;
    setDraft("");
    setValidationError(null);
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId]);

  const existingLower = useMemo(() => new Set(tags.map((t) => t.toLowerCase())), [tags]);

  const assignableNoteTags = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of noteTags) {
      if (!isValidAttachmentTag(tag)) {
        continue;
      }
      const lower = tag.toLowerCase();
      if (!existingLower.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        out.push(tag);
      }
    }
    return out;
  }, [noteTags, existingLower]);

  const noteTagsLower = useMemo(
    () => new Set(assignableNoteTags.map((t) => t.toLowerCase())),
    [assignableNoteTags],
  );

  const filteredSuggestions = useMemo(() => {
    const needle = draft.replace(/^[#\s]+/, "").toLowerCase();
    return suggestions
      .filter((tag) => {
        const lower = tag.toLowerCase();
        return (
          !existingLower.has(lower) &&
          !noteTagsLower.has(lower) &&
          (needle.length === 0 || lower.includes(needle))
        );
      })
      .slice(0, 6);
  }, [suggestions, existingLower, noteTagsLower, draft]);

  const commitTags = (rawTags: readonly string[], keepDraft = "") => {
    if (disabled) {
      return;
    }
    const base = readCachedTags(queryClient, attachmentId, latestTagsRef.current);
    const result = addAttachmentTags(base, rawTags);
    if (!result.ok) {
      setValidationError(result.message);
      return;
    }
    setValidationError(null);
    setDraft(keepDraft);
    if (result.changed) {
      latestTagsRef.current = result.tags;
      applyTagsToCache(queryClient, attachmentId, { tags: result.tags });
      mutation.mutate({ id: attachmentId, tags: result.tags, previousTags: base });
    }
  };

  const handleRemove = (tag: string, restoreFocus = false) => {
    if (disabled) {
      return;
    }
    setValidationError(null);
    const base = readCachedTags(queryClient, attachmentId, latestTagsRef.current);
    const next = removeAttachmentTag(base, tag);
    latestTagsRef.current = next;
    applyTagsToCache(queryClient, attachmentId, { tags: next });
    mutation.mutate({ id: attachmentId, tags: next, previousTags: base });
    if (restoreFocus) {
      inputRef.current?.focus();
    }
  };

  const errorMessage =
    validationError ?? (mutation.error !== null ? tagUpdateErrorMessage(mutation.error) : null);

  return (
    <div
      className="space-y-2"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
          >
            {onTagClick ? (
              <button
                type="button"
                onClick={() => onTagClick(tag)}
                title={`Filter by #${tag}`}
                className="truncate hover:underline focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                #{tag}
              </button>
            ) : (
              <span className="truncate">#{tag}</span>
            )}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => handleRemove(tag, true)}
                className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-blue-600/80 transition-colors hover:bg-blue-200/80 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-blue-300/80 dark:hover:bg-blue-900 dark:hover:text-blue-100"
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled ? (
          <input
            ref={inputRef}
            type="text"
            aria-label="Add image tag"
            placeholder="+ tag…"
            value={draft}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (pasted.includes(",")) {
                event.preventDefault();
                commitTags(`${draft}${pasted}`.split(","));
              }
            }}
            onChange={(event) => {
              const value = event.target.value;
              if (validationError !== null) {
                setValidationError(null);
              }
              if (value.includes(",")) {
                const parts = value.split(",");
                const trailing = parts.pop() ?? "";
                commitTags(parts, trailing);
              } else {
                setDraft(value);
              }
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return;
              }
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                event.stopPropagation();
                commitTags([draft]);
              } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
                event.preventDefault();
                handleRemove(tags[tags.length - 1]);
              } else if (event.key === "Escape") {
                if (draft.length > 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft("");
                  setValidationError(null);
                }
                inputRef.current?.blur();
              }
            }}
            className="w-24 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-300 focus:bg-white focus:outline-none dark:text-neutral-200 dark:placeholder:text-neutral-500 dark:focus:border-neutral-700 dark:focus:bg-neutral-950"
          />
        ) : tags.length === 0 ? (
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {disabledHint ?? "No tags."}
          </p>
        ) : null}
      </div>

      {!disabled && assignableNoteTags.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
              From this note
            </span>
            {assignableNoteTags.length > 1 && (
              <button
                type="button"
                onClick={() => commitTags(assignableNoteTags)}
                className="text-[11px] font-medium text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
              >
                Add all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {assignableNoteTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => commitTags([tag])}
                className="rounded-full border border-blue-200/80 bg-blue-50/50 px-2 py-0.5 text-[11px] font-medium text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-100/70 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/70"
              >
                + #{tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {!disabled && focused && filteredSuggestions.length > 0 && (
        <div
          role="group"
          aria-label="Image tag suggestions"
          className="flex flex-wrap gap-1 pt-0.5"
        >
          {filteredSuggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => {
                commitTags([tag]);
                inputRef.current?.focus();
              }}
              className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] text-neutral-600 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/60 dark:hover:text-blue-300"
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {disabled && disabledHint && tags.length > 0 && (
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500">{disabledHint}</p>
      )}

      {mutation.isPending && (
        <p role="status" className="text-[11px] text-neutral-400 dark:text-neutral-500">
          Saving…
        </p>
      )}

      {errorMessage !== null && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

function formatBytes(size: number | undefined): string | null {
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

function formatDate(time: string | undefined): string | null {
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
        hour: "2-digit",
        minute: "2-digit",
      });
}

function imageKind(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? mimeType;
  return subtype.toUpperCase();
}

function markdownFor(name: string, url: string): string {
  const alt = name.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
  return `![${alt}](${url})`;
}

/**
 * Modal opened when clicking an image in the Document info drawer: previews the image, shows its
 * Drive metadata, offers copy actions, and lets the user edit its `appProperties` tags (with
 * 1-click suggestions from the open note's frontmatter tags).
 */
export function AttachmentInfoDialog({
  attachmentId,
  fallbackLabel,
  cachedItem,
  noteTags = [],
  suggestions = [],
  readOnly,
  offline,
  onClose,
}: {
  attachmentId: string;
  fallbackLabel: string;
  /** Already-known item from the `Attachments` list cache, if any. */
  cachedItem?: AttachmentItem;
  /** Frontmatter tags of the open note for 1-click assignment. */
  noteTags?: readonly string[];
  /** Existing tags across the vault for autocomplete. */
  suggestions?: readonly string[];
  readOnly: boolean;
  offline: boolean;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const query = useQuery({
    queryKey: attachmentDetailQueryKey(attachmentId),
    queryFn: ({ signal }) => fetchAttachment(attachmentId, signal),
    initialData: cachedItem,
    enabled: !offline,
  });

  useEffect(() => {
    if (feedback === null) return;
    const timer = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const item = query.data ?? cachedItem;
  const title = item?.name ?? fallbackLabel;
  const blobUrl = item?.url ?? `/api/files/${encodeURIComponent(attachmentId)}/blob`;
  const imageCopyable = canCopyImages();
  const tagsDisabled = readOnly || offline || (item === undefined && query.isLoading);
  const disabledHint = readOnly
    ? "Unlock editing to edit tags."
    : offline
      ? "Reconnect to edit tags."
      : undefined;

  const details: [string, string | null][] = item
    ? [
        ["Type", imageKind(item.mimeType)],
        ["Size", formatBytes(item.size)],
        ["Uploaded", formatDate(item.createdTime)],
        ["Modified", formatDate(item.modifiedTime)],
      ]
    : [];

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
      <DialogContent className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(85vh,42rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-5 py-3.5 dark:border-neutral-800">
          <DialogTitle className="min-w-0 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </DialogTitle>
          <DialogClose
            type="button"
            aria-label="Close attachment details"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <CloseIcon className="size-4" />
          </DialogClose>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the full image in a new tab"
            className="block overflow-hidden rounded-lg border border-neutral-200 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700"
          >
            <AttachmentThumb
              src={attachmentThumbUrl(attachmentId, MODAL_THUMB_PX)}
              alt={title}
              fit="contain"
              className="aspect-video w-full"
            />
          </a>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(markdownFor(title, blobUrl)).then(
                  () => setFeedback("Copied Markdown."),
                  () => setFeedback("Unable to copy Markdown."),
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <CopyIcon className="size-3.5" />
              <span>Copy Markdown</span>
            </button>
            <button
              type="button"
              disabled={!imageCopyable}
              title={imageCopyable ? undefined : "This browser cannot copy images"}
              onClick={() => {
                setFeedback("Copying image…");
                copyImage(blobUrl).then(
                  () => setFeedback("Copied image."),
                  () => setFeedback("Unable to copy the image."),
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              <ImageIcon className="size-3.5" />
              <span>Copy image</span>
            </button>
            {feedback !== null && (
              <span role="status" className="text-xs text-neutral-500 dark:text-neutral-400">
                {feedback}
              </span>
            )}
          </div>

          <section aria-label="Tags" className="space-y-1.5">
            <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
              Tags
            </h3>
            {item === undefined && query.isLoading ? (
              <p className="text-xs text-neutral-400 dark:text-neutral-500">Loading tags…</p>
            ) : item === undefined && query.isError ? (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                Unable to load image metadata.
              </p>
            ) : (
              <AttachmentTagsEditor
                attachmentId={attachmentId}
                tags={item?.tags ?? []}
                noteTags={noteTags}
                suggestions={suggestions}
                disabled={tagsDisabled}
                disabledHint={disabledHint}
              />
            )}
          </section>

          {details.length > 0 && (
            <section aria-label="Details" className="space-y-1.5">
              <h3 className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase dark:text-neutral-500">
                Details
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-neutral-800 dark:text-neutral-200">
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
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
