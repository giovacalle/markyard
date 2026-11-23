import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTreeController,
  Tree,
  TreeGroup,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
  type TreeController,
} from "@ui-sdk/react/tree";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { fetchChildren, fetchVaultIndex, type DriveNode } from "../api";
import { readAllCachedFolders, writeCachedFolder } from "../localCache";
import { isLocalId } from "../localIds";
import { type OpsQueue, useOptionalOpsQueue } from "../opsQueue";
import { useSettings } from "../settings";
import {
  ancestorIdsFromPath,
  canMoveInto,
  childrenKey,
  indexedAncestorIds,
  isRootAttachmentsFolder,
  knownAncestorIds,
  knownFolders,
  relativePath,
  VAULT_INDEX_KEY,
} from "../treeCache";
import {
  readExpandedFolders,
  subscribeExpandedFolders,
  writeExpandedFolders,
} from "../treeExpanded";
import { FileActionsPopover } from "./FileActionsPopover";
import { FolderActionsPopover } from "./FolderActionsPopover";
import { ChevronIcon, FileIcon, FolderIcon } from "./icons";
import { RetryScope, type OnRetry } from "./RetryScope";

const byName = new Intl.Collator("en", { sensitivity: "accent" });
/** Folders first, then Markdown files; each group by name, ignoring case. */
export function sortNodes(nodes: DriveNode[]): DriveNode[] {
  const rank = (node: DriveNode) => (node.kind === "folder" ? 0 : 1);
  return [...nodes].sort((a, b) => rank(a) - rank(b) || byName.compare(a.name, b.name));
}

function visibleNodes(nodes: DriveNode[]): DriveNode[] {
  return nodes.filter((node) => node.kind !== "other");
}

function duplicateNames(nodes: DriveNode[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.name)) {
      duplicates.add(node.name);
    } else {
      seen.add(node.name);
    }
  }
  return duplicates;
}

function childrenQuery(folderId: string, queryClient: QueryClient, opsQueue: OpsQueue | null) {
  return {
    queryKey: childrenKey(folderId),
    networkMode: isLocalId(folderId) ? ("always" as const) : ("online" as const),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (isLocalId(folderId)) {
        const cached = queryClient.getQueryData<DriveNode[]>(childrenKey(folderId));
        if (cached !== undefined) {
          return cached;
        }
        const all = await readAllCachedFolders();
        return all.find((folder) => folder.folderId === folderId)?.nodes ?? [];
      }
      const raw = await fetchChildren(folderId, signal);
      const nodes = opsQueue !== null ? opsQueue.overlayListing(folderId, raw) : raw;
      void writeCachedFolder(folderId, nodes);
      return nodes;
    },
  };
}

function useChildren(folderId: string) {
  const queryClient = useQueryClient();
  const opsQueue = useOptionalOpsQueue();
  return useQuery(childrenQuery(folderId, queryClient, opsQueue));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface TreeContextValue {
  rootFolderId: string;
  opened: Set<string>;
  controller: TreeController;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  onCreateInFolder?: (folder: DriveNode) => void;
  onCreateSubfolder?: (folder: DriveNode) => void;
  onRenameFolder?: (folder: DriveNode) => void;
  onDeleteFolder?: (folder: DriveNode) => void;
  onDeleteFile?: (file: DriveNode) => void;
  onMove?: (node: DriveNode) => void;
  drag: TreeDrag | null;
}

/** Drag-and-drop moves inside the tree. */
interface TreeDrag {
  /** The row being dragged, with the folder it sits in. */
  dragging: { node: DriveNode; parentId: string } | null;
  dropTargetId: string | null;
  start: (node: DriveNode, parentId: string) => void;
  /** Whether the dragged row may land in `folderId`. */
  canDrop: (folderId: string) => boolean;
  setDropTarget: (folderId: string | null) => void;
  drop: (folderId: string) => void;
  end: () => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTreeContext(): TreeContextValue {
  const value = useContext(TreeContext);
  if (value === null) {
    throw new Error("FileTree parts must be rendered inside RootTree.");
  }
  return value;
}

export function FileTree({
  folderId,
  label,
  onOpen,
  onCreateInFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteFile,
  onMove,
  onDropMove,
  selectedId = null,
  revealPath,
}: {
  folderId: string;
  label: string;
  onOpen: (id: string) => void;
  onCreateInFolder?: (folder: DriveNode) => void;
  onCreateSubfolder?: (folder: DriveNode) => void;
  onRenameFolder?: (folder: DriveNode) => void;
  onDeleteFolder?: (folder: DriveNode) => void;
  onDeleteFile?: (file: DriveNode) => void;
  /** Opens the "Move to…" picker for a note or folder. */
  onMove?: (node: DriveNode) => void;
  /** A note or folder was dropped onto a valid folder. */
  onDropMove?: (node: DriveNode, targetFolderId: string) => void;
  selectedId?: string | null;
  /**
   * Folder names below the root leading to `selectedId` (a search hit's `path`), for revealing a
   * note whose folders the tree has not loaded yet.
   */
  revealPath?: readonly string[];
}) {
  return (
    <RetryScope>
      {(onRetry) => (
        <RootFolderContent
          folderId={folderId}
          label={label}
          onRetry={onRetry}
          onOpen={onOpen}
          onCreateInFolder={onCreateInFolder}
          onCreateSubfolder={onCreateSubfolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onDeleteFile={onDeleteFile}
          onMove={onMove}
          onDropMove={onDropMove}
          selectedId={selectedId}
          revealPath={revealPath}
        />
      )}
    </RetryScope>
  );
}

function RootFolderContent({
  folderId,
  label,
  onRetry,
  onOpen,
  onCreateInFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteFile,
  onMove,
  onDropMove,
  selectedId,
  revealPath,
}: {
  folderId: string;
  label: string;
  onRetry: OnRetry;
  onOpen: (id: string) => void;
  onCreateInFolder?: (folder: DriveNode) => void;
  onCreateSubfolder?: (folder: DriveNode) => void;
  onRenameFolder?: (folder: DriveNode) => void;
  onDeleteFolder?: (folder: DriveNode) => void;
  onDeleteFile?: (file: DriveNode) => void;
  /** Opens the "Move to…" picker for a note or folder. */
  onMove?: (node: DriveNode) => void;
  /** A note or folder was dropped onto a valid folder. */
  onDropMove?: (node: DriveNode, targetFolderId: string) => void;
  selectedId: string | null;
  revealPath?: readonly string[];
}) {
  const { attachmentsFolder } = useSettings();
  const { data, error, refetch } = useChildren(folderId);

  if (data === undefined) {
    if (error) {
      return (
        <div className="px-2 py-1.5 text-sm">
          <p className="text-red-600 dark:text-red-400" role="alert">
            Unable to load this folder.
          </p>
          <button
            className="mt-2 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            type="button"
            onClick={() => onRetry(refetch)}
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <p className="px-2 py-1.5 text-sm text-neutral-500 dark:text-neutral-400" role="status">
        Loading folder…
      </p>
    );
  }

  const visible = visibleNodes(data).filter(
    (node) => !isRootAttachmentsFolder(node, folderId, folderId, attachmentsFolder),
  );
  if (visible.length === 0) {
    return (
      <p className="px-2 py-1.5 text-sm text-neutral-500 dark:text-neutral-400">
        This folder is empty.
      </p>
    );
  }

  return (
    <RootTree
      rootFolderId={folderId}
      label={label}
      nodes={visible}
      onOpen={onOpen}
      onCreateInFolder={onCreateInFolder}
      onCreateSubfolder={onCreateSubfolder}
      onRenameFolder={onRenameFolder}
      onDeleteFolder={onDeleteFolder}
      onDeleteFile={onDeleteFile}
      onMove={onMove}
      onDropMove={onDropMove}
      selectedId={selectedId}
      revealPath={revealPath}
    />
  );
}

function RootTree({
  rootFolderId,
  label,
  nodes,
  onOpen,
  onCreateInFolder,
  onCreateSubfolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteFile,
  onMove,
  onDropMove,
  selectedId,
  revealPath,
}: {
  rootFolderId: string;
  label: string;
  nodes: DriveNode[];
  onOpen: (id: string) => void;
  onCreateInFolder?: (folder: DriveNode) => void;
  onCreateSubfolder?: (folder: DriveNode) => void;
  onRenameFolder?: (folder: DriveNode) => void;
  onDeleteFolder?: (folder: DriveNode) => void;
  onDeleteFile?: (file: DriveNode) => void;
  /** Opens the "Move to…" picker for a note or folder. */
  onMove?: (node: DriveNode) => void;
  /** A note or folder was dropped onto a valid folder. */
  onDropMove?: (node: DriveNode, targetFolderId: string) => void;
  selectedId: string | null;
  revealPath?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const opsQueue = useOptionalOpsQueue();
  const [expanded, setExpanded] = useState<string[]>(() => readExpandedFolders(rootFolderId));
  const [opened, setOpened] = useState<Set<string>>(() => new Set(expanded));
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [controller] = useState(() => createTreeController());
  const [dragging, setDragging] = useState<{ node: DriveNode; parentId: string } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const drag: TreeDrag | null =
    onDropMove === undefined
      ? null
      : {
          dragging,
          dropTargetId,
          start: (node, parentId) => setDragging({ node, parentId }),
          canDrop: (folderId) =>
            dragging !== null &&
            canMoveInto(
              knownFolders(queryClient),
              rootFolderId,
              {
                id: dragging.node.id,
                kind: dragging.node.kind,
                parentId: dragging.parentId,
              },
              folderId,
            ),
          setDropTarget: (folderId) =>
            setDropTargetId((prev) => (prev === folderId ? prev : folderId)),
          drop: (folderId) => {
            const item = dragging;
            setDragging(null);
            setDropTargetId(null);
            if (item !== null) {
              onDropMove(item.node, folderId);
            }
          },
          end: () => {
            setDragging(null);
            setDropTargetId(null);
          },
        };

  const expandedRef = useRef(expanded);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  // A note picked in the tree is already in view: only notes opened elsewhere are revealed.
  const pickedInTreeRef = useRef<string | null>(null);

  const showExpanded = (nextExpanded: string[]) => {
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    setOpened((prev) => {
      let next: Set<string> | null = null;
      for (const id of nextExpanded) {
        if (!prev.has(id)) {
          next ??= new Set(prev);
          next.add(id);
        }
      }
      return next ?? prev;
    });
  };

  const handleExpandedChange = (nextExpanded: string[]) => {
    showExpanded(nextExpanded);
    writeExpandedFolders(rootFolderId, nextExpanded);
  };

  // Follow writes made elsewhere (cloud state sync applying another device's folders).
  useEffect(
    () =>
      subscribeExpandedFolders((root, next) => {
        const current = expandedRef.current;
        if (
          root === rootFolderId &&
          (next.length !== current.length || next.some((id, i) => id !== current[i]))
        ) {
          showExpanded([...next]);
        }
      }),
    // showExpanded only touches state setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootFolderId],
  );

  // Search paths arrive as fresh arrays: key the effect on their content, read them via the ref.
  const revealPathRef = useRef(revealPath);
  revealPathRef.current = revealPath;
  const revealKey = revealPath?.join("/");
  // Reveal the open note: expand the folders above it, then scroll it into view. Runs when the
  // selection changes (Cmd+K, a restored note, `?file=`), so collapsing a folder later sticks.
  useEffect(() => {
    if (selectedId === null || selectedId === pickedInTreeRef.current) {
      return;
    }
    pickedInTreeRef.current = null;
    let cancelled = false;
    const reveal = (ancestors: string[]) => {
      if (cancelled) {
        return;
      }
      const current = expandedRef.current;
      const missing = ancestors.filter((id) => !current.includes(id));
      if (missing.length > 0) {
        handleExpandedChange([...current, ...missing]);
      }
      setScrollTarget(selectedId);
    };
    const known = knownAncestorIds(queryClient, rootFolderId, selectedId);
    if (known !== null) {
      reveal(known);
      return;
    }
    const path = revealPathRef.current;
    if (path !== undefined) {
      ancestorIdsFromPath(rootFolderId, path, selectedId, (id) =>
        queryClient.ensureQueryData(childrenQuery(id, queryClient, opsQueue)),
      ).then(
        (ids) => {
          if (ids !== null) {
            reveal(ids);
          }
        },
        () => undefined,
      );
      return () => {
        cancelled = true;
      };
    }
    // No path to follow (a restored note, `?file=`): wait for the listing that holds the note
    // (e.g. cached folders hydrating). Once the root listing is in and the note is still not
    // found, it sits in a folder the tree never listed: ask the vault index for its folders.
    let indexRequested = false;
    let done = false;
    const check = () => {
      if (done) {
        return;
      }
      const found = indexedAncestorIds(queryClient, rootFolderId, selectedId);
      if (found !== null) {
        done = true;
        unsubscribe();
        reveal(found);
        return;
      }
      if (!indexRequested && queryClient.getQueryData(childrenKey(rootFolderId)) !== undefined) {
        indexRequested = true;
        queryClient
          .fetchQuery({
            queryKey: VAULT_INDEX_KEY,
            queryFn: async ({ signal }) => {
              const raw = await fetchVaultIndex(signal);
              return opsQueue !== null ? opsQueue.overlayVaultIndex(raw) : raw;
            },
            staleTime: 60_000,
            retry: false,
          })
          .catch(() => undefined);
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // handleExpandedChange only touches state setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, revealKey, rootFolderId, queryClient, opsQueue]);

  // The note's row may render only after its folders' listings load: scroll once it is there.
  useEffect(() => {
    const container = containerRef.current;
    if (scrollTarget === null || container === null) {
      return;
    }
    const tryScroll = () => {
      const row = container.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(scrollTarget)}"]`,
      );
      if (row === null) {
        return false;
      }
      row.scrollIntoView?.({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      setScrollTarget(null);
      return true;
    };
    if (tryScroll()) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (tryScroll()) {
        observer.disconnect();
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    const giveUp = window.setTimeout(() => {
      observer.disconnect();
      setScrollTarget(null);
    }, 10_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(giveUp);
    };
  }, [scrollTarget]);

  const handleCreateInFolder = onCreateInFolder
    ? (folder: DriveNode) => {
        if (!expanded.includes(folder.id)) {
          handleExpandedChange([...expanded, folder.id]);
        }
        onCreateInFolder(folder);
      }
    : undefined;

  const handleCreateSubfolder = onCreateSubfolder
    ? (folder: DriveNode) => {
        if (!expanded.includes(folder.id)) {
          handleExpandedChange([...expanded, folder.id]);
        }
        onCreateSubfolder(folder);
      }
    : undefined;

  const handleAction = (value: string) => {
    for (const [, list] of queryClient.getQueriesData<DriveNode[]>({ queryKey: ["folders"] })) {
      const hit = list?.find((node) => node.id === value);
      if (hit) {
        if (hit.kind === "markdown") {
          pickedInTreeRef.current = hit.id;
          onOpen(hit.id);
        }
        return;
      }
    }
  };

  return (
    <TreeContext
      value={{
        rootFolderId,
        opened,
        controller,
        openMenuId,
        setOpenMenuId,
        onCreateInFolder: handleCreateInFolder,
        onCreateSubfolder: handleCreateSubfolder,
        onRenameFolder,
        onDeleteFolder,
        onDeleteFile,
        onMove,
        drag,
      }}
    >
      <div
        ref={containerRef}
        data-drop-target={drag?.dropTargetId === rootFolderId ? "true" : undefined}
        onDragOver={(event) => {
          if (drag?.dragging && drag.canDrop(rootFolderId)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            drag.setDropTarget(rootFolderId);
          }
        }}
        onDragLeave={(event) => {
          if (
            drag?.dropTargetId === rootFolderId &&
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            drag.setDropTarget(null);
          }
        }}
        onDrop={(event) => {
          if (drag?.dragging && drag.canDrop(rootFolderId)) {
            event.preventDefault();
            drag.drop(rootFolderId);
          }
        }}
        className="rounded-md data-[drop-target]:bg-blue-50 data-[drop-target]:outline-2 data-[drop-target]:outline-blue-400 dark:data-[drop-target]:bg-blue-950/40"
      >
        <Tree
          aria-label={label}
          controller={controller}
          value={selectedId}
          expanded={expanded}
          onExpandedChange={handleExpandedChange}
          onAction={handleAction}
          className="space-y-0.5 text-sm"
        >
          <Nodes nodes={nodes} parentId={rootFolderId} />
        </Tree>
      </div>
    </TreeContext>
  );
}

function Nodes({ nodes, parentId }: { nodes: DriveNode[]; parentId: string }) {
  const queryClient = useQueryClient();
  const {
    rootFolderId,
    opened,
    openMenuId,
    setOpenMenuId,
    onCreateInFolder,
    onCreateSubfolder,
    onRenameFolder,
    onDeleteFolder,
    onDeleteFile,
    onMove,
    drag,
  } = useTreeContext();
  const duplicates = duplicateNames(nodes);

  return (
    <>
      {sortNodes(nodes).map((node) => {
        const isFolder = node.kind === "folder";
        // Every folder and note has at least "Copy path".
        const hasPopover = isFolder || node.kind === "markdown";
        const getPath = () => relativePath(queryClient, rootFolderId, node.id);
        const menuOpen = openMenuId === node.id;
        // Dropping onto a note's row means its folder; onto a folder's row, that folder.
        const dropFolderId = isFolder ? node.id : parentId;
        const draggable = drag !== null && (isFolder || node.kind === "markdown");
        return (
          <TreeItem
            key={node.id}
            value={node.id}
            data-node-id={node.id}
            label={node.name}
            branch={isFolder}
            disabled={node.kind === "other"}
            className="outline-none"
          >
            <TreeItemLabel
              draggable={draggable || undefined}
              data-drop-target={drag?.dropTargetId === node.id && isFolder ? "true" : undefined}
              data-dragging={drag?.dragging?.node.id === node.id ? "true" : undefined}
              onDragStart={
                draggable
                  ? (event) => {
                      event.stopPropagation();
                      event.dataTransfer?.setData("text/plain", node.name);
                      if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = "move";
                      }
                      drag?.start(node, parentId);
                    }
                  : undefined
              }
              onDragEnd={drag ? () => drag.end() : undefined}
              onDragOver={
                drag
                  ? (event) => {
                      if (!drag.dragging) {
                        return;
                      }
                      event.stopPropagation();
                      if (drag.canDrop(dropFolderId)) {
                        event.preventDefault();
                        if (event.dataTransfer) {
                          event.dataTransfer.dropEffect = "move";
                        }
                        drag.setDropTarget(dropFolderId);
                      } else {
                        drag.setDropTarget(null);
                      }
                    }
                  : undefined
              }
              onDrop={
                drag
                  ? (event) => {
                      event.stopPropagation();
                      if (drag.dragging && drag.canDrop(dropFolderId)) {
                        event.preventDefault();
                        drag.drop(dropFolderId);
                      }
                    }
                  : undefined
              }
              onContextMenu={(event) => {
                if (!hasPopover) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setOpenMenuId(node.id);
              }}
              className="group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-neutral-700 select-none hover:bg-neutral-200/60 [[role=treeitem]:focus-visible>&]:outline-2 [[role=treeitem]:focus-visible>&]:outline-blue-600 data-[selected]:bg-neutral-200/90 data-[selected]:font-medium data-[selected]:text-neutral-950 data-[disabled]:cursor-not-allowed data-[disabled]:text-neutral-400 data-[disabled]:hover:bg-transparent data-[dragging]:opacity-50 data-[drop-target]:bg-blue-100 data-[drop-target]:outline-2 data-[drop-target]:outline-blue-500 dark:text-neutral-300 dark:data-[drop-target]:bg-blue-950/60 dark:hover:bg-neutral-800/70 dark:data-[selected]:bg-neutral-800 dark:data-[selected]:text-neutral-50 dark:data-[disabled]:text-neutral-600"
            >
              {isFolder ? (
                <TreeItemIndicator className="inline-flex size-4 shrink-0 items-center justify-center text-neutral-400 transition-transform data-[expanded]:rotate-90 dark:text-neutral-500">
                  <ChevronIcon className="size-3.5" />
                </TreeItemIndicator>
              ) : (
                <span aria-hidden="true" className="inline-block size-4 shrink-0" />
              )}
              {isFolder ? (
                <FolderIcon className="size-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-neutral-400 dark:text-neutral-500" />
              )}
              <span className="truncate">{node.name}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {duplicates.has(node.name) && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    Duplicate name
                  </span>
                )}
                {isFolder && (
                  <FolderActionsPopover
                    folder={node}
                    open={menuOpen}
                    onOpenChange={(next) => setOpenMenuId(next ? node.id : null)}
                    onCreateNote={onCreateInFolder}
                    onCreateSubfolder={onCreateSubfolder}
                    onRename={onRenameFolder}
                    onMove={onMove}
                    onDelete={onDeleteFolder}
                    getPath={getPath}
                  />
                )}
                {node.kind === "markdown" && (
                  <FileActionsPopover
                    file={node}
                    open={menuOpen}
                    onOpenChange={(next) => setOpenMenuId(next ? node.id : null)}
                    onMove={onMove}
                    onDelete={onDeleteFile}
                    getPath={getPath}
                  />
                )}
              </span>
            </TreeItemLabel>
            {isFolder && opened.has(node.id) && (
              <TreeGroup keepMounted className="pl-3">
                <FolderChildren folderId={node.id} />
              </TreeGroup>
            )}
          </TreeItem>
        );
      })}
    </>
  );
}

function FolderChildren({ folderId }: { folderId: string }) {
  const { controller } = useTreeContext();
  const { data, error, refetch } = useChildren(folderId);

  if (data === undefined) {
    if (error) {
      return (
        <div className="px-2 py-1 text-sm">
          <p className="text-red-600 dark:text-red-400" role="alert">
            Unable to load this folder.
          </p>
          <button
            className="mt-1.5 rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
            type="button"
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              controller.focus(folderId);
              void refetch();
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <p className="px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400" role="status">
        Loading folder…
      </p>
    );
  }

  const visible = visibleNodes(data);
  if (visible.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
        This folder is empty.
      </p>
    );
  }

  return <Nodes nodes={visible} parentId={folderId} />;
}
