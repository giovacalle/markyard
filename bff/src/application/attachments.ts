// Image attachment use cases: `GET /api/attachments` lists the stored images newest first
// (optionally only those uploaded in a time window),
// `POST /api/attachments` stores an image in the attachments folder (`_attachments` unless the
// request names another) directly under the account's vault root,
// and `GET /api/files/{id}/blob` serves an image of the root folder's subtree inline. Only the strict image allowlist ever goes in or out (no SVG, no HTML).

import * as Effect from "effect/Effect";

import {
  ATTACHMENTS_FOLDER,
  MAX_ATTACHMENT_BYTES,
  attachmentName,
  blobUrl,
  imageMimeOf,
  newestAttachmentsFirst,
  utcInstant,
  type Attachment,
  type AttachmentItem,
  type ImageMime,
  type UploadedRange,
} from "../domain/attachments.ts";
import { FOLDER_MIME, isLiveFolder, isValidId } from "../domain/drive.ts";
import {
  driveUnreachable,
  invalidRequest,
  notFound,
  tooLarge,
  type InvalidRequest,
  type TooLarge,
} from "../domain/errors.ts";
import * as Drive from "../infrastructure/drive-client.ts";
import { readAtMost, type SaveBody } from "./files.ts";
import { folderNameProblem, rustTrim } from "../domain/folders.ts";
import { pathToRoot } from "./move.ts";
import { Entropy } from "./ports.ts";

export const NOT_AN_IMAGE = "Only PNG, JPEG, WebP and GIF images are allowed.";
export const EMPTY_IMAGE = "The image is empty.";

type AttachmentFailure = Drive.DriveFailure | InvalidRequest | TooLarge;

/**
 * The attachments folder name a request asked for: `_attachments` when it named none (or a blank
 * one), else its trimmed name, or 400 when that cannot be a folder name.
 */
export const attachmentsFolderName = (
  raw: string | null | undefined,
): Effect.Effect<string, InvalidRequest> => {
  const name = rustTrim(raw ?? "");
  if (name === "") return Effect.succeed(ATTACHMENTS_FOLDER);
  const problem = folderNameProblem(name);
  return problem === undefined ? Effect.succeed(name) : Effect.fail(invalidRequest(problem));
};

export const BAD_UPLOADED_BOUND =
  "uploadedFrom and uploadedBefore must be UTC instants like 2026-11-01T00:00:00.000Z.";

/**
 * The `[uploadedFrom, uploadedBefore)` window a request asked for; an absent parameter leaves that
 * side open, anything else that is not a UTC RFC 3339 instant (even an empty one) is a 400.
 */
export const uploadedRange = (
  from: string | null,
  before: string | null,
): Effect.Effect<UploadedRange, InvalidRequest> => {
  const range: { from?: string; before?: string } = {};
  for (const [key, raw] of [
    ["from", from],
    ["before", before],
  ] as const) {
    if (raw === null) continue;
    const instant = utcInstant(raw);
    if (instant === undefined) return Effect.fail(invalidRequest(BAD_UPLOADED_BOUND));
    range[key] = instant;
  }
  return Effect.succeed(range);
};

/** Where attachments live: the vault root and the folder name directly under it. */
export interface AttachmentsLocation {
  readonly rootFolderId: string;
  readonly folderName: string;
}

/** The id of the live attachments folder directly under the vault root, if there is one. */
const findAttachmentsFolder = (
  accessToken: string,
  { rootFolderId, folderName }: AttachmentsLocation,
): Effect.Effect<string | undefined, Drive.DriveFailure, Drive.DriveR> =>
  Effect.gen(function* () {
    const found = yield* Drive.findChildFolders(accessToken, rootFolderId, folderName);
    return found.find((f) => f.name === folderName && isLiveFolder(f) && isValidId(f.id))?.id;
  });

/** The id of the live attachments folder directly under the vault root, created when missing. */
const attachmentsFolder = (
  accessToken: string,
  location: AttachmentsLocation,
): Effect.Effect<string, Drive.DriveFailure, Drive.DriveR> =>
  Effect.gen(function* () {
    const live = yield* findAttachmentsFolder(accessToken, location);
    if (live !== undefined) return live;
    const created = yield* Drive.createFolder(
      accessToken,
      location.rootFolderId,
      location.folderName,
    );
    return isValidId(created.id) ? created.id : yield* Effect.fail(driveUnreachable());
  });

/**
 * `POST /api/attachments`: checks the type and size before Drive is asked, then one multipart
 * upload into `_attachments`. A body with a `Content-Length` is streamed through untouched; one
 * without is read into memory up to the cap.
 */
export const uploadAttachment = (
  accessToken: string,
  location: AttachmentsLocation,
  contentType: string | null,
  filename: string | null,
  body: SaveBody,
): Effect.Effect<Attachment, AttachmentFailure, Drive.DriveR | Entropy> =>
  Effect.gen(function* () {
    const mimeType = imageMimeOf(contentType);
    if (mimeType === undefined) return yield* Effect.fail(invalidRequest(NOT_AN_IMAGE));
    let upload: Drive.UploadBody;
    let length: number;
    if (body.contentLength !== undefined) {
      if (body.contentLength > MAX_ATTACHMENT_BYTES) return yield* Effect.fail(tooLarge());
      if (body.contentLength === 0 || body.stream === null)
        return yield* Effect.fail(invalidRequest(EMPTY_IMAGE));
      upload = { stream: body.stream, length: body.contentLength };
      length = body.contentLength;
    } else {
      const bytes =
        body.stream === null
          ? new Uint8Array(0)
          : yield* readAtMost(body.stream, MAX_ATTACHMENT_BYTES);
      if (bytes === undefined) return yield* Effect.fail(tooLarge());
      if (bytes.length === 0) return yield* Effect.fail(invalidRequest(EMPTY_IMAGE));
      upload = bytes;
      length = bytes.length;
    }
    const name = attachmentName(filename, mimeType, yield* (yield* Entropy).nowSeconds);
    const folderId = yield* attachmentsFolder(accessToken, location);
    const created = yield* Drive.uploadImage(accessToken, folderId, name, mimeType, upload);
    if (!isValidId(created.id)) return yield* Effect.fail(driveUnreachable());
    return {
      id: created.id,
      name: created.name ?? name,
      mimeType,
      size: created.size ?? length,
      url: blobUrl(created.id),
    };
  });

/** What `GET /api/files/{id}/blob` answers: the checked image type and Drive's unread body. */
export interface ImageBlob {
  readonly mimeType: ImageMime;
  /** Drive's `alt=media` body, unread (ADR 0003 constraint 1). */
  readonly body: ReadableStream<Uint8Array> | null;
}

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

/**
 * `GET /api/files/{id}/blob`: a live file inside the root folder's subtree (404 otherwise, so
 * nothing outside it is even confirmed to exist), of an allowlisted image type (400), at most
 * 10 MiB (413); then Drive's media stream.
 */
export const readBlob = (
  accessToken: string,
  rootFolderId: string,
  id: string,
): Effect.Effect<ImageBlob, AttachmentFailure, Drive.DriveR> =>
  Effect.gen(function* () {
    if (!isValidId(id)) return yield* Effect.fail(notFound());
    const meta = yield* Drive.getBlobMeta(accessToken, id);
    if (
      meta.trashed ||
      meta.mimeType === FOLDER_MIME ||
      meta.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)
    )
      return yield* Effect.fail(notFound());
    const parent = meta.parents[0];
    if (parent === undefined) return yield* Effect.fail(notFound());
    yield* pathToRoot(accessToken, rootFolderId, parent);
    const mimeType = imageMimeOf(meta.mimeType);
    if (mimeType === undefined) return yield* Effect.fail(invalidRequest(NOT_AN_IMAGE));
    if (meta.size === undefined) return yield* Effect.fail(driveUnreachable());
    if (meta.size > MAX_ATTACHMENT_BYTES) return yield* Effect.fail(tooLarge());
    const res = yield* Drive.download(accessToken, id);
    return { mimeType, body: res.body };
  });

/** The answer of `GET /api/attachments`. */
export interface AttachmentList {
  /** `null` while no image was ever uploaded (the folder is created by the first upload). */
  readonly folderId: string | null;
  readonly attachments: ReadonlyArray<AttachmentItem>;
}

/**
 * `GET /api/attachments`: the allowlisted images in `_attachments` uploaded within `range`, newest
 * first. The folder is looked up, never created: without one the list is empty.
 */
export const listAttachments = (
  accessToken: string,
  location: AttachmentsLocation,
  range: UploadedRange = {},
): Effect.Effect<AttachmentList, Drive.DriveFailure, Drive.DriveR> =>
  Effect.gen(function* () {
    const folderId = yield* findAttachmentsFolder(accessToken, location);
    if (folderId === undefined) return { folderId: null, attachments: [] };
    const items = yield* Drive.listAttachments(accessToken, folderId, range);
    return { folderId, attachments: newestAttachmentsFirst(items) };
  });
