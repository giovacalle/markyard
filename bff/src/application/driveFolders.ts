// The Drive folder picker: browse the folders of the signed-in account's whole Drive (not only
// the vault) and create one, so the account can choose its vault root. `root` is My Drive.

import * as Effect from "effect/Effect";

import { isLiveFolder, isValidId, toNode, type Node } from "../domain/drive.ts";
import {
  invalidName,
  invalidRequest,
  nameExists,
  notFound,
  type InvalidRequest,
  type NameExists,
} from "../domain/errors.ts";
import { folderNameProblem, rustTrim } from "../domain/folders.ts";
import { parseJson } from "../domain/session.ts";
import {
  createFolder,
  getFile,
  listChildFolders,
  listChildren,
  type DriveFailure,
  type DriveR,
} from "../infrastructure/drive-client.ts";

export const MY_DRIVE = "root";
const MY_DRIVE_NAME = "My Drive";
const BAD_BODY = 'The request body must be JSON with a "name" and an optional "parentId".';
const NAME_TAKEN = "An item with this name already exists in this folder.";

export interface FolderListing {
  readonly parent: { readonly id: string; readonly name: string };
  readonly folders: ReadonlyArray<Node>;
}

/** The `{id, name}` of a picker parent: My Drive as is, any other id a live folder (else 404). */
const pickerParent = (
  token: string,
  id: string,
): Effect.Effect<{ id: string; name: string }, DriveFailure, DriveR> =>
  Effect.gen(function* () {
    if (id === MY_DRIVE) return { id: MY_DRIVE, name: MY_DRIVE_NAME };
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const folder = yield* getFile(token, id);
    return isLiveFolder(folder)
      ? { id: folder.id, name: folder.name }
      : yield* Effect.fail(notFound());
  });

const byName = (a: Node, b: Node): number => {
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/** `GET /api/drive/folders?parentId=`: the live subfolders of a folder, by name (case-insensitive). */
export const listDriveFolders = (
  token: string,
  rawParentId: string | null,
): Effect.Effect<FolderListing, DriveFailure, DriveR> =>
  Effect.gen(function* () {
    const parent = yield* pickerParent(
      token,
      rawParentId === null || rawParentId === "" ? MY_DRIVE : rawParentId,
    );
    const files = yield* listChildFolders(token, parent.id);
    return { parent, folders: files.filter(isLiveFolder).map(toNode).sort(byName) };
  });

const decodeBody = (bytes: Uint8Array): { parentId: string; name: string } | undefined => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const json = parseJson(text);
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const { name, parentId } = json as Record<string, unknown>;
  if (typeof name !== "string") return undefined;
  if (parentId !== undefined && parentId !== null && typeof parentId !== "string") return undefined;
  return { name, parentId: typeof parentId === "string" && parentId !== "" ? parentId : MY_DRIVE };
};

/** `POST /api/drive/folders`: create a folder in My Drive or a live folder of the account. */
export const createDriveFolder = (
  token: string,
  body: Uint8Array,
): Effect.Effect<Node, DriveFailure | InvalidRequest | NameExists, DriveR> =>
  Effect.gen(function* () {
    const input = decodeBody(body);
    if (input === undefined) return yield* Effect.fail(invalidRequest(BAD_BODY));
    const name = rustTrim(input.name);
    const problem = folderNameProblem(name);
    if (problem !== undefined) return yield* Effect.fail(invalidName(problem));
    const parent = yield* pickerParent(token, input.parentId);
    const siblings = yield* listChildren(token, parent.id);
    if (siblings.some((c) => c.name === name)) return yield* Effect.fail(nameExists(NAME_TAKEN));
    return yield* createFolder(token, parent.id, name);
  });
