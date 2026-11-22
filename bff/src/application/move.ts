// What moving a file or a folder has to check before Drive is asked: the destination is a live
// folder inside the root folder, a folder never lands inside itself, and no sibling in the
// destination already has the item's (new) name.

import * as Effect from "effect/Effect";

import { isLiveFolder, isValidId, parentId, type DriveFile } from "../domain/drive.ts";
import {
  invalidMove,
  invalidRequest,
  nameExists,
  notFound,
  type InvalidRequest,
  type NameExists,
} from "../domain/errors.ts";
import {
  getFile,
  listChildren,
  type DriveFailure,
  type DriveR,
  type FileUpdate,
} from "../infrastructure/drive-client.ts";

/** How many folders a destination may sit below the root folder. */
export const MAX_MOVE_DEPTH = 64;

export const BAD_MOVE_BODY = 'The request body must be JSON with a "name", a "parentId", or both.';
export const CYCLE = "Cannot move a folder into itself or one of its subfolders.";
export const ROOT_MOVE = "The root folder cannot be moved.";
const NAME_TAKEN = "An item with this name already exists in this folder.";

export type MoveFailure = DriveFailure | InvalidRequest | NameExists;

/** The body of a move that is not `{"parentId": "<string>", "name"?: "<string>"}`. */
export const badMoveBody = (): Effect.Effect<never, InvalidRequest> =>
  Effect.fail(invalidRequest(BAD_MOVE_BODY));

/** A destination id that cannot be a Drive id is a folder that does not exist. */
export const checkDestinationId = (id: string): Effect.Effect<void, DriveFailure> =>
  isValidId(id) ? Effect.void : Effect.fail(notFound());

/**
 * The folder ids from `folderId` up to and including the root folder, or 404 when `folderId` is
 * not a live folder inside it. Also the subtree check of the blob route.
 */
export const pathToRoot = (
  token: string,
  rootFolderId: string,
  folderId: string,
): Effect.Effect<ReadonlyArray<string>, DriveFailure, DriveR> =>
  Effect.gen(function* () {
    const path: Array<string> = [];
    let current: string | undefined = folderId;
    while (
      current !== undefined &&
      isValidId(current) &&
      !path.includes(current) &&
      path.length <= MAX_MOVE_DEPTH
    ) {
      path.push(current);
      if (current === rootFolderId) return path;
      const folder = yield* getFile(token, current);
      if (!isLiveFolder(folder)) break;
      current = parentId(folder);
    }
    return yield* Effect.fail(notFound());
  });

/**
 * The Drive update that moves `item` into `destination` (renamed to `name` when given), or
 * `undefined` when it is already there under that name.
 */
export const planMove = (
  token: string,
  rootFolderId: string,
  item: DriveFile,
  destination: string,
  name: string | undefined,
): Effect.Effect<FileUpdate | undefined, MoveFailure, DriveR> =>
  Effect.gen(function* () {
    const path = yield* pathToRoot(token, rootFolderId, destination);
    if (path.includes(item.id)) return yield* Effect.fail(invalidMove(CYCLE));
    const finalName = name ?? item.name;
    const inPlace = item.parents.includes(destination);
    if (inPlace && finalName === item.name) return undefined;
    const siblings = yield* listChildren(token, destination);
    if (siblings.some((c) => c.id !== item.id && c.name === finalName)) {
      return yield* Effect.fail(nameExists(NAME_TAKEN));
    }
    return {
      name: finalName === item.name ? undefined : finalName,
      parents: inPlace ? undefined : { add: destination, remove: item.parents.join(",") },
    };
  });
