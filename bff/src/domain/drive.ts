// Drive rules that need no I/O: id and etag shapes, query escaping, how a Drive file becomes a
// node, and the serde-equivalent decoding of the Drive JSON the BFF reads.

export const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";
/** File size cap from ADR 0001 (10 MB decimal), enforced on both downloads and uploads. */
export const MAX_FILE_BYTES = 10_000_000;

export type Kind = "folder" | "markdown" | "other";

/** What the web app sees of a Drive file or folder. Key order is the wire order. */
export interface Node {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  readonly modifiedTime: string;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modifiedTime: string;
  readonly trashed: boolean;
  readonly parents: ReadonlyArray<string>;
}

export interface DriveRevision {
  readonly etag: string;
  readonly fileSize: string | undefined;
  readonly mimeType: string;
  readonly trashed: boolean;
}

export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export const kindOf = (file: Pick<DriveFile, "name" | "mimeType">): Kind => {
  if (file.mimeType === FOLDER_MIME) return "folder";
  if (asciiLower(file.name).endsWith(".md") && !file.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
    return "markdown";
  }
  return "other";
};

export const toNode = (
  file: Pick<DriveFile, "id" | "name" | "mimeType" | "modifiedTime">,
): Node => ({
  id: file.id,
  name: file.name,
  kind: kindOf(file),
  modifiedTime: file.modifiedTime,
});

export const parentId = (file: DriveFile): string | undefined => file.parents[0];

/** A folder that is not in the trash: the only kind of file whose children can be listed. */
export const isLiveFolder = (file: DriveFile): boolean =>
  file.mimeType === FOLDER_MIME && !file.trashed;

/** A non-trashed blob file (excludes folders, shortcuts, and Google Docs/Sheets/Slides). */
export const isLiveFile = (file: DriveFile): boolean =>
  !file.trashed && file.mimeType !== FOLDER_MIME && !file.mimeType.startsWith(GOOGLE_NATIVE_PREFIX);

/** A non-trashed blob file (excludes folders, shortcuts, and Google Docs/Sheets/Slides). */
export const isReadableBlob = (rev: DriveRevision): boolean =>
  !rev.trashed && !rev.mimeType.startsWith(GOOGLE_NATIVE_PREFIX);

/** Drive ids are letters, digits, `_` and `-`; anything else never reaches a Drive query. */
export const isValidId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);

/** A single strong quoted Drive v2 etag (`"<chars>"`); rejects `*`, weak tags, lists, and garbage. */
export const isEtagShaped = (tag: string): boolean => /^"[A-Za-z0-9+/=_-]{1,200}"$/.test(tag);

/** Unicode general category Cc, which Rust `char::is_control` tests. */
const isControl = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/** Escapes a string literal for Drive v3 `q` clauses (`'` and `\`), stripping control chars. */
export const escapeQueryLiteral = (input: string): string => {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (isControl(code)) out += " ";
    else if (ch === "\\" || ch === "'") out += `\\${ch}`;
    else out += ch;
  }
  return out;
};

/**
 * The raw (still percent-encoded) `{id}` of `prefix{id}suffix` in a request path, as the Rust
 * router saw it. Handlers check this value with `isValidId`, so `a%41` stays invalid instead of
 * being decoded to a valid id.
 */
export const rawPathId = (url: string, prefix: string, suffix = ""): string | undefined => {
  const path = url.startsWith("/") ? url.split("?")[0]! : new URL(url).pathname;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  return rest.endsWith(suffix) ? rest.slice(0, rest.length - suffix.length) : undefined;
};

/** Whether `value` is a header value Rust `HeaderValue::from_str` and Web `Headers` both accept. */
export const isHeaderValue = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f || c > 0xff) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Decoding Drive JSON with serde's rules (`#[serde(default)]` only covers a missing key).
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (u: unknown): u is Json =>
  typeof u === "object" && u !== null && !Array.isArray(u);
const isString = (u: unknown): u is string => typeof u === "string";

const withDefault = <T>(
  obj: Json,
  key: string,
  guard: (u: unknown) => u is T,
  fallback: T,
): T | null => {
  if (!(key in obj)) return fallback;
  const v = obj[key];
  return guard(v) ? v : null;
};

const isBool = (u: unknown): u is boolean => typeof u === "boolean";
const isStringArray = (u: unknown): u is Array<string> => Array.isArray(u) && u.every(isString);

export const decodeDriveFile = (json: unknown): DriveFile | undefined => {
  if (!isObject(json)) return undefined;
  const { id, name, mimeType, modifiedTime } = json;
  if (!isString(id) || !isString(name) || !isString(mimeType) || !isString(modifiedTime))
    return undefined;
  const trashed = withDefault(json, "trashed", isBool, false);
  const parents = withDefault(json, "parents", isStringArray, []);
  if (trashed === null || parents === null) return undefined;
  return { id, name, mimeType, modifiedTime, trashed, parents };
};

export const decodeDriveRevision = (json: unknown): DriveRevision | undefined => {
  if (!isObject(json)) return undefined;
  const { etag, mimeType } = json;
  if (!isString(etag) || !isString(mimeType)) return undefined;
  const fileSize = json["fileSize"];
  if (fileSize !== undefined && fileSize !== null && !isString(fileSize)) return undefined;
  const labels = withDefault(json, "labels", isObject, {});
  if (labels === null) return undefined;
  const trashed = withDefault(labels, "trashed", isBool, false);
  if (trashed === null) return undefined;
  return { etag, fileSize: fileSize ?? undefined, mimeType, trashed };
};

export interface FileList {
  readonly files: ReadonlyArray<DriveFile>;
  readonly nextPageToken: string | undefined;
}

export const decodeFileList = (json: unknown): FileList | undefined => {
  if (!isObject(json)) return undefined;
  const raw = withDefault(json, "files", Array.isArray, []);
  if (raw === null) return undefined;
  const files: Array<DriveFile> = [];
  for (const item of raw) {
    const file = decodeDriveFile(item);
    if (file === undefined) return undefined;
    files.push(file);
  }
  const token = json["nextPageToken"];
  if (token !== undefined && token !== null && !isString(token)) return undefined;
  return { files, nextPageToken: token ?? undefined };
};

/** A Drive v2 answer carrying the fields of `files.patch` / `files.insert` the BFF asks for. */
export interface DriveV2File {
  readonly node: Node;
  readonly etag: string;
}

export const decodeDriveV2File = (json: unknown): DriveV2File | undefined => {
  if (!isObject(json)) return undefined;
  const { id, title, mimeType, modifiedDate, etag } = json;
  if (
    !isString(id) ||
    !isString(title) ||
    !isString(mimeType) ||
    !isString(modifiedDate) ||
    !isString(etag)
  ) {
    return undefined;
  }
  return { node: toNode({ id, name: title, mimeType, modifiedTime: modifiedDate }), etag };
};

/** A change page token as Drive issues them; anything else never reaches a Drive query. */
export const isPageToken = (token: string): boolean => /^[A-Za-z0-9._~-]{1,512}$/.test(token);

export const decodeStartPageToken = (json: unknown): string | undefined =>
  isObject(json) && isString(json["startPageToken"]) && isPageToken(json["startPageToken"])
    ? json["startPageToken"]
    : undefined;

/** One entry of Drive v3 `changes.list` about a file (drive-level changes have no `fileId`). */
export interface DriveChange {
  readonly fileId: string;
  readonly removed: boolean;
  readonly time: string;
  readonly file: DriveFile | undefined;
}

/** A `changes.list` page: `nextPageToken` while more pages follow, `newStartPageToken` on the last. */
export interface ChangePage {
  readonly changes: ReadonlyArray<DriveChange>;
  readonly next: { readonly more: boolean; readonly token: string };
}

const optionalPageToken = (json: Json, key: string): string | undefined | null => {
  const token = json[key];
  if (token === undefined || token === null) return undefined;
  return isString(token) && isPageToken(token) ? token : null;
};

const decodeChange = (json: unknown): DriveChange | undefined | null => {
  if (!isObject(json)) return null;
  if (json["fileId"] === undefined) return undefined;
  const { fileId } = json;
  const removed = withDefault(json, "removed", isBool, false);
  const time = withDefault(json, "time", isString, "");
  if (!isString(fileId) || removed === null || time === null) return null;
  if (json["file"] === undefined) return { fileId, removed, time, file: undefined };
  const file = decodeDriveFile(json["file"]);
  return file === undefined ? null : { fileId, removed, time, file };
};

export const decodeChangePage = (json: unknown): ChangePage | undefined => {
  if (!isObject(json)) return undefined;
  const raw = withDefault(json, "changes", Array.isArray, []);
  const nextPage = optionalPageToken(json, "nextPageToken");
  const newStart = optionalPageToken(json, "newStartPageToken");
  if (raw === null || nextPage === null || newStart === null) return undefined;
  const changes: Array<DriveChange> = [];
  for (const item of raw) {
    const change = decodeChange(item);
    if (change === null) return undefined;
    if (change !== undefined) changes.push(change);
  }
  if (nextPage !== undefined) return { changes, next: { more: true, token: nextPage } };
  if (newStart !== undefined) return { changes, next: { more: false, token: newStart } };
  return undefined;
};

/** What the web app sees of one change. Key order is the wire order; `node` only for live items. */
export interface Change {
  readonly fileId: string;
  readonly removed: boolean;
  readonly time: string;
  readonly node?: Node;
  readonly parentIds: ReadonlyArray<string>;
}

/** A trashed file is reported as removed, so the web app drops it like a deleted one. */
export const toChange = ({ fileId, removed, time, file }: DriveChange): Change =>
  removed || file === undefined || file.trashed
    ? { fileId, removed: true, time, parentIds: file?.parents ?? [] }
    : { fileId, removed: false, time, node: toNode(file), parentIds: file.parents };

export const decodeEtag = (json: unknown): string | undefined =>
  isObject(json) && isString(json["etag"]) ? json["etag"] : undefined;

/** Whether a Drive error body says the request was rate-limited. */
export const isRateLimitBody = (json: unknown): boolean => {
  if (!isObject(json) || !isObject(json["error"])) return false;
  const errors = withDefault(json["error"], "errors", Array.isArray, []);
  if (errors === null) return false;
  let limited = false;
  for (const item of errors) {
    if (!isObject(item)) return false;
    const reason = withDefault(item, "reason", isString, "");
    if (reason === null) return false;
    if (reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") limited = true;
  }
  return limited;
};
