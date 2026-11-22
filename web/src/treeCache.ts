import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { DriveNode, VaultIndex } from "./api";

/** Query key of the whole-vault folder and note index (`GET /api/vault/index`). */
export const VAULT_INDEX_KEY = ["vault", "index"] as const;

/** Query key of a folder's children, shared by the tree and anything that edits it. */
export function childrenKey(folderId: string) {
  return ["folders", folderId, "children"] as const;
}

function listings(queryClient: QueryClient): [string, DriveNode[]][] {
  const out: [string, DriveNode[]][] = [];
  for (const [key, list] of queryClient.getQueriesData<DriveNode[]>({ queryKey: ["folders"] })) {
    if (list !== undefined && typeof key[1] === "string") {
      out.push([key[1], list]);
    }
  }
  return out;
}

/** Ids of the loaded folder listings that contain `id`. */
export function listingsContaining(queryClient: QueryClient, id: string): string[] {
  return listings(queryClient)
    .filter(([, list]) => list.some((node) => node.id === id))
    .map(([folderId]) => folderId);
}

/** A node already listed somewhere in the tree, or the root folder itself. */
export function findNode(queryClient: QueryClient, id: string): DriveNode | undefined {
  const root = queryClient.getQueryData<DriveNode>(["root"]);
  if (root?.id === id) {
    return root;
  }
  for (const [, list] of listings(queryClient)) {
    const hit = list.find((node) => node.id === id);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** The folder whose listing contains `id`, if the tree has loaded it. */
export function findParent(queryClient: QueryClient, id: string): DriveNode | undefined {
  for (const [folderId, list] of listings(queryClient)) {
    if (list.some((node) => node.id === id)) {
      return findNode(queryClient, folderId);
    }
  }
  return undefined;
}

/**
 * The folders from just below `rootId` down to the folder holding `id`, read from listings the tree
 * already has; `null` while some link of the chain is not loaded.
 */
export function knownAncestorIds(
  queryClient: QueryClient,
  rootId: string,
  id: string,
): string[] | null {
  const all = listings(queryClient);
  const chain: string[] = [];
  let current = id;
  for (let depth = 0; depth <= all.length; depth += 1) {
    const parent = all.find(([, list]) => list.some((node) => node.id === current))?.[0];
    if (parent === undefined) {
      return null;
    }
    if (parent === rootId) {
      return chain.reverse();
    }
    chain.push(parent);
    current = parent;
  }
  return null;
}

/**
 * `id`'s path below the root, e.g. `0Projects/markyard/README.md` (the root's own name left
 * out), from the listings already loaded; `null` while the chain is not known.
 */
export function relativePath(queryClient: QueryClient, rootId: string, id: string): string | null {
  const ancestors = knownAncestorIds(queryClient, rootId, id);
  if (ancestors === null) {
    return null;
  }
  const names: string[] = [];
  for (const nodeId of [...ancestors, id]) {
    const node = findNode(queryClient, nodeId);
    if (node === undefined) {
      return null;
    }
    names.push(node.name);
  }
  return names.join("/");
}

/**
 * Resolves a search hit's folder path (names below the root, as `/api/search` returns them) to
 * folder ids, loading each listing on the way. Among same-named folders it takes the one that
 * leads to `fileId`. `null` when the path no longer matches the tree.
 */
export async function ancestorIdsFromPath(
  rootId: string,
  path: readonly string[],
  fileId: string,
  loadChildren: (folderId: string) => Promise<DriveNode[]>,
): Promise<string[] | null> {
  const walk = async (folderId: string, depth: number): Promise<string[] | null> => {
    const children = await loadChildren(folderId);
    if (depth === path.length) {
      return children.some((node) => node.id === fileId) ? [] : null;
    }
    for (const child of children) {
      if (child.kind === "folder" && child.name === path[depth]) {
        const rest = await walk(child.id, depth + 1);
        if (rest !== null) {
          return [child.id, ...rest];
        }
      }
    }
    return null;
  };
  return walk(rootId, 0);
}

/**
 * Puts a freshly created node into its folder's listing without a refetch: a Drive listing right
 * after a create can still miss the new file.
 */
export function addChild(queryClient: QueryClient, folderId: string, node: DriveNode): void {
  queryClient.setQueryData<DriveNode[]>(childrenKey(folderId), (list) =>
    list === undefined ? list : [...list.filter((n) => n.id !== node.id), node],
  );
}

/** Replaces a renamed node in every cached folder listing that contains it. */
export function renameChild(queryClient: QueryClient, fileId: string, updated: DriveNode): void {
  for (const [folderId, list] of listings(queryClient)) {
    if (list.some((node) => node.id === fileId)) {
      queryClient.setQueryData<DriveNode[]>(
        childrenKey(folderId),
        list.map((node) => (node.id === fileId ? updated : node)),
      );
    }
  }
}

/** Removes a deleted node from every cached folder listing that contains it. */
export function removeChild(queryClient: QueryClient, fileId: string): void {
  for (const [folderId, list] of listings(queryClient)) {
    if (list.some((node) => node.id === fileId)) {
      queryClient.setQueryData<DriveNode[]>(
        childrenKey(folderId),
        list.filter((node) => node.id !== fileId),
      );
    }
  }
}

/**
 * Moves `node` between cached listings: out of every listing that holds it, into `toFolderId`'s
 * when that one is loaded (otherwise it shows once the folder is opened).
 */
export function moveChild(queryClient: QueryClient, node: DriveNode, toFolderId: string): void {
  removeChild(queryClient, node.id);
  addChild(queryClient, toFolderId, node);
}

export interface FolderEntry {
  id: string;
  name: string;
  /** `null` for the root folder. */
  parentId: string | null;
}

/** Every folder the app knows: the root, the vault index (when fetched) and loaded listings. */
export function knownFolders(queryClient: QueryClient): Map<string, FolderEntry> {
  const folders = new Map<string, FolderEntry>();
  const index = queryClient.getQueryData<VaultIndex>(VAULT_INDEX_KEY);
  for (const folder of index?.folders ?? []) {
    folders.set(folder.id, { id: folder.id, name: folder.name, parentId: folder.parentId });
  }
  for (const [folderId, list] of listings(queryClient)) {
    for (const node of list) {
      if (node.kind === "folder") {
        folders.set(node.id, { id: node.id, name: node.name, parentId: folderId });
      }
    }
  }
  const root = queryClient.getQueryData<DriveNode>(["root"]);
  if (root !== undefined) {
    folders.set(root.id, { id: root.id, name: root.name, parentId: null });
  }
  return folders;
}

/** The folder holding `id`, from loaded listings or else the vault index. */
export function knownParentId(queryClient: QueryClient, id: string): string | undefined {
  for (const [folderId, list] of listings(queryClient)) {
    if (list.some((node) => node.id === id)) {
      return folderId;
    }
  }
  const index = queryClient.getQueryData<VaultIndex>(VAULT_INDEX_KEY);
  return (
    index?.files.find((file) => file.id === id)?.parentId ??
    index?.folders.find((folder) => folder.id === id)?.parentId
  );
}

/** Folder ids from `id` up to the root (inclusive), or `null` when the chain leaves the vault. */
function chainToRoot(
  folders: ReadonlyMap<string, FolderEntry>,
  rootId: string,
  id: string,
): string[] | null {
  const chain: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    if (chain.includes(current)) {
      return null;
    }
    chain.push(current);
    if (current === rootId) {
      return chain;
    }
    current = folders.get(current)?.parentId ?? null;
  }
  return null;
}

export interface MoveItem {
  id: string;
  kind: DriveNode["kind"];
  /** The folder holding the item now, when known. */
  parentId?: string;
}

/** Whether `item` may move into `targetId`: not its current folder, nor itself or a subfolder. */
export function canMoveInto(
  folders: ReadonlyMap<string, FolderEntry>,
  rootId: string,
  item: MoveItem,
  targetId: string,
): boolean {
  if (targetId === item.parentId || targetId === item.id) {
    return false;
  }
  const chain = chainToRoot(folders, rootId, targetId);
  if (chain === null) {
    return false;
  }
  return item.kind !== "folder" || !chain.includes(item.id);
}

export interface MoveTarget {
  id: string;
  name: string;
  /** Readable path from the root, e.g. `Notes / Projects / 2026`. */
  path: string;
}

/** Every folder `item` can move into, with readable paths, sorted by path. */
export function moveTargets(
  folders: ReadonlyMap<string, FolderEntry>,
  rootId: string,
  item: MoveItem,
): MoveTarget[] {
  const out: MoveTarget[] = [];
  for (const folder of folders.values()) {
    if (!canMoveInto(folders, rootId, item, folder.id)) {
      continue;
    }
    const chain = chainToRoot(folders, rootId, folder.id) ?? [];
    const path = chain
      .reverse()
      .map((id) => folders.get(id)?.name ?? "")
      .join(" / ");
    out.push({ id: folder.id, name: folder.name, path });
  }
  const collator = new Intl.Collator("en", { sensitivity: "accent", numeric: true });
  return out.sort(
    (a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : 0) || collator.compare(a.path, b.path),
  );
}

/** Names currently cached in a folder's listing, or an empty list if not loaded yet. */
export function getFolderChildNames(queryClient: QueryClient, folderId: string): string[] {
  const list = queryClient.getQueryData<DriveNode[]>(childrenKey(folderId));
  return list === undefined ? [] : list.map((node) => node.name);
}

/** Collects `folderId` plus all cached descendant folder and file ids under it. */
export function collectDescendantIds(
  queryClient: QueryClient,
  folderId: string,
): { folderIds: string[]; fileIds: string[] } {
  const folderIds: string[] = [];
  const fileIds: string[] = [];
  const visitedFolders = new Set<string>();
  const seenFiles = new Set<string>();

  const walk = (id: string) => {
    if (visitedFolders.has(id)) {
      return;
    }
    visitedFolders.add(id);
    folderIds.push(id);
    const children = queryClient.getQueryData<DriveNode[]>(childrenKey(id));
    if (!children) {
      return;
    }
    for (const child of children) {
      if (child.kind === "folder") {
        walk(child.id);
      } else if (!seenFiles.has(child.id)) {
        seenFiles.add(child.id);
        fileIds.push(child.id);
      }
    }
  };

  walk(folderId);
  return { folderIds, fileIds };
}

export interface IndexedNote {
  node: DriveNode;
  folderId: string;
  path: string[];
}

export interface IndexedFolder {
  node: DriveNode;
  path: string[];
}

/** Collects every Markdown note and subfolder currently cached in the tree, with folder paths. */
export function collectIndexedTree(queryClient: QueryClient): {
  notes: IndexedNote[];
  folders: IndexedFolder[];
} {
  const root = queryClient.getQueryData<DriveNode>(["root"]);
  const byFolder = new Map<string, DriveNode[]>();
  for (const [folderId, list] of listings(queryClient)) {
    byFolder.set(folderId, list);
  }

  const notes: IndexedNote[] = [];
  const folders: IndexedFolder[] = [];
  const seenFiles = new Set<string>();
  const visitedFolders = new Set<string>();

  const walk = (folderId: string, path: string[]) => {
    if (visitedFolders.has(folderId)) {
      return;
    }
    visitedFolders.add(folderId);
    const children = byFolder.get(folderId);
    if (!children) {
      return;
    }
    for (const child of children) {
      if (child.kind === "folder") {
        const nextPath = [...path, child.name];
        folders.push({ node: child, path });
        walk(child.id, nextPath);
      } else if (child.kind === "markdown" && !seenFiles.has(child.id)) {
        seenFiles.add(child.id);
        notes.push({ node: child, folderId, path });
      }
    }
  };

  if (root) {
    walk(root.id, []);
  }
  for (const [folderId, children] of byFolder) {
    if (visitedFolders.has(folderId)) {
      continue;
    }
    for (const child of children) {
      if (child.kind === "markdown" && !seenFiles.has(child.id)) {
        seenFiles.add(child.id);
        notes.push({ node: child, folderId, path: [] });
      }
    }
  }

  return { notes, folders };
}

/** Finds a Markdown file in a specific cached folder by case-insensitive name. */
export function findNoteByNameInFolder(
  queryClient: QueryClient,
  folderId: string,
  name: string,
): DriveNode | undefined {
  const list = queryClient.getQueryData<DriveNode[]>(childrenKey(folderId));
  if (!list) {
    return undefined;
  }
  const target = name.toLowerCase();
  return list.find((node) => node.kind === "markdown" && node.name.toLowerCase() === target);
}

/** Reactive lookup of a node's name across cached tree listings. */
export function useNodeName(id: string): string | undefined {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const getSnapshot = useCallback(() => findNode(queryClient, id)?.name, [queryClient, id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
