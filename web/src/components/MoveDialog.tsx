import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import { useId, useMemo, useState } from "react";
import { fetchVaultIndex, type DriveNode } from "../api";
import { fuzzyMatch } from "../commandSearch";
import { moveErrorMessage, useMoveNode } from "../moveItem";
import { useOptionalOpsQueue } from "../opsQueue";
import { useSettings } from "../settings";
import {
  knownFolders,
  knownParentId,
  moveTargets,
  VAULT_INDEX_KEY,
  withoutRootAttachmentsFolder,
} from "../treeCache";
import { useOnlineStatus } from "../useOnlineStatus";
import { FolderIcon } from "./icons";

const MAX_RESULTS = 50;

export function MoveDialog({
  node,
  rootId,
  onClose,
  onMoved,
}: {
  node: DriveNode | null;
  rootId: string | undefined;
  onClose: () => void;
  onMoved?: (node: DriveNode, targetId: string) => void;
}) {
  if (node === null || rootId === undefined) {
    return null;
  }
  return (
    <OpenMoveDialog key={node.id} node={node} rootId={rootId} onClose={onClose} onMoved={onMoved} />
  );
}

function OpenMoveDialog({
  node,
  rootId,
  onClose,
  onMoved,
}: {
  node: DriveNode;
  rootId: string;
  onClose: () => void;
  onMoved?: (node: DriveNode, targetId: string) => void;
}) {
  const queryClient = useQueryClient();
  const opsQueue = useOptionalOpsQueue();
  const online = useOnlineStatus();
  const moveNode = useMoveNode();
  const inputId = useId();
  const listLabelId = useId();
  const [query, setQuery] = useState("");
  // The whole vault's folders, for destinations nobody has expanded yet; the cached tree meanwhile.
  const index = useQuery({
    queryKey: VAULT_INDEX_KEY,
    queryFn: async ({ signal }) => {
      const raw = await fetchVaultIndex(signal);
      return opsQueue !== null ? opsQueue.overlayVaultIndex(raw) : raw;
    },
    enabled: online,
    staleTime: 60_000,
    retry: false,
  });

  const { attachmentsFolder, showAttachmentsFolder } = useSettings();
  const targets = useMemo(() => {
    void index.data;
    const allFolders = knownFolders(queryClient);
    const folders = showAttachmentsFolder
      ? allFolders
      : withoutRootAttachmentsFolder(allFolders, rootId, attachmentsFolder);
    const item = { id: node.id, kind: node.kind, parentId: knownParentId(queryClient, node.id) };
    return moveTargets(folders, rootId, item);
  }, [index.data, queryClient, node, rootId, attachmentsFolder, showAttachmentsFolder]);

  const results = useMemo(() => {
    if (query.trim().length === 0) {
      return targets.slice(0, MAX_RESULTS);
    }
    return targets
      .map((target) => ({ target, match: fuzzyMatch(query, target.path) }))
      .filter((entry) => entry.match !== null)
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.target);
  }, [targets, query]);

  const mutation = useMutation({
    mutationFn: (targetId: string) => moveNode(node, targetId),
    onSuccess: (updated, targetId) => {
      onMoved?.(updated, targetId);
      onClose();
    },
  });

  const choose = (targetId: string) => {
    if (!mutation.isPending) {
      mutation.mutate(targetId);
    }
  };

  return (
    <Dialog
      open
      dismissible={!mutation.isPending}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          onClose();
        }
      }}
    >
      <DialogBackdrop className="fixed inset-0 z-40 bg-neutral-950/50 backdrop-blur-[1px]" />
      <DialogContent className="fixed top-[15%] left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-neutral-200 bg-white p-5 text-neutral-900 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="space-y-1">
          <DialogTitle className="text-base font-semibold">Move to…</DialogTitle>
          <DialogDescription className="text-sm text-neutral-500 dark:text-neutral-400">
            Choose a folder for{" "}
            <span className="font-medium text-neutral-800 dark:text-neutral-200">{node.name}</span>.
          </DialogDescription>
        </div>
        <label htmlFor={inputId} className="sr-only">
          Search folders
        </label>
        <Command
          filter={false}
          loop={false}
          query={query}
          onQueryChange={(next, details) => {
            // Escape closes the dialog in one press, even with a filter (ui-sdk would clear it first).
            if (details.reason === "escape-key") {
              if (!mutation.isPending) {
                onClose();
              }
              return;
            }
            setQuery(next);
            if (mutation.isError) {
              mutation.reset();
            }
          }}
          onAction={(targetId) => {
            choose(targetId);
          }}
        >
          <CommandInput
            id={inputId}
            type="text"
            autoFocus
            disabled={mutation.isPending}
            placeholder="Search folders…"
            className="mt-3 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm placeholder:text-neutral-400 focus:border-blue-500 focus:outline-2 focus:outline-blue-500/30 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:placeholder:text-neutral-500"
          />
          {/* CommandList names itself after the input; keep the list's own name. */}
          <span id={listLabelId} hidden>
            Destination folders
          </span>
          <CommandList aria-labelledby={listLabelId} className="mt-2 max-h-72 overflow-y-auto">
            {results.map((target) => (
              <CommandItem
                key={target.id}
                value={target.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm data-highlighted:bg-neutral-100 dark:data-highlighted:bg-neutral-800"
              >
                <FolderIcon className="size-3.5 shrink-0 text-neutral-400" />
                <span className="truncate" title={target.path}>
                  {target.path}
                </span>
              </CommandItem>
            ))}
          </CommandList>
          <CommandEmpty className="text-sm text-neutral-500 data-empty:px-2.5 data-empty:py-1.5 dark:text-neutral-400">
            {index.isFetching ? "Loading folders…" : "No matching folder."}
          </CommandEmpty>
        </Command>
        {mutation.isPending && (
          <p role="status" className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            Moving…
          </p>
        )}
        {mutation.isError && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {moveErrorMessage(mutation.error)}
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <DialogClose
            type="button"
            disabled={mutation.isPending}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            Cancel
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
