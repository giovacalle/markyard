// Image attachment rules that need no I/O: the strict image MIME allowlist, the upload size cap,
// the name of the attachments folder, the file name an upload is stored under, and the decoding
// of the Drive v3 answers the attachment routes read.

import { asciiLower } from "./drive.ts";
import { utf8 } from "./encoding.ts";

/** The only image types the BFF stores or serves inline. SVG and HTML can carry scripts. */
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type ImageMime = (typeof IMAGE_MIMES)[number];

/** Upload and inline-serving cap of an image attachment: 10 MiB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The folder directly under the root folder that holds every attachment. */
export const ATTACHMENTS_FOLDER = "_attachments";

/** Longest stem (without the extension) of a stored attachment name, in code points. */
export const MAX_STEM_CHARS = 100;

/**
 * The allowlisted image type of a `Content-Type` value or a Drive `mimeType`: its essence,
 * trimmed and lower-cased, with any parameters (`; charset=...`) dropped. `undefined` when the
 * type is missing or not on the allowlist.
 */
export const imageMimeOf = (contentType: string | null | undefined): ImageMime | undefined => {
  if (contentType === null || contentType === undefined) return undefined;
  const essence = asciiLower((contentType.split(";")[0] ?? "").trim());
  return IMAGE_MIMES.find((mime) => mime === essence);
};

/** The extensions accepted for each type; the first one is appended when a name has none. */
const EXTENSIONS: Readonly<Record<ImageMime, ReadonlyArray<string>>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
};

/** Image extensions a name may carry that do not match its type; they are replaced. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "webp",
  "gif",
  "svg",
  "svgz",
  "bmp",
  "ico",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
]);

/** Path and shell-hostile punctuation never kept in a stored name. */
const UNSAFE_PUNCTUATION = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);

/**
 * Whether a character is never kept in a stored name: a control character (Unicode Cc), unsafe
 * punctuation, or a bidi control that could disguise the extension.
 */
const isUnsafe = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    UNSAFE_PUNCTUATION.has(ch)
  );
};

const stripUnsafe = (text: string): string =>
  Array.from(text)
    .filter((ch) => !isUnsafe(ch))
    .join("");

/** A header value percent-decoded when it is valid percent-encoded UTF-8, else as sent. */
const decodeHeader = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** `20261121-103000` for a Unix time in seconds (UTC). */
const stamp = (nowSeconds: number): string => {
  const iso = new Date(nowSeconds * 1000).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
};

/**
 * The name an upload is stored under, from its optional `X-Filename` header: the last path
 * segment, without unsafe characters, its stem capped at `MAX_STEM_CHARS`, ending in an
 * extension that matches `mime`. A name with nothing usable left is `image-<UTC stamp>.<ext>`.
 */
export const attachmentName = (
  header: string | null,
  mime: ImageMime,
  nowSeconds: number,
): string => {
  const accepted = EXTENSIONS[mime];
  const segments = (header === null ? "" : decodeHeader(header)).split(/[/\\]/);
  const cleaned = stripUnsafe(segments[segments.length - 1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let stem = cleaned;
  let extension = accepted[0] ?? "img";
  const dot = cleaned.lastIndexOf(".");
  if (dot >= 0) {
    const current = asciiLower(cleaned.slice(dot + 1));
    if (accepted.includes(current)) {
      stem = cleaned.slice(0, dot);
      extension = current;
    } else if (IMAGE_EXTENSIONS.has(current)) {
      stem = cleaned.slice(0, dot);
    }
  }
  stem = Array.from(stem.replace(/^[.\s]+/, ""))
    .slice(0, MAX_STEM_CHARS)
    .join("")
    .replace(/[.\s]+$/, "");
  return `${stem === "" ? `image-${stamp(nowSeconds)}` : stem}.${extension}`;
};

// ---------------------------------------------------------------------------
// Decoding Drive v3 JSON
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (u: unknown): u is Json =>
  typeof u === "object" && u !== null && !Array.isArray(u);
const isString = (u: unknown): u is string => typeof u === "string";

/** Drive v3 int64 fields (`size`) are decimal strings. */
const decodeSize = (u: unknown): number | undefined | null => {
  if (u === undefined || u === null) return undefined;
  if (!isString(u) || !/^[0-9]{1,15}$/.test(u)) return null;
  return Number(u);
};

/** What the blob route reads of a file before streaming it. */
export interface BlobMeta {
  readonly id: string;
  readonly mimeType: string;
  /** Bytes; `undefined` when Drive has no size for it (Google Docs, shortcuts). */
  readonly size: number | undefined;
  readonly trashed: boolean;
  readonly parents: ReadonlyArray<string>;
  /** Drive's short-lived thumbnail link, when it was asked for and Drive has one yet. */
  readonly thumbnailLink?: string;
}

export const decodeBlobMeta = (json: unknown): BlobMeta | undefined => {
  if (!isObject(json)) return undefined;
  const { id, mimeType } = json;
  if (!isString(id) || !isString(mimeType)) return undefined;
  const size = decodeSize(json["size"]);
  const trashed = json["trashed"] ?? false;
  const parents = json["parents"] ?? [];
  if (size === null || typeof trashed !== "boolean") return undefined;
  if (!Array.isArray(parents) || !parents.every(isString)) return undefined;
  const thumbnailLink = json["thumbnailLink"];
  return isString(thumbnailLink) && thumbnailLink !== ""
    ? { id, mimeType, size, trashed, parents, thumbnailLink }
    : { id, mimeType, size, trashed, parents };
};

/** Longest edge of a thumbnail when the request names none, in pixels. */
export const DEFAULT_THUMB_SIZE = 400;
export const MIN_THUMB_SIZE = 32;
export const MAX_THUMB_SIZE = 1600;

/**
 * The `size` query of `GET /api/files/{id}/thumb`: absent is the default, a decimal integer is
 * clamped into `[MIN_THUMB_SIZE, MAX_THUMB_SIZE]`, anything else is `undefined` (a 400).
 */
export const thumbSizeOf = (raw: string | null): number | undefined => {
  if (raw === null) return DEFAULT_THUMB_SIZE;
  if (!/^[0-9]{1,5}$/.test(raw)) return undefined;
  return Math.min(MAX_THUMB_SIZE, Math.max(MIN_THUMB_SIZE, Number(raw)));
};

/** The only hosts Drive thumbnails are fetched from; the access token goes nowhere else. */
const THUMB_HOST_SUFFIX = ".googleusercontent.com";

/**
 * The URL to fetch Drive's thumbnail at `size` pixels: its `=s220` suffix rewritten to
 * `=s{size}`. `undefined` unless the link is https on a `*.googleusercontent.com` host (the
 * request carries the user's access token) and ends in that suffix.
 */
export const thumbnailUrl = (link: string, size: number): string | undefined => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(THUMB_HOST_SUFFIX)) return undefined;
  if (url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  if (url.search !== "" || url.hash !== "" || !/=s[0-9]+$/.test(url.pathname)) return undefined;
  url.pathname = url.pathname.replace(/=s[0-9]+$/, `=s${size}`);
  return url.href;
};

/** The answer of `POST /api/attachments`. Key order is the wire order. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: ImageMime;
  readonly size: number;
  readonly url: string;
}

/** Where the web app loads an attachment from. */
export const blobUrl = (id: string): string => `/api/files/${id}/blob`;

/** The `files.create` answer of an upload: its id, and its name and size when Drive sent them. */
export interface CreatedBlob {
  readonly id: string;
  readonly name: string | undefined;
  readonly size: number | undefined;
}

export const decodeCreatedBlob = (json: unknown): CreatedBlob | undefined => {
  if (!isObject(json) || !isString(json["id"])) return undefined;
  const name = json["name"];
  const size = decodeSize(json["size"]);
  if (size === null || (name !== undefined && !isString(name))) return undefined;
  return { id: json["id"], name, size };
};

/** One image of `GET /api/attachments` or `GET /api/attachments/{id}`. Key order is the wire order. */
export interface AttachmentItem {
  readonly id: string;
  readonly name: string;
  readonly mimeType: ImageMime;
  /** Bytes; absent when Drive sent no valid size. */
  readonly size?: number;
  readonly modifiedTime: string;
  /** When the file was uploaded to Drive; absent when Drive sent none. */
  readonly createdTime?: string;
  readonly url: string;
  /** Direct tags stored in Drive `appProperties`; absent when the image has none. */
  readonly tags?: ReadonlyArray<string>;
}

/**
 * Drive `appProperties` key prefix for direct attachment tags.
 * Drive restricts property keys to `[a-zA-Z0-9.!@$%^&*()-_/]` (no `:`, spaces, or non-ASCII).
 */
export const ATTACHMENT_TAG_PREFIX = "tag_";

/** Drive v3 cap on `appProperties` entries per app per file. */
export const MAX_ATTACHMENT_TAGS = 30;

/** Drive v3 cap on a single `appProperties` entry: `utf8(key).length + utf8(value).length`. */
export const MAX_APP_PROPERTY_BYTES = 124;

const compareTags = (a: string, b: string): number => {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

const isSafeKeyByte = (byte: number): boolean =>
  (byte >= 0x61 && byte <= 0x7a) || // a-z
  (byte >= 0x30 && byte <= 0x39) || // 0-9
  byte === 0x2d || // -
  byte === 0x2e || // .
  byte === 0x5f; // _

/**
 * Bijective, Drive-legal `appProperties` key for one tag (case-insensitive identity): keeps
 * `[a-z0-9._-]` literal and percent-encodes every other UTF-8 byte (`%XX`), staying strictly
 * inside Drive's allowed key charset `[a-zA-Z0-9.!@$%^&*()-_/]`.
 */
export const attachmentTagKey = (tag: string): string => {
  const bytes = utf8(tag.toLowerCase());
  let out = ATTACHMENT_TAG_PREFIX;
  for (const byte of bytes) {
    out += isSafeKeyByte(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

/** Control characters and Unicode format characters (zero-width, bidi overrides). */
const DISALLOWED_TAG_CHARS = /[\p{Cc}\p{Cf}]/u;

const hasDisallowedTagChar = (text: string): boolean => DISALLOWED_TAG_CHARS.test(text);

/** Cleans a raw tag string idempotently: strips leading `#`/whitespace, collapses whitespace, trims. */
export const normalizeAttachmentTag = (raw: string): string =>
  raw
    .replace(/^[#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

/** Counts non-tag `appProperties` keys that count toward Drive's 30-key private property cap. */
export const nonTagAppPropertyCount = (current: Readonly<Record<string, string>>): number => {
  let count = 0;
  for (const key of Object.keys(current)) {
    if (!key.startsWith(ATTACHMENT_TAG_PREFIX)) count += 1;
  }
  return count;
};

/**
 * Validates and deduplicates a `tags` list for `PATCH /api/attachments/{id}/tags`. Returns
 * `{ ok: true, tags }` (deterministically sorted) or `{ ok: false, message }` for a 400.
 */
export const validateAttachmentTags = (
  raw: unknown,
):
  | { readonly ok: true; readonly tags: Array<string> }
  | { readonly ok: false; readonly message: string } => {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "tags must be an array of strings." };
  }
  const byKey = new Map<string, string>();
  for (const entry of raw) {
    if (!isString(entry)) {
      return { ok: false, message: "tags must be an array of strings." };
    }
    if (hasDisallowedTagChar(entry)) {
      return { ok: false, message: "Tags cannot contain control or invisible format characters." };
    }
    const cleaned = normalizeAttachmentTag(entry);
    if (cleaned === "") continue;
    const key = attachmentTagKey(cleaned);
    if (utf8(key).length + utf8(cleaned).length > MAX_APP_PROPERTY_BYTES) {
      return { ok: false, message: `Tag “${cleaned}” is too long for Google Drive metadata.` };
    }
    if (!byKey.has(key)) {
      byKey.set(key, cleaned);
    }
  }
  if (byKey.size > MAX_ATTACHMENT_TAGS) {
    return { ok: false, message: `An image can have at most ${MAX_ATTACHMENT_TAGS} tags.` };
  }
  return { ok: true, tags: [...byKey.values()].sort(compareTags) };
};

/** Decodes `{ tags: string[] }` from raw UTF-8 JSON bytes for `PATCH /api/attachments/{id}/tags`. */
export const decodeUpdateTagsBody = (
  bytes: Uint8Array,
):
  | { readonly ok: true; readonly tags: Array<string> }
  | { readonly ok: false; readonly message: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }
  if (!isObject(parsed)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  return validateAttachmentTags(parsed["tags"]);
};

/** Extracts direct `tag:*` entries from a Drive `appProperties` map, deterministically sorted. */
export const decodeAttachmentTags = (raw: unknown): Array<string> => {
  if (!isObject(raw)) return [];
  const byKey = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith(ATTACHMENT_TAG_PREFIX) || !isString(value)) continue;
    const cleaned = normalizeAttachmentTag(value);
    if (cleaned === "" || hasDisallowedTagChar(cleaned)) continue;
    const canonical = attachmentTagKey(cleaned);
    if (!byKey.has(canonical)) byKey.set(canonical, cleaned);
  }
  return [...byKey.values()].sort(compareTags);
};

/**
 * Builds the Drive v3 `appProperties` merge patch that replaces every existing `tag:*` entry with
 * `nextTags`, setting removed keys to `null` while leaving unrelated keys untouched. Returns
 * `undefined` when Drive already holds the exact same `tag:*` entries.
 */
export const diffTagAppProperties = (
  current: Readonly<Record<string, string>>,
  nextTags: ReadonlyArray<string>,
): Record<string, string | null> | undefined => {
  const desired = new Map<string, string>();
  for (const tag of nextTags) desired.set(attachmentTagKey(tag), tag);

  const patch: Record<string, string | null> = {};
  let changed = false;

  for (const [key, value] of Object.entries(current)) {
    if (!key.startsWith(ATTACHMENT_TAG_PREFIX)) continue;
    const target = desired.get(key);
    if (target === undefined) {
      patch[key] = null;
      changed = true;
    } else if (target !== value) {
      patch[key] = target;
      changed = true;
    }
  }
  for (const [key, value] of desired) {
    if (current[key] !== value) {
      patch[key] = value;
      changed = true;
    }
  }
  return changed ? patch : undefined;
};

/** Drive v3 metadata for one image attachment, including parents and raw `appProperties`. */
export interface AttachmentMeta extends BlobMeta {
  readonly name: string;
  readonly modifiedTime: string;
  readonly createdTime?: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

const decodeAppProperties = (raw: unknown): Record<string, string> => {
  if (!isObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isString(v)) out[k] = v;
  }
  return out;
};

export const decodeAttachmentMeta = (json: unknown): AttachmentMeta | undefined => {
  const blob = decodeBlobMeta(json);
  if (blob === undefined || !isObject(json)) return undefined;
  const { name, modifiedTime, createdTime } = json;
  if (!isString(name) || !isString(modifiedTime)) return undefined;
  return {
    ...blob,
    name,
    modifiedTime,
    ...(isString(createdTime) ? { createdTime } : {}),
    appProperties: decodeAppProperties(json["appProperties"]),
  };
};

/** Converts verified Drive attachment metadata into the wire `AttachmentItem`. */
export const toAttachmentItem = (meta: AttachmentMeta, mimeType: ImageMime): AttachmentItem => {
  const tags = decodeAttachmentTags(meta.appProperties);
  return {
    id: meta.id,
    name: meta.name,
    mimeType,
    ...(meta.size === undefined ? {} : { size: meta.size }),
    modifiedTime: meta.modifiedTime,
    ...(meta.createdTime === undefined ? {} : { createdTime: meta.createdTime }),
    url: blobUrl(meta.id),
    ...(tags.length === 0 ? {} : { tags }),
  };
};

/** A half-open `[from, before)` window on `createdTime`, as normalized RFC 3339 UTC instants. */
export interface UploadedRange {
  readonly from?: string;
  readonly before?: string;
}

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * `raw` as a normalized `YYYY-MM-DDTHH:MM:SS.sssZ` instant, or `undefined` when it is not a UTC
 * RFC 3339 instant. The result only ever holds digits, `-`, `:`, `.`, `T` and `Z`, so it is safe
 * to splice into a Drive `q`.
 */
export const utcInstant = (raw: string): string | undefined => {
  if (!UTC_INSTANT.test(raw)) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

/**
 * The allowlisted images of a `files.list` page of the attachments folder, in Drive's order.
 * Trashed files and other types are left out; an invalid `size` is dropped, not fatal.
 */
export const decodeAttachmentPage = (
  json: unknown,
):
  | { readonly items: Array<AttachmentItem>; readonly nextPageToken: string | undefined }
  | undefined => {
  if (!isObject(json)) return undefined;
  const files = json["files"] ?? [];
  const token = json["nextPageToken"] ?? undefined;
  if (!Array.isArray(files) || (token !== undefined && !isString(token))) return undefined;
  const items: Array<AttachmentItem> = [];
  for (const file of files) {
    if (!isObject(file)) return undefined;
    const { id, name, mimeType, modifiedTime, createdTime } = file;
    if (!isString(id) || !isString(name) || !isString(mimeType) || !isString(modifiedTime))
      return undefined;
    const image = imageMimeOf(mimeType);
    if (image === undefined || file["trashed"] === true) continue;
    const size = decodeSize(file["size"]);
    const tags = decodeAttachmentTags(file["appProperties"]);
    items.push({
      id,
      name,
      mimeType: image,
      ...(size === undefined || size === null ? {} : { size }),
      modifiedTime,
      ...(isString(createdTime) ? { createdTime } : {}),
      url: blobUrl(id),
      ...(tags.length === 0 ? {} : { tags }),
    });
  }
  return { items, nextPageToken: token };
};

const timeOf = (item: AttachmentItem): number => {
  const ms = Date.parse(item.modifiedTime);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** Newest `modifiedTime` first; ties by name, then id, so the order never depends on Drive's. */
export const newestAttachmentsFirst = (
  items: ReadonlyArray<AttachmentItem>,
): Array<AttachmentItem> =>
  [...items].sort(
    (a, b) =>
      timeOf(b) - timeOf(a) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
