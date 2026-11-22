// Rules of `POST /api/folders/{id}/files` that need no I/O (port of Rust `core/src/create.rs`):
// the serde-equivalent decoding of the request body and the validation of the new note's name.

import { asciiLower } from "./drive.ts";

/** Drive accepts longer titles, but common file systems stop at 255 bytes. */
const MAX_NAME_BYTES = 255;

export interface CreateBody {
  readonly name: string;
  readonly content: string;
}

/** Rust `char::is_whitespace` (Unicode `White_Space`), which `String.prototype.trim` differs from. */
const RUST_WHITESPACE =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING = new RegExp(`^[${RUST_WHITESPACE}]+`);
const TRAILING = new RegExp(`[${RUST_WHITESPACE}]+$`);

/** Rust `str::trim`. */
export const rustTrim = (s: string): string => s.replace(LEADING, "").replace(TRAILING, "");

/** A string serde_json would have rejected: it decodes `\uD800` escapes only in valid pairs. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const isRustString = (value: unknown): value is string =>
  typeof value === "string" && !LONE_SURROGATE.test(value);

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Rust `serde_json::from_slice::<CreateBody>`: a JSON object with a string `name` and an optional
 * string `content` (unknown keys ignored), or the sequence form `[name]` / `[name, content]`.
 */
export const decodeCreateBody = (bytes: Uint8Array): CreateBody | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(utf8Strict.decode(bytes));
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 2) return undefined;
    const [name, content = ""] = value as Array<unknown>;
    return isRustString(name) && isRustString(content) ? { name, content } : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const name = fields["name"];
  const content = Object.hasOwn(fields, "content") ? fields["content"] : "";
  return isRustString(name) && isRustString(content) ? { name, content } : undefined;
};

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Why `name` (already trimmed) cannot be a new note's name, if it cannot. */
export const nameProblem = (name: string): string | undefined => {
  if (name === "") return "Enter a file name.";
  if (name.includes("/")) return 'A file name cannot contain "/".';
  if (!asciiLower(name).endsWith(".md")) {
    return "A file name must end in .md.";
  }
  if (rustTrim(name.slice(0, -3)) === "") return "Enter a file name.";
  if (utf8Length(name) > MAX_NAME_BYTES) return "A file name can be at most 255 bytes long.";
  return undefined;
};
