import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { type ReactNode, useState } from "react";
import {
  type AttachmentsResponse,
  ApiError,
  deleteFile,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
} from "../api";
import { ImageIcon } from "./icons";

/** Every cached attachments list, whatever its folder (for invalidation). */
export const ATTACHMENTS_QUERY_KEY = ["attachments"] as const;

/** The cached attachments list of one attachments folder. */
export function attachmentsQueryKey(folder: string) {
  return ["attachments", folder] as const;
}

function deleteErrorMessage(error: unknown): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "This image was already deleted.";
  }
  if (error instanceof TypeError) {
    return "You are offline. Try again when you are back online.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to delete the image. Try again.";
}

/**
 * Moves an attachment to Drive Trash, then drops it from the cached `["attachments", …]` lists and
 * refetches them.
 */
export function useDeleteAttachment(onDeleted?: (id: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFile(id),
    onSuccess: (_data, id) => {
      queryClient.setQueriesData<AttachmentsResponse>({ queryKey: ATTACHMENTS_QUERY_KEY }, (prev) =>
        prev === undefined
          ? prev
          : { ...prev, attachments: prev.attachments.filter((item) => item.id !== id) },
      );
      void queryClient.invalidateQueries({ queryKey: ATTACHMENTS_QUERY_KEY });
      onDeleted?.(id);
    },
  });
}

/** An attachment thumbnail that turns into an image glyph when the blob cannot load. */
export function AttachmentThumb({
  src,
  alt,
  className,
  fit = "cover",
}: {
  src: string;
  alt: string;
  className: string;
  /** `contain` shows the whole image (letterboxed) instead of cropping it to the box. */
  fit?: "cover" | "contain";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    return (
      <span
        role="img"
        aria-label={alt}
        className={`${className} flex items-center justify-center bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500`}
      >
        <ImageIcon className="size-5" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className={`${className} bg-neutral-100 dark:bg-neutral-800 ${
        fit === "contain" ? "object-contain" : "object-cover"
      }`}
    />
  );
}

const CANCEL_CLASS =
  "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800";
const DANGER_CLASS =
  "rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 dark:bg-red-600 dark:hover:bg-red-500";
const SECONDARY_CLASS =
  "rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800";

function ConfirmShell({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-40 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="space-y-4">
          <DialogTitle className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </DialogTitle>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NoteList({ names }: { names: readonly string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-neutral-800 dark:text-neutral-200">
      {names.map((name) => (
        <li key={name} className="break-words">
          {name}
        </li>
      ))}
    </ul>
  );
}

/** Confirms moving an attachment to Drive Trash, warning about the notes that still show it. */
export function DeleteAttachmentDialog({
  attachment,
  usedIn,
  onClose,
  onDeleted,
}: {
  attachment: { id: string; name: string };
  /** Names of cached notes that still reference the image. */
  usedIn: readonly string[];
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const mutation = useDeleteAttachment((id) => {
    onDeleted(id);
    onClose();
  });
  return (
    <ConfirmShell title="Delete image" busy={mutation.isPending} onClose={onClose}>
      <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
        Move{" "}
        <span className="font-medium break-all text-neutral-800 dark:text-neutral-200">
          {attachment.name}
        </span>{" "}
        to Google Drive Trash? You can restore it from Drive later.
      </DialogDescription>
      {usedIn.length > 0 && (
        <div
          role="note"
          aria-label="Still referenced"
          className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p>
            {usedIn.length === 1 ? "1 note still shows" : `${usedIn.length} notes still show`} this
            image; it will appear broken there:
          </p>
          <NoteList names={usedIn} />
        </div>
      )}
      {mutation.error !== null && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {deleteErrorMessage(mutation.error)}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <DialogClose type="button" disabled={mutation.isPending} className={CANCEL_CLASS}>
          Cancel
        </DialogClose>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(attachment.id)}
          className={DANGER_CLASS}
        >
          {mutation.isPending ? "Deleting…" : "Move to Trash"}
        </button>
      </div>
    </ConfirmShell>
  );
}

/**
 * The open note's choice for one embedded attachment: strip its references and trash the file, or
 * only strip the references (also offline, and safe when other notes still use the image).
 */
export function RemoveAttachmentDialog({
  label,
  attachmentId,
  count,
  offline,
  onRemoveFromNote,
  onClose,
}: {
  label: string;
  attachmentId: string;
  count: number;
  offline: boolean;
  onRemoveFromNote: () => void;
  onClose: () => void;
}) {
  const mutation = useDeleteAttachment(() => {
    onRemoveFromNote();
    onClose();
  });
  return (
    <ConfirmShell title="Remove image" busy={mutation.isPending} onClose={onClose}>
      <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
        Remove{" "}
        <span className="font-medium break-all text-neutral-800 dark:text-neutral-200">
          {label}
        </span>{" "}
        from this note{count > 1 ? ` (${count} places)` : ""}? Deleting it from Drive also breaks it
        in any other note that shows it.
      </DialogDescription>
      {offline && (
        <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">
          You are offline: the image can only be removed from this note for now.
        </p>
      )}
      {mutation.error !== null && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {deleteErrorMessage(mutation.error)}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:flex-wrap sm:justify-end">
        <DialogClose type="button" disabled={mutation.isPending} className={CANCEL_CLASS}>
          Cancel
        </DialogClose>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => {
            onRemoveFromNote();
            onClose();
          }}
          className={SECONDARY_CLASS}
        >
          Remove from note only
        </button>
        <button
          type="button"
          disabled={mutation.isPending || offline}
          onClick={() => mutation.mutate(attachmentId)}
          className={DANGER_CLASS}
        >
          {mutation.isPending ? "Deleting…" : "Remove from note & delete from Drive"}
        </button>
      </div>
    </ConfirmShell>
  );
}
