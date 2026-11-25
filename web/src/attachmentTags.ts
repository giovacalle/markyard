import type { AttachmentItem } from "./api";
import { extractFrontmatterTags } from "./frontmatter";
import type { VaultDocument } from "./vaultDocuments";

/** Drive `appProperties` key prefix for attachment tags (mirrors `bff/src/domain/attachments.ts`). */
export const ATTACHMENT_TAG_PREFIX = "tag_";

/** Drive v3 cap on `appProperties` entries per app per file. */
export const MAX_ATTACHMENT_TAGS = 30;

/** Drive v3 cap on one `appProperties` entry: `utf8(key).length + utf8(value).length`. */
export const MAX_APP_PROPERTY_BYTES = 124;

const encoder = new TextEncoder();

/** Control characters and Unicode format characters (zero-width, bidi overrides). */
const DISALLOWED_TAG_CHARS = /[\p{Cc}\p{Cf}]/u;

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function isSafeKeyByte(byte: number): boolean {
  return (
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f // _
  );
}

/** Drive-legal `appProperties` key for `tag` (mirrors `bff/src/domain/attachments.ts`). */
export function attachmentTagKey(tag: string): string {
  const bytes = encoder.encode(tag.toLowerCase());
  let out = ATTACHMENT_TAG_PREFIX;
  for (const byte of bytes) {
    out += isSafeKeyByte(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function hasDisallowedTagChar(text: string): boolean {
  return DISALLOWED_TAG_CHARS.test(text);
}

function compareTags(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Cleans a raw tag idempotently: strips leading `#`/whitespace, collapses whitespace, trims. */
export function normalizeAttachmentTag(raw: string): string {
  return raw
    .replace(/^[#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether `raw` is a non-empty tag that fits Google Drive's `appProperties` rules. */
export function isValidAttachmentTag(raw: string): boolean {
  if (hasDisallowedTagChar(raw)) {
    return false;
  }
  const cleaned = normalizeAttachmentTag(raw);
  if (cleaned.length === 0) {
    return false;
  }
  const key = attachmentTagKey(cleaned);
  return utf8Length(key) + utf8Length(cleaned) <= MAX_APP_PROPERTY_BYTES;
}

/** Validates adding `raw` to `existing`, returning the deduplicated sorted list or an error. */
export function addAttachmentTags(
  existing: readonly string[],
  rawTags: readonly string[],
): { ok: true; tags: string[]; changed: boolean } | { ok: false; message: string } {
  const byKey = new Map<string, string>();
  for (const tag of existing) {
    const cleaned = normalizeAttachmentTag(tag);
    if (cleaned.length > 0) {
      byKey.set(cleaned.toLowerCase(), cleaned);
    }
  }
  const beforeSize = byKey.size;

  for (const raw of rawTags) {
    if (hasDisallowedTagChar(raw)) {
      return { ok: false, message: "Tags cannot contain control or invisible format characters." };
    }
    const cleaned = normalizeAttachmentTag(raw);
    if (cleaned.length === 0) {
      continue;
    }
    const key = attachmentTagKey(cleaned);
    if (utf8Length(key) + utf8Length(cleaned) > MAX_APP_PROPERTY_BYTES) {
      return {
        ok: false,
        message: `Tag “${cleaned}” is too long for Google Drive metadata.`,
      };
    }
    const lower = cleaned.toLowerCase();
    if (!byKey.has(lower)) {
      if (byKey.size >= MAX_ATTACHMENT_TAGS) {
        return {
          ok: false,
          message: `An image can have at most ${MAX_ATTACHMENT_TAGS} tags.`,
        };
      }
      byKey.set(lower, cleaned);
    }
  }

  return {
    ok: true,
    tags: [...byKey.values()].sort(compareTags),
    changed: byKey.size !== beforeSize,
  };
}

/** Removes `tag` (case-insensitively) from `existing`. */
export function removeAttachmentTag(existing: readonly string[], tag: string): string[] {
  const target = tag.toLowerCase();
  return existing.filter((entry) => entry.toLowerCase() !== target);
}

/**
 * Matches an attachment's direct tags against `query` (case-insensitive, optional leading `#` or
 * `tag:`), ordered exact > prefix > substring. Empty needle returns all tags.
 */
export function matchAttachmentTags(tags: readonly string[] | undefined, query: string): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  const needle = query.trim().replace(/^tag:/i, "").trim().replace(/^#+/, "").toLowerCase();
  if (needle.length === 0) {
    return [...tags];
  }
  const rank = (tag: string): number => {
    const lower = tag.toLowerCase();
    if (lower === needle) return 0;
    if (lower.startsWith(needle)) return 1;
    return 2;
  };
  return tags
    .filter((tag) => tag.toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || compareTags(a, b));
}

/**
 * Whether `attachment` matches the Attachments view search input:
 * - `tag:<needle>` or `#<needle>` matches tags (empty needle requires at least one tag)
 * - plain text matches either filename or any tag (case-insensitive substring).
 */
export function matchesAttachmentSearch(
  attachment: Pick<AttachmentItem, "name" | "tags">,
  query: string,
): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const tags = attachment.tags ?? [];
  if (/^tag:/i.test(trimmed) || trimmed.startsWith("#")) {
    const needle = trimmed.replace(/^tag:/i, "").trim().replace(/^#+/, "").toLowerCase();
    if (needle.length === 0) {
      return tags.length > 0;
    }
    return tags.some((tag) => tag.toLowerCase().includes(needle));
  }
  const needle = trimmed.toLowerCase();
  if (attachment.name.toLowerCase().includes(needle)) {
    return true;
  }
  return tags.some((tag) => tag.toLowerCase().includes(needle));
}

/** Deduplicated sorted tags across all known attachments and locally cached notes. */
export function collectKnownTags(
  attachments: readonly Pick<AttachmentItem, "tags">[],
  docs: readonly VaultDocument[] | null,
): string[] {
  const byLower = new Map<string, string>();
  const add = (tag: string) => {
    const cleaned = normalizeAttachmentTag(tag);
    if (cleaned.length === 0) return;
    const lower = cleaned.toLowerCase();
    if (!byLower.has(lower)) {
      byLower.set(lower, cleaned);
    }
  };
  for (const attachment of attachments) {
    for (const tag of attachment.tags ?? []) {
      add(tag);
    }
  }
  if (docs !== null) {
    for (const doc of docs) {
      for (const tag of extractFrontmatterTags(doc.text)) {
        add(tag);
      }
    }
  }
  return [...byLower.values()].sort(compareTags);
}
