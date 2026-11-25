import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Listbox, ListboxItem, ListboxItemIndicator } from "@ui-sdk/react/listbox";
import { type FormEvent, useId, useState } from "react";
import {
  ApiError,
  createDriveFolder,
  type DriveFoldersResponse,
  type DriveNode,
  fetchDriveFolders,
  isNameExists,
  setVaultRoot,
} from "../api";
import { validateFolderSetting } from "../settings";
import { CheckIcon, ChevronIcon, FolderIcon, FolderPlusIcon, LogOutIcon, NotesLogo } from "./icons";

/** My Drive's top level: browsable, and pickable when the whole drive is the vault. */
const MY_DRIVE = { id: "root", name: "My Drive" } as const;

interface Crumb {
  id: string;
  name: string;
}

export function driveFoldersKey(parentId: string) {
  return ["drive-folders", parentId] as const;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof TypeError) {
    return "You are offline. Try again when you are back online.";
  }
  if (isNameExists(error)) {
    return "A folder with this name already exists here.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

/**
 * Browses the user's Google Drive folders and makes the chosen one the vault root
 * (`PUT /api/vault/root`). `onPicked` receives the new root once the server accepted it.
 */
export function VaultPicker({
  currentRootId,
  onPicked,
}: {
  /** The active vault folder, marked in the list. */
  currentRootId?: string;
  onPicked: (root: DriveNode) => void;
}) {
  const queryClient = useQueryClient();
  const newFolderId = useId();
  const [trail, setTrail] = useState<Crumb[]>([MY_DRIVE]);
  const [selected, setSelected] = useState<DriveNode | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const current = trail[trail.length - 1];

  const folders = useQuery({
    queryKey: driveFoldersKey(current.id),
    queryFn: ({ signal }) => fetchDriveFolders(current.id, signal),
    retry: false,
  });

  const create = useMutation({
    mutationFn: (name: string) => createDriveFolder(name, current.id),
    onSuccess: (folder) => {
      queryClient.setQueryData<DriveFoldersResponse>(driveFoldersKey(current.id), (prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              folders: [...prev.folders.filter((f) => f.id !== folder.id), folder].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
            },
      );
      setSelected(folder);
      setNewFolderOpen(false);
      setNewFolderName("");
    },
  });

  const pick = useMutation({
    mutationFn: (folder: DriveNode) => setVaultRoot(folder.id),
    onSuccess: (root) => onPicked(root),
  });

  // The vault needs a folder to live in: the selected row, else the folder being browsed
  // (`My Drive` itself resolves server-side to the account's root folder).
  const target: Crumb = selected ?? current;
  const busy = pick.isPending || create.isPending;

  const navigate = (nextTrail: Crumb[]) => {
    setTrail(nextTrail);
    setSelected(null);
    setNewFolderOpen(false);
    setNewFolderError(null);
    create.reset();
    pick.reset();
  };

  const submitNewFolder = (event: FormEvent) => {
    event.preventDefault();
    const problem = validateFolderSetting(newFolderName);
    setNewFolderError(problem);
    if (problem === null && !busy) {
      create.mutate(newFolderName.trim());
    }
  };

  const confirm = () => {
    if (busy) {
      return;
    }
    pick.mutate({ id: target.id, name: target.name, kind: "folder", modifiedTime: "" });
  };

  const list = folders.data?.folders ?? [];
  const createError =
    newFolderError ??
    (create.isError ? errorMessage(create.error, "Unable to create the folder.") : null);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <nav aria-label="Folder path" className="min-w-0">
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {trail.map((crumb, i) => {
            const last = i === trail.length - 1;
            return (
              <li key={`${crumb.id}-${i}`} className="flex min-w-0 items-center gap-1">
                {i > 0 && (
                  <span aria-hidden="true" className="text-neutral-400 dark:text-neutral-600">
                    /
                  </span>
                )}
                {last ? (
                  <span
                    aria-current="location"
                    className="truncate font-semibold text-neutral-900 dark:text-neutral-100"
                  >
                    {crumb.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => navigate(trail.slice(0, i + 1))}
                    className="truncate rounded px-1 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  >
                    {crumb.name}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div
        aria-busy={folders.isPending}
        className="max-h-72 min-h-32 overflow-y-auto rounded-lg border border-neutral-200 p-1 dark:border-neutral-800"
      >
        {folders.isPending && (
          <p role="status" className="px-2.5 py-2 text-sm text-neutral-500 dark:text-neutral-400">
            Loading folders…
          </p>
        )}
        {folders.isError && (
          <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-sm">
            <span role="alert" className="text-red-600 dark:text-red-400">
              {errorMessage(folders.error, "Unable to load your Drive folders.")}
            </span>
            <button
              type="button"
              onClick={() => void folders.refetch()}
              className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Retry
            </button>
          </div>
        )}
        {folders.isSuccess && list.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-neutral-500 dark:text-neutral-400">
            No folders here yet.
          </p>
        )}
        {list.length > 0 && (
          // Options may not hold buttons, so each row's "Open" button sits in a sibling column
          // with the same fixed row height.
          <div className="flex gap-1">
            <Listbox
              aria-label={`Folders in ${current.name}`}
              deselectable
              disabled={busy}
              value={selected?.id ?? null}
              onValueChange={(id) => setSelected(list.find((folder) => folder.id === id) ?? null)}
              className="min-w-0 flex-1"
            >
              {list.map((folder) => (
                <ListboxItem
                  key={folder.id}
                  value={folder.id}
                  onDoubleClick={() => {
                    if (!busy) {
                      navigate([...trail, { id: folder.id, name: folder.name }]);
                    }
                  }}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors outline-none focus-visible:outline-2 focus-visible:outline-blue-600 data-disabled:cursor-default data-disabled:opacity-60 data-selected:bg-blue-50 data-selected:text-blue-900 not-data-selected:hover:bg-neutral-100 dark:data-selected:bg-blue-950/60 dark:data-selected:text-blue-100 dark:not-data-selected:hover:bg-neutral-800"
                >
                  <FolderIcon className="size-4 shrink-0 text-neutral-400" />
                  <span className="min-w-0 flex-1 truncate" title={folder.name}>
                    {folder.name}
                  </span>
                  {folder.id === currentRootId && (
                    <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                      Current vault
                    </span>
                  )}
                  <ListboxItemIndicator className="shrink-0">
                    <CheckIcon className="size-4 text-blue-600" />
                  </ListboxItemIndicator>
                </ListboxItem>
              ))}
            </Listbox>
            <div className="flex shrink-0 flex-col">
              {list.map((folder) => (
                <div key={folder.id} className="flex h-8 items-center">
                  <button
                    type="button"
                    aria-label={`Open ${folder.name}`}
                    title={`Open ${folder.name}`}
                    disabled={busy}
                    onClick={() => navigate([...trail, { id: folder.id, name: folder.name }])}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  >
                    <ChevronIcon className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {newFolderOpen ? (
        <form onSubmit={submitNewFolder} className="space-y-1.5">
          <label
            htmlFor={newFolderId}
            className="block text-xs font-medium text-neutral-600 dark:text-neutral-400"
          >
            New folder in {current.name}
          </label>
          <div className="flex gap-2">
            <input
              id={newFolderId}
              type="text"
              autoFocus
              value={newFolderName}
              disabled={busy}
              aria-invalid={newFolderError !== null}
              onChange={(event) => {
                setNewFolderName(event.target.value);
                setNewFolderError(null);
                create.reset();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setNewFolderOpen(false);
                }
              }}
              placeholder="Folder name"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm placeholder:text-neutral-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:placeholder:text-neutral-500"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
          </div>
          {createError !== null && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {createError}
            </p>
          )}
        </form>
      ) : (
        <button
          type="button"
          disabled={busy || folders.isError}
          onClick={() => setNewFolderOpen(true)}
          className="inline-flex items-center gap-1.5 self-start rounded-lg px-2 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <FolderPlusIcon className="size-4" />
          New folder
        </button>
      )}

      {pick.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage(pick.error, "Unable to use this folder. Try again.")}
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={confirm}
        className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pick.isPending ? "Opening vault…" : `Use “${target.name}”`}
      </button>
    </div>
  );
}

/** "Change vault…" from Settings. */
export function VaultPickerDialog({
  open,
  currentRootId,
  onClose,
  onPicked,
}: {
  open: boolean;
  currentRootId?: string;
  onClose: () => void;
  onPicked: (root: DriveNode) => void;
}) {
  if (!open) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-50 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-[10%] left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="mb-3 space-y-1">
          <DialogTitle className="text-base font-semibold">Choose vault folder</DialogTitle>
          <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
            Pick the Google Drive folder that holds your notes, or use My Drive itself.
          </DialogDescription>
        </div>
        <VaultPicker currentRootId={currentRootId} onPicked={onPicked} />
        <div className="mt-3 flex justify-end">
          <DialogClose
            type="button"
            className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Cancel
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Full-page first run: a signed-in account without a vault picks or creates its folder. */
export function VaultOnboarding({
  email,
  name,
  signingOut,
  onSignOut,
  onPicked,
}: {
  email: string;
  name?: string;
  signingOut: boolean;
  onSignOut: () => void;
  onPicked: (root: DriveNode) => void;
}) {
  const displayName = name?.trim() || undefined;
  return (
    <main className="flex min-h-dvh flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <NotesLogo className="size-5" />
          Markyard
        </span>
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-xs text-neutral-600 dark:text-neutral-400">
            {displayName ? `${displayName} (${email})` : email}
          </span>
          <button
            type="button"
            disabled={signingOut}
            onClick={onSignOut}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <LogOutIcon className="size-3.5" />
            Sign out
          </button>
        </div>
      </header>
      <div className="flex flex-1 items-start justify-center p-4 sm:items-center sm:p-6">
        <section
          aria-labelledby="vault-onboarding-title"
          className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <h1 id="vault-onboarding-title" className="text-lg font-semibold">
            Choose your vault folder
          </h1>
          <p className="mt-1 mb-4 text-sm text-neutral-500 dark:text-neutral-400">
            Your notes live in a Google Drive folder. Pick an existing folder, use My Drive itself,
            or create a new one.
          </p>
          <VaultPicker onPicked={onPicked} />
        </section>
      </div>
    </main>
  );
}
