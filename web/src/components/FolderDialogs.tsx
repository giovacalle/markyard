import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  createFolder,
  deleteFolder,
  isNameExists,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
  renameFolder,
  type DriveNode,
} from "../api";
import { normalizeFolderName } from "../fileName";
import { useOptionalOpsQueue } from "../opsQueue";
import type { FolderTarget } from "./CommandPalette";

export type FolderDialogState =
  | { mode: "create"; parent: FolderTarget }
  | { mode: "rename"; folder: DriveNode };

function folderMutationError(error: unknown, mode: "create" | "rename"): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isNameExists(error)) {
    return "An item with this name already exists in this folder.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return mode === "create"
      ? "The parent folder could not be found."
      : "This folder could not be found.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return mode === "create"
    ? "Unable to create the folder. Try again."
    : "Unable to rename the folder. Try again.";
}

function deleteFolderErrorMessage(error: unknown): string {
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "This folder was already deleted.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to delete the folder. Try again.";
}

export function FolderNameDialog({
  state,
  onClose,
  onCreated,
  onRenamed,
}: {
  state: FolderDialogState | null;
  onClose: () => void;
  onCreated: (parentId: string, folder: DriveNode) => void;
  onRenamed: (folder: DriveNode) => void;
}) {
  if (state === null) {
    return null;
  }

  const key = state.mode === "create" ? `create:${state.parent.id}` : `rename:${state.folder.id}`;
  return (
    <OpenFolderNameDialog
      key={key}
      state={state}
      onClose={onClose}
      onCreated={onCreated}
      onRenamed={onRenamed}
    />
  );
}

function OpenFolderNameDialog({
  state,
  onClose,
  onCreated,
  onRenamed,
}: {
  state: FolderDialogState;
  onClose: () => void;
  onCreated: (parentId: string, folder: DriveNode) => void;
  onRenamed: (folder: DriveNode) => void;
}) {
  const opsQueue = useOptionalOpsQueue();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(() => (state.mode === "rename" ? state.folder.name : ""));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (state.mode === "rename") {
      input.select();
    }
  }, [state.mode]);

  const mutation = useMutation({
    mutationFn: async (name: string) => {
      if (opsQueue !== null) {
        const result =
          state.mode === "create"
            ? await opsQueue.createFolder({ parentId: state.parent.id, name })
            : await opsQueue.renameFolder(state.folder.id, name, state.folder.name);
        return result.node;
      }
      return state.mode === "create"
        ? createFolder(state.parent.id, name)
        : renameFolder(state.folder.id, name);
    },
    onMutate: () => setPending(true),
    onSettled: () => setPending(false),
    onSuccess: (folder) => {
      if (state.mode === "create") {
        onCreated(state.parent.id, folder);
      } else {
        onRenamed(folder);
      }
      onClose();
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) {
      return;
    }
    const normalized = normalizeFolderName(value);
    if (!normalized.ok) {
      setValidationError(normalized.error);
      return;
    }
    setValidationError(null);
    if (state.mode === "rename" && normalized.name === state.folder.name) {
      onClose();
      return;
    }
    mutation.mutate(normalized.name);
  };

  const errorMessage =
    validationError ??
    (mutation.error !== null ? folderMutationError(mutation.error, state.mode) : null);

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
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <DialogTitle className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              {state.mode === "create" ? "New folder" : "Rename folder"}
            </DialogTitle>
            <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
              {state.mode === "create" ? (
                <>
                  Create a subfolder inside{" "}
                  <span className="font-medium text-neutral-800 dark:text-neutral-200">
                    {state.parent.name}
                  </span>
                  .
                </>
              ) : (
                <>
                  Choose a new name for{" "}
                  <span className="font-medium text-neutral-800 dark:text-neutral-200">
                    {state.folder.name}
                  </span>
                  .
                </>
              )}
            </DialogDescription>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={inputId}
              className="block text-xs font-medium text-neutral-700 dark:text-neutral-300"
            >
              Folder name
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={value}
              disabled={mutation.isPending}
              placeholder="e.g. Projects"
              onChange={(event) => {
                setValue(event.target.value);
                if (validationError !== null) {
                  setValidationError(null);
                }
                if (mutation.isError) {
                  mutation.reset();
                }
              }}
              className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </div>

          {errorMessage !== null && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {errorMessage}
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
              type="submit"
              disabled={mutation.isPending}
              className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {mutation.isPending
                ? state.mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : state.mode === "create"
                  ? "Create"
                  : "Save"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteFolderDialog({
  folder,
  onClose,
  onDeleted,
}: {
  folder: DriveNode | null;
  onClose: () => void;
  onDeleted: (folderId: string) => void;
}) {
  if (folder === null) {
    return null;
  }

  return (
    <OpenDeleteFolderDialog
      key={folder.id}
      folder={folder}
      onClose={onClose}
      onDeleted={onDeleted}
    />
  );
}

function OpenDeleteFolderDialog({
  folder,
  onClose,
  onDeleted,
}: {
  folder: DriveNode;
  onClose: () => void;
  onDeleted: (folderId: string) => void;
}) {
  const opsQueue = useOptionalOpsQueue();
  const [pending, setPending] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (opsQueue !== null) {
        await opsQueue.deleteFolder(folder.id, undefined, folder);
        return;
      }
      await deleteFolder(folder.id);
    },
    onMutate: () => setPending(true),
    onSettled: () => setPending(false),
    onSuccess: () => {
      onDeleted(folder.id);
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
      <DialogContent className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <DialogTitle className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Delete folder
            </DialogTitle>
            <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
              Move{" "}
              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                {folder.name}
              </span>{" "}
              to Google Drive Trash?
            </DialogDescription>
          </div>

          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-300">
            All notes and subfolders inside <span className="font-semibold">{folder.name}</span>{" "}
            will also be moved to Google Drive Trash. You can restore them from Drive later.
          </div>

          {mutation.error !== null && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {deleteFolderErrorMessage(mutation.error)}
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
              {mutation.isPending ? "Deleting…" : "Delete folder"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
