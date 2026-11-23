import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  ApiError,
  isInvalidMove,
  isNameExists,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
  moveFolder,
  type DriveNode,
  type VaultIndex,
} from "./api";
import { moveCachedChild } from "./localCache";
import { useOptionalOpsQueue } from "./opsQueue";
import { useSyncQueue } from "./syncQueue";
import { moveChild, VAULT_INDEX_KEY } from "./treeCache";

export function moveErrorMessage(error: unknown): string {
  if (isNameExists(error)) {
    return "An item with this name already exists in that folder.";
  }
  if (isInvalidMove(error)) {
    return "A folder cannot be moved into itself or one of its subfolders.";
  }
  if (isUnauthenticated(error)) {
    return "Your session has ended. Sign in again.";
  }
  if (isRateLimited(error)) {
    return "Google Drive is busy. Try again shortly.";
  }
  if (isNotFound(error)) {
    return "The item or the destination folder could not be found.";
  }
  if (error instanceof TypeError) {
    return "Unable to reach the server. Moving needs a connection.";
  }
  if (error instanceof ApiError && error.message.length > 0) {
    return error.message;
  }
  return "Unable to move. Try again.";
}

/**
 * Moves a note or folder into `targetId` on Drive, then updates every cache: the folder listings
 * (old parent out, destination in), Dexie, and the vault index. File moves go through the sync
 * queue so a save in flight and the move's new ETag never race into a false 412.
 */
export function useMoveNode(): (node: DriveNode, targetId: string) => Promise<DriveNode> {
  const queryClient = useQueryClient();
  const syncQueue = useSyncQueue();
  const opsQueue = useOptionalOpsQueue();
  return useCallback(
    async (node: DriveNode, targetId: string) => {
      if (opsQueue !== null) {
        const result = await opsQueue.moveNode({
          id: node.id,
          kind: node.kind,
          name: node.name,
          toParentId: targetId,
          node,
        });
        return result.node;
      }
      const updated =
        node.kind === "folder"
          ? await moveFolder(node.id, targetId)
          : (await syncQueue.moveFile(node.id, targetId)).node;
      moveChild(queryClient, updated, targetId);
      void moveCachedChild(updated, targetId);
      queryClient.setQueryData<VaultIndex>(VAULT_INDEX_KEY, (index) => {
        if (index === undefined) {
          return index;
        }
        const reparent = <T extends { id: string; parentId: string }>(entry: T): T =>
          entry.id === updated.id ? { ...entry, parentId: targetId } : entry;
        return { ...index, folders: index.folders.map(reparent), files: index.files.map(reparent) };
      });
      return updated;
    },
    [queryClient, syncQueue, opsQueue],
  );
}
