// Use case of `POST /api/folders/{id}/files` (port of Rust `create::create_signed_in`): validate
// the id and body, check the folder is live and the name is free, then one Drive v2 multipart
// insert. The new note's `ETag` goes out through `ResponseSink`.

import * as Effect from "effect/Effect";

import { decodeCreateBody, nameProblem, rustTrim } from "../domain/create.ts";
import { isLiveFolder, isValidId, MAX_FILE_BYTES, type Node } from "../domain/drive.ts";
import { utf8 } from "../domain/encoding.ts";
import {
  invalidName,
  invalidRequest,
  nameExists,
  notFound,
  tooLarge,
  type InvalidRequest,
  type NameExists,
  type TooLarge,
} from "../domain/errors.ts";
import {
  getFile,
  insertMarkdown,
  listChildren,
  type DriveFailure,
  type DriveR,
} from "../infrastructure/drive-client.ts";
import { ResponseSink } from "./ports.ts";

export type CreateFailure = DriveFailure | InvalidRequest | NameExists | TooLarge;

/** Creates a Markdown note in `folderId` (the raw path id) from the raw request `body`. */
export const createFile = (
  accessToken: string,
  folderId: string,
  body: Uint8Array,
): Effect.Effect<Node, CreateFailure, DriveR> =>
  Effect.gen(function* () {
    if (!isValidId(folderId)) return yield* Effect.fail(notFound());
    const parsed = decodeCreateBody(body);
    if (parsed === undefined) {
      return yield* Effect.fail(invalidRequest('The request body must be JSON with a "name".'));
    }
    const name = rustTrim(parsed.name);
    const problem = nameProblem(name);
    if (problem !== undefined) return yield* Effect.fail(invalidName(problem));
    const content = utf8(parsed.content);
    if (content.length > MAX_FILE_BYTES) return yield* Effect.fail(tooLarge());

    const folder = yield* getFile(accessToken, folderId);
    if (!isLiveFolder(folder)) return yield* Effect.fail(notFound());
    const children = yield* listChildren(accessToken, folderId);
    if (children.some((c) => c.name === name)) {
      return yield* Effect.fail(nameExists("A file with this name already exists in this folder."));
    }
    const created = yield* insertMarkdown(accessToken, folderId, name, content);
    (yield* ResponseSink).setHeader("etag", created.etag);
    return created.node;
  });
