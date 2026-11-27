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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type DriveNode,
  fetchVaultIndex,
  isNameExists,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
} from "../api";
import { fuzzyMatch } from "../commandSearch";
import { normalizeFileName, stripMarkdownExtension } from "../fileName";
import { useOptionalOpsQueue } from "../opsQueue";
import { useSettings } from "../settings";
import { expandTemplate } from "../templates";
import {
  type FolderEntry,
  knownFolders,
  VAULT_INDEX_KEY,
  withoutRootAttachmentsFolder,
} from "../treeCache";
import { useOnlineStatus } from "../useOnlineStatus";
import { readTemplates } from "../vaultDocuments";
import { noteStem } from "../wikilinks";
import type { FolderTarget } from "./CommandPalette";
import { CheckIcon, ChevronsUpDownIcon, FolderIcon } from "./icons";

const MAX_FOLDER_RESULTS = 50;

export interface NewFromTemplateRequest {
  folder: FolderTarget;
  name: string;
  content: string;
  initialCursor: number;
}

interface FolderOption {
  id: string;
  name: string;
  /** Readable path from the vault root, e.g. `Notes` or `Notes / Projects`. */
  displayPath: string;
  /** Folder path below the vault root joined by `/`, or `""` at root (for `{{folder}}`). */
  templateFolder: string;
}

function buildFolderOptions(
  folders: ReadonlyMap<string, FolderEntry>,
  rootId: string,
): FolderOption[] {
  const out: FolderOption[] = [];
  for (const folder of folders.values()) {
    const chain: FolderEntry[] = [];
    const visited = new Set<string>();
    let current: FolderEntry | undefined = folder;
    let reachesRoot = false;
    while (current !== undefined) {
      if (visited.has(current.id)) {
        break;
      }
      visited.add(current.id);
      chain.push(current);
      if (current.id === rootId) {
        reachesRoot = true;
        break;
      }
      current = current.parentId !== null ? folders.get(current.parentId) : undefined;
    }
    if (!reachesRoot) {
      continue;
    }
    chain.reverse();
    out.push({
      id: folder.id,
      name: folder.name,
      displayPath: chain.map((entry) => entry.name).join(" / "),
      templateFolder: chain
        .slice(1)
        .map((entry) => entry.name)
        .join("/"),
    });
  }
  const collator = new Intl.Collator("en", { sensitivity: "accent", numeric: true });
  return out.sort(
    (a, b) =>
      (a.id === rootId ? -1 : b.id === rootId ? 1 : 0) ||
      collator.compare(a.displayPath, b.displayPath),
  );
}

function createTemplateNoteError(error: unknown): string {
  if (isNameExists(error)) {
    return "A file with this name already exists in this folder.";
  }
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "The destination folder could not be found.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to create the note. Try again.";
}

export function NewFromTemplateDialog({
  open,
  rootFolder,
  defaultFolderId,
  onClose,
  onCreate,
}: {
  open: boolean;
  rootFolder: DriveNode | undefined;
  defaultFolderId?: string;
  onClose: () => void;
  onCreate: (request: NewFromTemplateRequest) => Promise<void>;
}) {
  if (!open || rootFolder === undefined) {
    return null;
  }
  return (
    <OpenNewFromTemplateDialog
      rootFolder={rootFolder}
      defaultFolderId={defaultFolderId}
      onClose={onClose}
      onCreate={onCreate}
    />
  );
}

function OpenNewFromTemplateDialog({
  rootFolder,
  defaultFolderId,
  onClose,
  onCreate,
}: {
  rootFolder: DriveNode;
  defaultFolderId?: string;
  onClose: () => void;
  onCreate: (request: NewFromTemplateRequest) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const opsQueue = useOptionalOpsQueue();
  const online = useOnlineStatus();
  const { attachmentsFolder, showAttachmentsFolder, templatesFolder } = useSettings();
  const titleId = useId();
  const folderSearchId = useId();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderQuery, setFolderQuery] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const templatesQuery = useQuery({
    queryKey: ["templates-picker", rootFolder.id, templatesFolder],
    queryFn: ({ signal }) => readTemplates(queryClient, signal, templatesFolder),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const indexQuery = useQuery({
    queryKey: VAULT_INDEX_KEY,
    queryFn: async ({ signal }) => {
      const raw = await fetchVaultIndex(signal);
      return opsQueue !== null ? opsQueue.overlayVaultIndex(raw) : raw;
    },
    enabled: online,
    staleTime: 60_000,
    retry: false,
  });

  const templates = templatesQuery.data ?? [];
  const effectiveTemplateId =
    selectedTemplateId !== null && templates.some((t) => t.id === selectedTemplateId)
      ? selectedTemplateId
      : (templates[0]?.id ?? null);
  const selectedTemplate = templates.find((t) => t.id === effectiveTemplateId) ?? null;

  const templateItems = useMemo(
    () => templates.map((t) => ({ value: t.id, label: noteStem(t.name) })),
    [templates],
  );

  const folderOptions = useMemo(() => {
    void indexQuery.data;
    const allFolders = knownFolders(queryClient);
    if (!allFolders.has(rootFolder.id)) {
      allFolders.set(rootFolder.id, { id: rootFolder.id, name: rootFolder.name, parentId: null });
    }
    const visibleFolders = showAttachmentsFolder
      ? allFolders
      : withoutRootAttachmentsFolder(allFolders, rootFolder.id, attachmentsFolder);
    return buildFolderOptions(visibleFolders, rootFolder.id);
  }, [indexQuery.data, queryClient, rootFolder, attachmentsFolder, showAttachmentsFolder]);

  const effectiveFolderId =
    selectedFolderId !== null && folderOptions.some((f) => f.id === selectedFolderId)
      ? selectedFolderId
      : defaultFolderId !== undefined && folderOptions.some((f) => f.id === defaultFolderId)
        ? defaultFolderId
        : rootFolder.id;
  const selectedFolder = folderOptions.find((f) => f.id === effectiveFolderId) ?? {
    id: rootFolder.id,
    name: rootFolder.name,
    displayPath: rootFolder.name,
    templateFolder: "",
  };

  const filteredFolders = useMemo(() => {
    if (folderQuery.trim().length === 0) {
      return folderOptions.slice(0, MAX_FOLDER_RESULTS);
    }
    return folderOptions
      .map((option) => ({ option, match: fuzzyMatch(folderQuery, option.displayPath) }))
      .filter((entry) => entry.match !== null)
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
      .slice(0, MAX_FOLDER_RESULTS)
      .map((entry) => entry.option);
  }, [folderOptions, folderQuery]);

  const mutation = useMutation({
    mutationFn: (request: NewFromTemplateRequest) => onCreate(request),
    onSuccess: () => {
      onClose();
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending || selectedTemplate === null) {
      return;
    }
    const normalized = normalizeFileName(title);
    if (!normalized.ok) {
      setValidationError(normalized.error);
      titleInputRef.current?.focus();
      return;
    }
    setValidationError(null);
    const stem = stripMarkdownExtension(normalized.name);
    const expanded = expandTemplate(selectedTemplate.text.replace(/\r\n?/g, "\n"), {
      now: new Date(),
      title: stem,
      folder: selectedFolder.templateFolder,
    });
    mutation.mutate({
      folder: { id: selectedFolder.id, name: selectedFolder.name },
      name: normalized.name,
      content: expanded.text,
      initialCursor: expanded.cursor,
    });
  };

  const errorMessage =
    validationError ?? (mutation.error !== null ? createTemplateNoteError(mutation.error) : null);

  return (
    <Dialog
      open
      dismissible={!mutation.isPending}
      onOpenChange={(next) => {
        if (!next && !mutation.isPending) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-40 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-[12%] left-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="space-y-1">
          <DialogTitle className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            New note from template
          </DialogTitle>
          <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
            Choose a template from{" "}
            <span className="font-medium text-neutral-800 dark:text-neutral-200">
              {templatesFolder}
            </span>
            , give the note a title, and pick its folder.
          </DialogDescription>
        </div>

        {templatesQuery.isPending ? (
          <div className="mt-4 space-y-4">
            <p role="status" className="text-sm text-neutral-500 dark:text-neutral-400">
              Loading templates…
            </p>
            <div className="flex justify-end">
              <DialogClose
                type="button"
                className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Cancel
              </DialogClose>
            </div>
          </div>
        ) : templates.length === 0 ? (
          <div className="mt-4 space-y-4">
            <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3.5 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400">
              No templates found in{" "}
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                {templatesFolder}
              </span>
              . Add a Markdown note to your {templatesFolder} folder to create notes from a
              template.
            </p>
            <div className="flex justify-end">
              <DialogClose
                type="button"
                className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                Close
              </DialogClose>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Select
                items={templateItems}
                value={effectiveTemplateId}
                disabled={mutation.isPending}
                onValueChange={(next) => {
                  if (next !== null) {
                    setSelectedTemplateId(next);
                  }
                }}
              >
                <SelectLabel className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Template
                </SelectLabel>
                <SelectTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:border-blue-500 focus-visible:outline-2 focus-visible:outline-blue-500/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100">
                  <SelectValue className="truncate" />
                  <ChevronsUpDownIcon className="size-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
                </SelectTrigger>
                <SelectContent
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  className="z-50 max-h-60 min-w-(--anchor-width) overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 text-neutral-900 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
                >
                  {templateItems.map((item) => (
                    <SelectItem
                      key={item.value}
                      value={item.value}
                      className="flex cursor-default items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm text-neutral-700 outline-none select-none data-highlighted:bg-neutral-100 data-highlighted:text-neutral-950 data-selected:font-medium data-selected:text-neutral-950 dark:text-neutral-200 dark:data-highlighted:bg-neutral-800 dark:data-highlighted:text-neutral-50 dark:data-selected:text-neutral-50"
                    >
                      <span className="truncate">{item.label}</span>
                      <SelectItemIndicator className="shrink-0 text-blue-600 dark:text-blue-400">
                        <CheckIcon className="size-4" />
                      </SelectItemIndicator>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={titleId}
                className="block text-xs font-medium text-neutral-700 dark:text-neutral-300"
              >
                Title
              </label>
              <input
                ref={titleInputRef}
                id={titleId}
                type="text"
                autoFocus
                value={title}
                disabled={mutation.isPending}
                aria-invalid={validationError !== null}
                placeholder="e.g. Weekly Sync"
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (validationError !== null) {
                    setValidationError(null);
                  }
                  if (mutation.isError) {
                    mutation.reset();
                  }
                }}
                className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 disabled:opacity-50 aria-invalid:border-red-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label
                  htmlFor={folderSearchId}
                  className="text-xs font-medium text-neutral-700 dark:text-neutral-300"
                >
                  Destination folder
                </label>
                <span
                  data-testid="selected-folder-path"
                  className="truncate text-xs text-neutral-500 dark:text-neutral-400"
                  title={selectedFolder.displayPath}
                >
                  {selectedFolder.displayPath}
                </span>
              </div>
              <input
                id={folderSearchId}
                type="search"
                value={folderQuery}
                disabled={mutation.isPending}
                placeholder="Filter folders…"
                onChange={(event) => {
                  setFolderQuery(event.target.value);
                  if (mutation.isError) {
                    mutation.reset();
                  }
                }}
                className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
              />
              <div className="max-h-44 overflow-y-auto rounded-lg border border-neutral-200 p-1 dark:border-neutral-800">
                {filteredFolders.length === 0 ? (
                  <p className="px-2.5 py-2 text-sm text-neutral-500 dark:text-neutral-400">
                    {indexQuery.isFetching ? "Loading folders…" : "No matching folder."}
                  </p>
                ) : (
                  <Listbox
                    aria-label="Destination folders"
                    disabled={mutation.isPending}
                    value={effectiveFolderId}
                    onValueChange={(next) => {
                      if (next !== null) {
                        setSelectedFolderId(next);
                        if (mutation.isError) {
                          mutation.reset();
                        }
                      }
                    }}
                  >
                    {filteredFolders.map((folder) => (
                      <ListboxItem
                        key={folder.id}
                        value={folder.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 data-disabled:cursor-default data-disabled:opacity-60 data-selected:bg-blue-50 data-selected:text-blue-900 not-data-selected:hover:bg-neutral-100 dark:data-selected:bg-blue-950/60 dark:data-selected:text-blue-100 dark:not-data-selected:hover:bg-neutral-800"
                      >
                        <FolderIcon className="size-3.5 shrink-0 text-neutral-400" />
                        <span className="min-w-0 flex-1 truncate" title={folder.displayPath}>
                          {folder.displayPath}
                        </span>
                        <ListboxItemIndicator className="shrink-0 text-blue-600 dark:text-blue-400">
                          <CheckIcon className="size-3.5" />
                        </ListboxItemIndicator>
                      </ListboxItem>
                    ))}
                  </Listbox>
                )}
              </div>
            </div>

            {errorMessage !== null && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
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
                {mutation.isPending ? "Creating…" : "Create note"}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
