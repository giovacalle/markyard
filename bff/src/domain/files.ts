// File rules that need no I/O (port of the pure parts of Rust `core/src/files.rs` and
// `create::name_problem`): rename-body decoding, file-name checks, Drive size parsing.

import { asciiLower } from "./drive.ts";
import { utf8 } from "./encoding.ts";

/** Longest file name, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 255;

/** Rust `char::is_whitespace` (Unicode `White_Space`); unlike JS `trim` it has U+0085, not U+FEFF. */
const WS =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_WS = new RegExp(`^[${WS}]+`);
const TRAILING_WS = new RegExp(`[${WS}]+$`);

/** Rust `str::trim`. */
export const rustTrim = (text: string): string =>
  text.replace(LEADING_WS, "").replace(TRAILING_WS, "");

/** Rust `create::name_problem`: why `name` (already trimmed) cannot be a Markdown file name. */
export const nameProblem = (name: string): string | undefined => {
  if (name === "") return "Enter a file name.";
  if (name.includes("/")) return 'A file name cannot contain "/".';
  if (!asciiLower(name).endsWith(".md")) return "A file name must end in .md.";
  if (rustTrim(name.slice(0, -3)) === "") return "Enter a file name.";
  if (utf8(name).length > MAX_NAME_BYTES) return "A file name can be at most 255 bytes long.";
  return undefined;
};

/** A UTF-16 string with an unpaired surrogate, which serde_json refuses to decode. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * The `name` of a rename body, decoded the way serde decodes Rust `RenameBody { name: String }`:
 * strict UTF-8 JSON (no BOM), either an object with a string `name` (other keys ignored) or a
 * one-element array holding it. Anything else is `undefined`.
 */
export const decodeRenameBody = (bytes: Uint8Array): string | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return undefined;
  }
  let name: unknown;
  if (Array.isArray(json)) {
    if (json.length !== 1) return undefined;
    name = json[0];
  } else if (typeof json === "object" && json !== null) {
    name = (json as Record<string, unknown>)["name"];
  }
  return typeof name === "string" && !LONE_SURROGATE.test(name) ? name : undefined;
};

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** Rust `str::parse::<u64>`: digits with an optional `+`, at most `u64::MAX`. */
export const parseU64 = (text: string | undefined): bigint | undefined => {
  if (text === undefined || !/^\+?[0-9]+$/.test(text)) return undefined;
  const n = BigInt(text);
  return n <= U64_MAX ? n : undefined;
};

/** A `Content-Length` value: 1*DIGIT. `undefined` when missing or malformed. */
export const parseContentLength = (header: string | null): number | undefined =>
  header !== null && /^[0-9]+$/.test(header) ? Number(header) : undefined;
