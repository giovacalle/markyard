// Drive calls made by the BFF and the Drive error mapping (port of Rust `core/src/drive.rs`).
// Every call goes through the `Upstream` port; the Drive base URL comes from `AppConfig`.

import * as Effect from "effect/Effect";

import { rateLimited, sessionEnded } from "../application/failures.ts";
import { AppConfig, Upstream, type ResponseSink } from "../application/ports.ts";
import { bearer, readBuffered, sendBuffered, type Buffered } from "../application/upstream.ts";
import {
  decodeChangePage,
  decodeDriveFile,
  decodeDriveRevision,
  decodeDriveV2File,
  decodeEtag,
  decodeFileList,
  decodeStartPageToken,
  escapeQueryLiteral,
  FOLDER_MIME,
  isHeaderValue,
  isRateLimitBody,
  toNode,
  type ChangePage,
  type DriveFile,
  type DriveRevision,
  type Node,
} from "../domain/drive.ts";
import {
  decodeAttachmentPage,
  decodeBlobMeta,
  decodeCreatedBlob,
  type AttachmentItem,
  type BlobMeta,
  type CreatedBlob,
} from "../domain/attachments.ts";
import { concatBytes, hex, utf8 } from "../domain/encoding.ts";
import {
  conflict,
  driveUnreachable,
  notFound,
  tokenExpired,
  type Conflict,
  type NotFound,
  type RateLimited,
  type TokenExpired,
  type Unauthenticated,
  type UpstreamError,
} from "../domain/errors.ts";
import {
  decodeRevisionMeta,
  decodeRevisionPage,
  type Revision,
  type RevisionMeta,
} from "../domain/revisions.ts";
import { fixedLength, framed, streamInit } from "./streams.ts";

/** Seconds to wait when Drive rate-limits without saying for how long. */
export const DEFAULT_RETRY_AFTER = 5;

/** What a failed Drive call answers the web app with. */
export type DriveFailure = Unauthenticated | RateLimited | NotFound | UpstreamError;

/** What every Drive call needs from the request context. */
export type DriveR = AppConfig | Upstream | ResponseSink;

type DriveEffect<A, E = DriveFailure> = Effect.Effect<A, E, DriveR>;

/** Rust `str::parse::<u32>` on the trimmed header: digits with an optional `+`, at most `u32::MAX`. */
const parseU32 = (text: string): number | undefined => {
  if (!/^\+?[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return n <= 0xffff_ffff ? n : undefined;
};

export const retryAfterOf = (headers: Headers): number => {
  const raw = headers.get("retry-after");
  return (raw === null ? undefined : parseU32(raw.trim())) ?? DEFAULT_RETRY_AFTER;
};

/** Maps a non-2xx Drive answer to the BFF's failure. A 401 means the grant is gone. */
export const driveFailure = (res: Buffered): Effect.Effect<never, DriveFailure, ResponseSink> => {
  switch (res.status) {
    case 401:
      return sessionEnded;
    case 429:
      return rateLimited(retryAfterOf(res.headers));
    case 403:
      return isRateLimitBody(res.json)
        ? rateLimited(retryAfterOf(res.headers))
        : Effect.fail(driveUnreachable());
    case 404:
      return Effect.fail(notFound());
    default:
      return Effect.fail(driveUnreachable());
  }
};

const driveBase: Effect.Effect<string, never, AppConfig> = Effect.gen(function* () {
  return (yield* AppConfig).google.drive;
});

/** Sends one request to Drive; a transport failure is a 502. */
const send = (request: Request): Effect.Effect<Buffered, UpstreamError, Upstream> =>
  sendBuffered(request).pipe(Effect.mapError(driveUnreachable));

/** Sends one request and decodes its 2xx JSON body; anything else is mapped by `driveFailure`. */
const call = <A>(request: Request, decode: (json: unknown) => A | undefined): DriveEffect<A> =>
  Effect.gen(function* () {
    const res = yield* send(request);
    if (!res.ok) return yield* driveFailure(res);
    const value = decode(res.json);
    return value === undefined ? yield* Effect.fail(driveUnreachable()) : value;
  });

const bearerGet = (url: string, accessToken: string): Request =>
  new Request(url, { headers: { authorization: bearer(accessToken) } });

const jsonRequest = (method: string, url: string, accessToken: string, body: unknown): Request =>
  new Request(url, {
    method,
    headers: { authorization: bearer(accessToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A non-empty etag that is a valid header value, as Rust `HeaderValue::from_str` checks it. */
const usableEtag = (etag: string): DriveEffect<string> =>
  etag !== "" && isHeaderValue(etag) ? Effect.succeed(etag) : Effect.fail(driveUnreachable());

/** Drive v2 `files.get` for a file's revision etag, size, type, and trashed state. */
export const getRevision = (accessToken: string, id: string): DriveEffect<DriveRevision> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      bearerGet(
        `${base}/drive/v2/files/${id}?fields=etag,fileSize,mimeType,labels/trashed`,
        accessToken,
      ),
      decodeDriveRevision,
    ),
  );

/**
 * Drive v3 `alt=media`: the 2xx `Response` with its body unread, so the caller can pass the raw
 * Web stream through (ADR 0003 constraint 1). A non-2xx answer is buffered and mapped.
 */
export const download = (accessToken: string, id: string): DriveEffect<Response> =>
  media(accessToken, `/drive/v3/files/${id}?alt=media`);

/** A Drive `alt=media` GET of `path`: the 2xx `Response` unread, anything else mapped. */
const media = (accessToken: string, path: string): DriveEffect<Response> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const upstream = yield* Upstream;
    const res = yield* upstream
      .send(bearerGet(`${base}${path}`, accessToken))
      .pipe(Effect.mapError(driveUnreachable));
    if (res.ok) return res;
    const buffered = yield* readBuffered(res).pipe(Effect.mapError(driveUnreachable));
    return yield* driveFailure(buffered);
  });

/** v3 `files.get` for what the blob route checks: type, size, trashed state, parents. */
export const getBlobMeta = (accessToken: string, id: string): DriveEffect<BlobMeta> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      bearerGet(
        `${base}/drive/v3/files/${id}?fields=id,mimeType,size,trashed,parents`,
        accessToken,
      ),
      decodeBlobMeta,
    ),
  );

/** v3 `revisions.get` `alt=media` of one revision of a file, its body unread. */
export const downloadRevision = (
  accessToken: string,
  id: string,
  revisionId: string,
): DriveEffect<Response> =>
  media(accessToken, `/drive/v3/files/${id}/revisions/${revisionId}?alt=media`);

/** v3 `revisions.get` for the id and size of one revision. */
export const getRevisionMeta = (
  accessToken: string,
  id: string,
  revisionId: string,
): DriveEffect<RevisionMeta> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      bearerGet(`${base}/drive/v3/files/${id}/revisions/${revisionId}?fields=id,size`, accessToken),
      decodeRevisionMeta,
    ),
  );

/** Pages of `revisions.list` followed at most, so a runaway history cannot pin the Worker. */
export const MAX_REVISION_PAGES = 20;

const REVISION_FIELDS =
  "nextPageToken,revisions(id,modifiedTime,size,lastModifyingUser(displayName,emailAddress),keepForever)";

/**
 * v3 `revisions.list` of a file, following `nextPageToken` for up to `MAX_REVISION_PAGES` pages
 * of 50 (Drive lists oldest first, so the newest revisions are on the last pages).
 */
export const listRevisions = (
  accessToken: string,
  id: string,
): DriveEffect<ReadonlyArray<Revision>> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const revisions: Array<Revision> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_REVISION_PAGES; page++) {
      const fields: Array<[string, string]> = [
        ["fields", REVISION_FIELDS],
        ["pageSize", "50"],
      ];
      if (pageToken !== undefined) fields.push(["pageToken", pageToken]);
      const query = new URLSearchParams(fields).toString();
      const result = yield* call(
        bearerGet(`${base}/drive/v3/files/${id}/revisions?${query}`, accessToken),
        decodeRevisionPage,
      );
      revisions.push(...result.revisions);
      if (result.nextPageToken === undefined) break;
      pageToken = result.nextPageToken;
    }
    return revisions;
  });

/** v3 `files.get` for one file or folder. */
export const getFile = (accessToken: string, id: string): DriveEffect<DriveFile> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      bearerGet(
        `${base}/drive/v3/files/${id}?fields=id,name,mimeType,modifiedTime,trashed,parents`,
        accessToken,
      ),
      decodeDriveFile,
    ),
  );

/**
 * v3 `files.list` for the live folders named `name` directly inside `parentId`, oldest first.
 * `parentId` is spliced into `q`, so callers must have checked it with `isValidId`.
 */
export const findChildFolders = (
  accessToken: string,
  parentId: string,
  name: string,
): DriveEffect<ReadonlyArray<DriveFile>> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const q = `'${parentId}' in parents and name='${escapeQueryLiteral(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const query = new URLSearchParams([
      ["q", q],
      ["pageSize", "10"],
      ["orderBy", "createdTime"],
      ["fields", "files(id,name,mimeType,modifiedTime,trashed,parents)"],
    ]).toString();
    const page = yield* call(
      bearerGet(`${base}/drive/v3/files?${query}`, accessToken),
      decodeFileList,
    );
    return page.files;
  });

/** v3 `files.create` of a subfolder inside `parentId`; returns the new node. */
export const createFolder = (
  accessToken: string,
  parentId: string,
  name: string,
): DriveEffect<Node> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      jsonRequest(
        "POST",
        `${base}/drive/v3/files?fields=id,name,mimeType,modifiedTime,trashed`,
        accessToken,
        {
          name,
          mimeType: FOLDER_MIME,
          parents: [parentId],
        },
      ),
      decodeDriveFile,
    ).pipe(Effect.map(toNode)),
  );

/** A metadata update: a new name, a new parent, or both. */
export interface FileUpdate {
  readonly name?: string | undefined;
  /** Moves the item: `add` becomes its parent, the comma-joined `remove` stop being ones. */
  readonly parents?: { readonly add: string; readonly remove: string } | undefined;
}

/** `fields=` plus the `addParents` / `removeParents` of a move, for v2 and v3 `files.update`. */
const updateQuery = (fields: string, update: FileUpdate): string => {
  const params: Array<[string, string]> = [];
  if (update.parents !== undefined) {
    params.push(["addParents", update.parents.add]);
    if (update.parents.remove !== "") params.push(["removeParents", update.parents.remove]);
  }
  return params.length === 0
    ? `fields=${fields}`
    : `fields=${fields}&${new URLSearchParams(params).toString()}`;
};

/** v3 `files.update` to rename and/or move a folder; returns the updated node. */
export const updateFolder = (
  accessToken: string,
  id: string,
  update: FileUpdate,
): DriveEffect<Node> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      jsonRequest(
        "PATCH",
        `${base}/drive/v3/files/${id}?${updateQuery("id,name,mimeType,modifiedTime,trashed,parents", update)}`,
        accessToken,
        update.name === undefined ? {} : { name: update.name },
      ),
      decodeDriveFile,
    ).pipe(Effect.map(toNode)),
  );

export interface NodeWithEtag {
  readonly node: Node;
  readonly etag: string;
}

/**
 * Drive v2 `files.patch` to rename and/or move a Markdown file; returns the updated node and its
 * new v2 etag. Renaming or moving changes the v2 etag even when the bytes are unchanged, so the
 * etag of this same answer lets later conditional saves succeed without a false 412 (a second
 * `files.get` could instead pick up the etag of someone else's edit).
 */
export const updateMarkdown = (
  accessToken: string,
  id: string,
  update: FileUpdate,
): DriveEffect<NodeWithEtag> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const updated = yield* call(
      jsonRequest(
        "PATCH",
        `${base}/drive/v2/files/${id}?${updateQuery("id,title,mimeType,modifiedDate,etag", update)}`,
        accessToken,
        update.name === undefined ? {} : { title: update.name },
      ),
      decodeDriveV2File,
    );
    return { node: updated.node, etag: yield* usableEtag(updated.etag) };
  });

/** v3 `files.update` to move a file or folder to the Drive trash. */
export const trashFile = (accessToken: string, id: string): DriveEffect<void> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      jsonRequest("PATCH", `${base}/drive/v3/files/${id}`, accessToken, { trashed: true }),
      () => true,
    ).pipe(Effect.asVoid),
  );

/** v3 `files.list` searching live non-folder files by name or full-text content. */
export const searchFiles = (
  accessToken: string,
  queryText: string,
): DriveEffect<ReadonlyArray<DriveFile>> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const escaped = escapeQueryLiteral(queryText);
    const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed=false and mimeType!='${FOLDER_MIME}'`;
    const query = new URLSearchParams([
      ["q", q],
      ["pageSize", "40"],
      ["orderBy", "modifiedTime desc"],
      ["fields", "files(id,name,mimeType,modifiedTime,trashed,parents)"],
    ]).toString();
    const page = yield* call(
      bearerGet(`${base}/drive/v3/files?${query}`, accessToken),
      decodeFileList,
    );
    return page.files;
  });

/** v3 `files.list` for query `q`, following `nextPageToken` to the end. */
const listAll = (accessToken: string, q: string): DriveEffect<ReadonlyArray<DriveFile>> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const children: Array<DriveFile> = [];
    let pageToken: string | undefined;
    for (;;) {
      const fields: Array<[string, string]> = [
        ["q", q],
        ["pageSize", "1000"],
        ["fields", "nextPageToken,files(id,name,mimeType,modifiedTime)"],
      ];
      if (pageToken !== undefined) fields.push(["pageToken", pageToken]);
      const query = new URLSearchParams(fields).toString();
      const page = yield* call(
        bearerGet(`${base}/drive/v3/files?${query}`, accessToken),
        decodeFileList,
      );
      children.push(...page.files);
      if (page.nextPageToken === undefined) return children;
      pageToken = page.nextPageToken;
    }
  });

/**
 * v3 `files.list` for the live children of a folder, following `nextPageToken` to the end.
 * `folderId` is spliced into `q`, so callers must have checked it with `isValidId`.
 */
export const listChildren = (
  accessToken: string,
  folderId: string,
): DriveEffect<ReadonlyArray<DriveFile>> =>
  listAll(accessToken, `'${folderId}' in parents and trashed=false`);

/**
 * v3 `files.list` for the live subfolders of a folder (`root` is My Drive), following
 * `nextPageToken` to the end. `folderId` is spliced into `q`: check it with `isValidId`.
 */
export const listChildFolders = (
  accessToken: string,
  folderId: string,
): DriveEffect<ReadonlyArray<DriveFile>> =>
  listAll(accessToken, `'${folderId}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`);

/**
 * v3 `files.list` for the live allowlisted images directly inside the attachments folder (with
 * their size), following `nextPageToken` to the end. `folderId` is spliced into `q`, so callers
 * must have checked it with `isValidId`.
 */
export const listAttachments = (
  accessToken: string,
  folderId: string,
): DriveEffect<ReadonlyArray<AttachmentItem>> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const q = `'${folderId}' in parents and trashed=false`;
    const items: Array<AttachmentItem> = [];
    let pageToken: string | undefined;
    for (;;) {
      const fields: Array<[string, string]> = [
        ["q", q],
        ["pageSize", "1000"],
        ["fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size,trashed)"],
      ];
      if (pageToken !== undefined) fields.push(["pageToken", pageToken]);
      const query = new URLSearchParams(fields).toString();
      const page = yield* call(
        bearerGet(`${base}/drive/v3/files?${query}`, accessToken),
        decodeAttachmentPage,
      );
      items.push(...page.items);
      if (page.nextPageToken === undefined) return items;
      pageToken = page.nextPageToken;
    }
  });

/** v3 `changes.getStartPageToken`: the token of "now" in the user's change log. */
export const getStartPageToken = (accessToken: string): DriveEffect<string> =>
  Effect.flatMap(driveBase, (base) =>
    call(
      bearerGet(`${base}/drive/v3/changes/startPageToken?fields=startPageToken`, accessToken),
      decodeStartPageToken,
    ),
  );

/**
 * One page of v3 `changes.list` from `pageToken` (checked with `isPageToken`). Drive answers an
 * expired or unknown token with 410 or 400; the other parameters are fixed, so both mean the
 * web app has to start over.
 */
export const listChanges = (
  accessToken: string,
  pageToken: string,
): DriveEffect<ChangePage, DriveFailure | TokenExpired> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const query = new URLSearchParams([
      ["pageToken", pageToken],
      ["includeRemoved", "true"],
      ["spaces", "drive"],
      ["pageSize", "100"],
      [
        "fields",
        "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,trashed,parents))",
      ],
    ]).toString();
    const res = yield* send(bearerGet(`${base}/drive/v3/changes?${query}`, accessToken));
    if (res.status === 410 || res.status === 400) return yield* Effect.fail(tokenExpired());
    if (!res.ok) return yield* driveFailure(res);
    const page = decodeChangePage(res.json);
    return page === undefined ? yield* Effect.fail(driveUnreachable()) : page;
  });

/** An upload body: bytes in memory, or a raw Web stream of a known length. */
export type UploadBody =
  | Uint8Array
  | { readonly stream: ReadableStream<Uint8Array>; readonly length: number };

/**
 * Conditional Drive v2 media upload; returns the new etag. A stream body is piped through a
 * `FixedLengthStream(length)` so Drive gets a `Content-Length` (ADR 0003 constraint 1).
 */
export const upload = (
  accessToken: string,
  id: string,
  ifMatch: string,
  body: UploadBody,
): DriveEffect<string, DriveFailure | Conflict> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const url = `${base}/upload/drive/v2/files/${id}?uploadType=media&fields=etag`;
    const headers = {
      authorization: bearer(accessToken),
      "content-type": "text/markdown",
      "if-match": ifMatch,
    };
    const request =
      body instanceof Uint8Array
        ? new Request(url, { method: "PUT", headers, body: body as BufferSource })
        : new Request(
            url,
            streamInit({ method: "PUT", headers, body: fixedLength(body.stream, body.length) }),
          );
    const res = yield* send(request);
    if (res.status === 412) return yield* Effect.fail(conflict());
    if (!res.ok) return yield* driveFailure(res);
    const etag = decodeEtag(res.json);
    return etag === undefined ? yield* Effect.fail(driveUnreachable()) : yield* usableEtag(etag);
  });

/**
 * Drive v3 multipart `files.create` of an image into `folderId`. Bytes in memory get a boundary
 * that occurs nowhere in them; a raw stream (which cannot be scanned) gets a random 128-bit one,
 * and is framed by the multipart head and tail chunk by chunk, then piped through a
 * `FixedLengthStream` of the exact total length (ADR 0003 constraint 1).
 */
export const uploadImage = (
  accessToken: string,
  folderId: string,
  name: string,
  mimeType: string,
  body: UploadBody,
): DriveEffect<CreatedBlob> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const metadata = utf8(JSON.stringify({ name, mimeType, parents: [folderId] }));
    const boundary =
      body instanceof Uint8Array
        ? boundaryFor([metadata, body])
        : `${BOUNDARY_STEM}${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
    const head = concatBytes([
      utf8(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      metadata,
      utf8(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    ]);
    const tail = utf8(`\r\n--${boundary}--\r\n`);
    const url = `${base}/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size`;
    const headers = {
      authorization: bearer(accessToken),
      "content-type": `multipart/related; boundary=${boundary}`,
    };
    const request =
      body instanceof Uint8Array
        ? new Request(url, {
            method: "POST",
            headers,
            body: concatBytes([head, body, tail]) as BufferSource,
          })
        : new Request(
            url,
            streamInit({
              method: "POST",
              headers,
              body: fixedLength(
                framed(head, body.stream, tail),
                head.length + body.length + tail.length,
              ),
            }),
          );
    return yield* call(request, decodeCreatedBlob);
  });

const BOUNDARY_STEM = "markyard-7f3c9a1e5b2d4086-";

const occursIn = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

/** A multipart boundary that occurs nowhere in `parts`: a fixed random-looking stem plus a counter. */
export const boundaryFor = (parts: ReadonlyArray<Uint8Array>): string => {
  for (let n = 0; ; n++) {
    const boundary = `${BOUNDARY_STEM}${n}`;
    const bytes = utf8(boundary);
    if (!parts.some((p) => occursIn(p, bytes))) return boundary;
  }
};

/** Drive v2 multipart `files.insert` of a Markdown file into `folderId`; returns its node and etag. */
export const insertMarkdown = (
  accessToken: string,
  folderId: string,
  name: string,
  content: Uint8Array,
): DriveEffect<NodeWithEtag> =>
  Effect.gen(function* () {
    const base = yield* driveBase;
    const metadata = utf8(
      JSON.stringify({ title: name, mimeType: "text/markdown", parents: [{ id: folderId }] }),
    );
    const boundary = boundaryFor([metadata, content]);
    const body = concatBytes([
      utf8(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      metadata,
      utf8(`\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n`),
      content,
      utf8(`\r\n--${boundary}--\r\n`),
    ]);
    const created = yield* call(
      new Request(
        `${base}/upload/drive/v2/files?uploadType=multipart&fields=id,title,mimeType,modifiedDate,etag`,
        {
          method: "POST",
          headers: {
            authorization: bearer(accessToken),
            "content-type": `multipart/related; boundary=${boundary}`,
          },
          body: body as BufferSource,
        },
      ),
      decodeDriveV2File,
    );
    return { node: created.node, etag: yield* usableEtag(created.etag) };
  });
