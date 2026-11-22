// File use cases (port of Rust `core/src/files.rs`): read and save a file's bytes, rename a
// Markdown file, move a file to the trash. Each one runs after `signedIn` gave the access token.

import * as Effect from "effect/Effect";

import {
  MAX_FILE_BYTES,
  isEtagShaped,
  isHeaderValue,
  isLiveFile,
  isReadableBlob,
  isValidId,
  parentId,
  toNode,
  type Node,
} from "../domain/drive.ts";
import {
  driveUnreachable,
  invalidName,
  invalidRequest,
  nameExists,
  notFound,
  preconditionRequired,
  tooLarge,
  type Conflict,
  type InvalidRequest,
  type NameExists,
  type NotFound,
  type PreconditionRequired,
  type TooLarge,
} from "../domain/errors.ts";
import { decodeRenameBody, nameProblem, parseU64, rustTrim } from "../domain/files.ts";
import { decodePatchBody } from "../domain/move.ts";
import * as Drive from "../infrastructure/drive-client.ts";
import { badMoveBody, checkDestinationId, planMove } from "./move.ts";
import { ResponseSink } from "./ports.ts";

type DriveEffect<A, E = Drive.DriveFailure> = Effect.Effect<A, E, Drive.DriveR>;

/** What `GET /api/files/{id}/content` answers: Drive's raw body stream and the v2 etag. */
export interface FileContent {
  readonly etag: string;
  /** Drive's `alt=media` body, unread (ADR 0003 constraint 1). */
  readonly body: ReadableStream<Uint8Array> | null;
}

/** `GET /api/files/{id}/content`: metadata first (type, size cap, etag), then the media stream. */
export const readContent = (
  accessToken: string,
  id: string,
): DriveEffect<FileContent, Drive.DriveFailure | NotFound | TooLarge> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const rev = yield* Drive.getRevision(accessToken, id);
    if (!isReadableBlob(rev)) return yield* Effect.fail(notFound());
    const size = parseU64(rev.fileSize);
    if (size === undefined) return yield* Effect.fail(driveUnreachable());
    if (size > BigInt(MAX_FILE_BYTES)) return yield* Effect.fail(tooLarge());
    if (!isHeaderValue(rev.etag)) return yield* Effect.fail(driveUnreachable());
    const res = yield* Drive.download(accessToken, id);
    return { etag: rev.etag, body: res.body };
  });

/** The body of a save: a raw stream with its declared `Content-Length`, or a stream without one. */
export interface SaveBody {
  readonly stream: ReadableStream<Uint8Array> | null;
  readonly contentLength: number | undefined;
}

/**
 * Reads at most `max + 1` bytes of `stream`: the bytes, or `undefined` when there are more than
 * `max` (the rest is cancelled).
 */
export const readAtMost = (
  stream: ReadableStream<Uint8Array>,
  max: number,
): Effect.Effect<Uint8Array | undefined> =>
  Effect.promise(async () => {
    const reader = stream.getReader();
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  });

/**
 * `PUT /api/files/{id}/content`: the conditional Drive v2 media upload; returns the new etag.
 * A body with a `Content-Length` is streamed through untouched; one without (chunked) is read
 * into memory up to the cap, since Drive needs a length and Rust accepted any body.
 */
export const saveContent = (
  accessToken: string,
  id: string,
  ifMatchHeader: string | null,
  body: SaveBody,
): DriveEffect<
  string,
  Drive.DriveFailure | NotFound | PreconditionRequired | TooLarge | Conflict
> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const ifMatch = ifMatchHeader?.trim();
    if (ifMatch === undefined || !isEtagShaped(ifMatch))
      return yield* Effect.fail(preconditionRequired());
    let upload: Drive.UploadBody;
    if (body.contentLength !== undefined) {
      if (body.contentLength > MAX_FILE_BYTES) return yield* Effect.fail(tooLarge());
      upload =
        body.stream === null
          ? new Uint8Array(0)
          : { stream: body.stream, length: body.contentLength };
    } else {
      const bytes =
        body.stream === null ? new Uint8Array(0) : yield* readAtMost(body.stream, MAX_FILE_BYTES);
      if (bytes === undefined) return yield* Effect.fail(tooLarge());
      upload = bytes;
    }
    return yield* Drive.upload(accessToken, id, ifMatch, upload);
  });

type UpdateFailure = Drive.DriveFailure | NotFound | InvalidRequest | NameExists;

/** The trimmed, valid Markdown file name of a request, or its 400. */
const fileName = (rawName: string): Effect.Effect<string, InvalidRequest> => {
  const name = rustTrim(rawName);
  const problem = nameProblem(name);
  return problem === undefined ? Effect.succeed(name) : Effect.fail(invalidName(problem));
};

/** Applies a Drive update to a Markdown file; its new etag goes out as `ETag`. */
const applyUpdate = (
  accessToken: string,
  id: string,
  update: Drive.FileUpdate,
): DriveEffect<Node> =>
  Effect.gen(function* () {
    const { node, etag } = yield* Drive.updateMarkdown(accessToken, id, update);
    (yield* ResponseSink).setHeader("etag", etag);
    return node;
  });

/**
 * `PATCH /api/files/{id}`: rename and/or move a live Markdown file; the new etag goes out as
 * `ETag`. A body without a `parentId` is a rename, decoded as it always was.
 */
export const updateFile = (
  accessToken: string,
  rootFolderId: string,
  id: string,
  rawBody: Uint8Array,
): DriveEffect<Node, UpdateFailure> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const body = decodePatchBody(rawBody);
    if (body.kind === "rename") return yield* renameFile(accessToken, id, rawBody);
    if (body.kind === "invalid") return yield* badMoveBody();
    yield* checkDestinationId(body.parentId);
    const name = body.name === undefined ? undefined : yield* fileName(body.name);
    const file = yield* Drive.getFile(accessToken, id);
    if (!isLiveFile(file)) return yield* Effect.fail(notFound());
    const update = yield* planMove(accessToken, rootFolderId, file, body.parentId, name);
    return update === undefined ? toNode(file) : yield* applyUpdate(accessToken, id, update);
  });

/** A rename-only `PATCH /api/files/{id}` (`{"name"}`), as Rust `files::rename` answered it. */
const renameFile = (
  accessToken: string,
  id: string,
  rawBody: Uint8Array,
): DriveEffect<Node, UpdateFailure> =>
  Effect.gen(function* () {
    const rawName = decodeRenameBody(rawBody);
    if (rawName === undefined)
      return yield* Effect.fail(invalidRequest('The request body must be JSON with a "name".'));
    const name = yield* fileName(rawName);
    const file = yield* Drive.getFile(accessToken, id);
    if (!isLiveFile(file)) return yield* Effect.fail(notFound());
    if (file.name === name) return toNode(file);
    const parent = parentId(file);
    if (parent !== undefined && isValidId(parent)) {
      const children = yield* Drive.listChildren(accessToken, parent);
      if (children.some((c) => c.id !== id && c.name === name))
        return yield* Effect.fail(
          nameExists("A file with this name already exists in this folder."),
        );
    }
    return yield* applyUpdate(accessToken, id, { name });
  });

/** `DELETE /api/files/{id}`: move a live file (never a folder) to the Drive trash. */
export const trashFile = (
  accessToken: string,
  id: string,
): DriveEffect<void, Drive.DriveFailure | NotFound> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const file = yield* Drive.getFile(accessToken, id);
    if (!isLiveFile(file)) return yield* Effect.fail(notFound());
    yield* Drive.trashFile(accessToken, id);
  });
