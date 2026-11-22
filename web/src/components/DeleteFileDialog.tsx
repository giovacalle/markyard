import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { useState } from "react";
import {
  ApiError,
  deleteFile,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
  type DriveNode,
} from "../api";

function deleteErrorMessage(error: unknown): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "This note was already deleted.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to delete the note. Try again.";
}

export function DeleteFileDialog({
  file,
  onClose,
  onDeleted,
}: {
  file: DriveNode | null;
  onClose: () => void;
  onDeleted: (fileId: string) => void;
}) {
  if (file === null) {
    return null;
  }

  return <OpenDeleteFileDialog key={file.id} file={file} onClose={onClose} onDeleted={onDeleted} />;
}

function OpenDeleteFileDialog({
  file,
  onClose,
  onDeleted,
}: {
  file: DriveNode;
  onClose: () => void;
  onDeleted: (fileId: string) => void;
}) {
  const [pending, setPending] = useState(false);

  const mutation = useMutation({
    mutationFn: () => deleteFile(file.id),
    onMutate: () => setPending(true),
    onSettled: () => setPending(false),
    onSuccess: () => {
      onDeleted(file.id);
      onClose();
    },
  });

  return (
    <Dialog
      open
      dismissible={!pending}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-40 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="space-y-4">
          <div className="space-y-1">
            <DialogTitle className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Delete note
            </DialogTitle>
            <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
              Move{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                {file.name}
              </span>{" "}
              to Google Drive Trash? You can restore it from Drive later.
            </DialogDescription>
          </div>

          {mutation.error !== null && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {deleteErrorMessage(mutation.error)}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <DialogClose
              type="button"
              disabled={mutation.isPending}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Cancel
            </DialogClose>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className="rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 dark:bg-red-600 dark:hover:bg-red-500"
            >
              {mutation.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
