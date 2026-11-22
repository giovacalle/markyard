// Folder use cases (port of Rust `core/src/folders.rs`). Each one runs after the session check,
// with the access token, the raw path id and, for body routes, the raw request body.

import * as Effect from "effect/Effect";

import { isLiveFolder, isValidId, parentId, toNode, type Node } from "../domain/drive.ts";
import {
  invalidMove,
  invalidName,
  invalidRequest,
  nameExists,
  notFound,
  type InvalidRequest,
  type NameExists,
} from "../domain/errors.ts";
import { decodeFolderNameBody, folderNameProblem, rustTrim } from "../domain/folders.ts";
import { decodePatchBody } from "../domain/move.ts";
import {
  createFolder,
  getFile,
  listChildren,
  trashFile,
  updateFolder,
  type DriveFailure,
  type DriveR,
} from "../infrastructure/drive-client.ts";
import { badMoveBody, checkDestinationId, planMove, ROOT_MOVE } from "./move.ts";

type FolderEffect<A, E = DriveFailure> = Effect.Effect<A, E, DriveR>;
type WriteFailure = DriveFailure | InvalidRequest | NameExists;

const BAD_BODY = 'The request body must be JSON with a "name".';
const NAME_TAKEN = "An item with this name already exists in this folder.";

/** The trimmed, valid folder name of a request, or its 400. */
const validFolderName = (raw: string): Effect.Effect<string, InvalidRequest> => {
  const name = rustTrim(raw);
  const problem = folderNameProblem(name);
  return problem === undefined ? Effect.succeed(name) : Effect.fail(invalidName(problem));
};

/** The trimmed, valid folder name of a `{"name"}` request body, or its 400. */
const folderName = (body: Uint8Array): Effect.Effect<string, InvalidRequest> => {
  const raw = decodeFolderNameBody(body);
  return raw === undefined ? Effect.fail(invalidRequest(BAD_BODY)) : validFolderName(raw);
};

/** The folder `id`, or 404 when Drive has it but it is not a live folder. */
const liveFolder = (token: string, id: string) =>
  Effect.flatMap(getFile(token, id), (file) =>
    isLiveFolder(file) ? Effect.succeed(file) : Effect.fail(notFound()),
  );

/** `GET /api/root`: the account's vault root folder as a node, whatever it is. */
export const root = (token: string, rootFolderId: string): FolderEffect<Node> =>
  Effect.map(getFile(token, rootFolderId), toNode);

/** `GET /api/folders/{id}/children`: every live child of a folder, in Drive's order. */
export const children = (token: string, id: string): FolderEffect<{ nodes: Array<Node> }> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    // Drive may answer 200 with an empty list for an unknown or non-folder parent, so check it first.
    yield* liveFolder(token, id);
    const files = yield* listChildren(token, id);
    return { nodes: files.map(toNode) };
  });

/** `POST /api/folders/{id}/folders`: create a subfolder inside a folder. */
export const create = (
  token: string,
  parentFolderId: string,
  body: Uint8Array,
): FolderEffect<Node, WriteFailure> =>
  Effect.gen(function* () {
    if (!isValidId(parentFolderId)) return yield* Effect.fail(notFound());
    const name = yield* folderName(body);
    yield* liveFolder(token, parentFolderId);
    const siblings = yield* listChildren(token, parentFolderId);
    if (siblings.some((c) => c.name === name)) return yield* Effect.fail(nameExists(NAME_TAKEN));
    return yield* createFolder(token, parentFolderId, name);
  });

/**
 * `PATCH /api/folders/{id}`: rename and/or move a folder. A body without a `parentId` is a
 * rename, decoded as it always was.
 */
export const update = (
  token: string,
  rootFolderId: string,
  id: string,
  body: Uint8Array,
): FolderEffect<Node, WriteFailure> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const patch = decodePatchBody(body);
    if (patch.kind === "rename") return yield* rename(token, rootFolderId, id, body);
    if (id === rootFolderId) return yield* Effect.fail(invalidMove(ROOT_MOVE));
    if (patch.kind === "invalid") return yield* badMoveBody();
    yield* checkDestinationId(patch.parentId);
    const name = patch.name === undefined ? undefined : yield* validFolderName(patch.name);
    const folder = yield* liveFolder(token, id);
    const change = yield* planMove(token, rootFolderId, folder, patch.parentId, name);
    return change === undefined ? toNode(folder) : yield* updateFolder(token, id, change);
  });

/** A rename-only `PATCH /api/folders/{id}` (`{"name"}`): rename a folder in place. */
const rename = (
  token: string,
  rootFolderId: string,
  id: string,
  body: Uint8Array,
): FolderEffect<Node, WriteFailure> =>
  Effect.gen(function* () {
    if (id === rootFolderId) {
      return yield* Effect.fail(invalidRequest("The root folder cannot be renamed."));
    }
    const name = yield* folderName(body);
    const folder = yield* liveFolder(token, id);
    if (folder.name === name) return toNode(folder);
    const parent = parentId(folder);
    if (parent !== undefined && isValidId(parent)) {
      const siblings = yield* listChildren(token, parent);
      if (siblings.some((c) => c.id !== id && c.name === name)) {
        return yield* Effect.fail(nameExists(NAME_TAKEN));
      }
    }
    return yield* updateFolder(token, id, { name });
  });

/** `DELETE /api/folders/{id}`: move a folder (and its contents) to the Drive trash. */
export const remove = (
  token: string,
  rootFolderId: string,
  id: string,
): FolderEffect<void, DriveFailure | InvalidRequest> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    if (id === rootFolderId) {
      return yield* Effect.fail(invalidRequest("The root folder cannot be deleted."));
    }
    yield* liveFolder(token, id);
    yield* trashFile(token, id);
  });
