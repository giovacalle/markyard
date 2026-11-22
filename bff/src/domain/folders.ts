// Folder rules that need no I/O (port of the pure parts of Rust `core/src/folders.rs`): the
// `{"name"}` request body as serde decoded it, Rust `str::trim`, and the folder name checks.

/** Drive accepts longer titles, but common file systems stop at 255 bytes. */
const MAX_FOLDER_NAME_BYTES = 255;

/** Rust `char::is_whitespace` (Unicode `White_Space`). JS `trim` differs on U+0085 and U+FEFF. */
const isRustWhitespace = (code: number): boolean =>
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x20 ||
  code === 0x85 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000;

/** Rust `str::trim`. */
export const rustTrim = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && isRustWhitespace(s.charCodeAt(start))) start++;
  while (end > start && isRustWhitespace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
};

/** Why `name` (already trimmed) cannot be a folder's name, if it cannot. */
export const folderNameProblem = (name: string): string | undefined => {
  if (name === "") return "Enter a folder name.";
  if (name === "." || name === "..") return "Choose a different folder name.";
  if (name.includes("/")) return 'A folder name cannot contain "/".';
  if (new TextEncoder().encode(name).length > MAX_FOLDER_NAME_BYTES) {
    return "A folder name can be at most 255 bytes long.";
  }
  return undefined;
};

/** serde_json rejects `\uD800`-style escapes that leave a surrogate unpaired. */
const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

const skipWs = (text: string, i: number): number => {
  while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  return i;
};

/** The index just past the JSON string literal starting at `i` (text already validated). */
const endOfString = (text: string, i: number): number => {
  for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
  return i + 1;
};

/** The index just past the JSON value starting at `i` (text already validated). */
const endOfValue = (text: string, i: number): number => {
  if (text[i] === '"') return endOfString(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') i = endOfString(text, i) - 1;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return i;
  }
  while (i < text.length && !",}] \t\n\r".includes(text[i]!)) i++;
  return i;
};

/** How many times the top-level object of valid JSON `text` has the key `key`. */
const topLevelKeyCount = (text: string, key: string): number => {
  let i = skipWs(text, 0);
  if (text[i] !== "{") return 0;
  let count = 0;
  i = skipWs(text, i + 1);
  while (text[i] === '"') {
    const end = endOfString(text, i);
    if ((JSON.parse(text.slice(i, end)) as string) === key) count++;
    i = skipWs(text, end);
    i = skipWs(text, i + 1); // past `:`
    i = skipWs(text, endOfValue(text, i));
    if (text[i] === ",") i = skipWs(text, i + 1);
  }
  return count;
};

/**
 * The `name` of a `{"name": "<string>"}` body as serde_json decoded Rust `FolderNameBody`:
 * UTF-8 JSON, an object with exactly one string `name` (other keys ignored) or a one-element
 * array, no unpaired surrogate escapes. `undefined` means 400 `invalid_request`.
 */
export const decodeFolderNameBody = (bytes: Uint8Array): string | undefined => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  let name: unknown;
  if (Array.isArray(json)) {
    if (json.length !== 1) return undefined;
    name = json[0];
  } else if (typeof json === "object" && json !== null) {
    if (topLevelKeyCount(text, "name") !== 1) return undefined;
    name = (json as Record<string, unknown>)["name"];
  } else {
    return undefined;
  }
  return typeof name === "string" && !hasLoneSurrogate(name) ? name : undefined;
};
