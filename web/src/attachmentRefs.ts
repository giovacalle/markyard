import type { VaultDocument } from "./vaultDocuments";

// Markdown references to Drive attachments (`/api/files/<id>/blob`, see `uploadAttachment`).

/** One attachment an open note embeds as an image, deduplicated by file id. */
export interface AttachmentRef {
  id: string;
  /** Alt text of the first occurrence. */
  alt: string;
  /** How many times the note embeds it. */
  count: number;
}

/** The same-origin URL an attachment is served from. */
export function attachmentUrl(id: string): string {
  return `/api/files/${encodeURIComponent(id)}/blob`;
}

/**
 * A small preview of an attachment, `size` pixels on its longest edge: Drive's thumbnail through
 * the BFF (a few KB), or the original while Drive has none yet. GIFs come back as a still frame.
 */
export function attachmentThumbUrl(id: string, size: number): string {
  return `/api/files/${encodeURIComponent(id)}/thumb?size=${size}`;
}

const ID = String.raw`([^\s/?#)>"'\\]+)`;
const TITLE = String.raw`(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?`;
/** `![alt](/api/files/<id>/blob "title")`; group 1: alt, group 2: id. */
const IMAGE = new RegExp(
  String.raw`!\[((?:\\.|[^\\\]\n])*)\]\([ \t]*<?/api/files/${ID}/blob>?${TITLE}[ \t]*\)`,
  "g",
);
/** Any reference to a blob URL (images, links, bare URLs); group 1: id. */
const BLOB_URL = new RegExp(String.raw`/api/files/${ID}/blob\b`, "g");

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** A line left with only a list, task or quote marker. */
const EMPTY_BLOCK = /^[ \t]*(?:(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?|>)?[ \t]*$/;
/** Characters that attach to the previous word, so no space goes before them. */
const CLOSING_PUNCTUATION = /^[.,;:!?)\]]/;

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Splits `text` into lines that keep their own line ending. */
function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

function lineBody(line: string): { body: string; ending: string } {
  const ending = /\r?\n$/.exec(line)?.[0] ?? "";
  return { body: line.slice(0, line.length - ending.length), ending };
}

/** Each line outside fenced code, with inline code spans blanked out (same length). */
function* proseLines(lines: readonly string[]): Generator<{ index: number; masked: string }> {
  let fence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const { body } = lineBody(line);
    const marker = FENCE.exec(body)?.[1];
    if (fence === null && marker !== undefined) {
      fence = marker;
    } else if (fence !== null) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    } else {
      yield { index, masked: body.replace(/`+[^`\n]*`+/g, (span) => " ".repeat(span.length)) };
    }
  }
}

/** Attachments `markdown` embeds as images, in first-occurrence order. */
export function extractAttachmentRefs(markdown: string): AttachmentRef[] {
  const byId = new Map<string, AttachmentRef>();
  for (const { masked } of proseLines(splitLines(markdown))) {
    for (const match of masked.matchAll(IMAGE)) {
      const id = decodeId(match[2]);
      const ref = byId.get(id);
      if (ref === undefined) {
        byId.set(id, { id, alt: match[1].replace(/\\(.)/g, "$1"), count: 1 });
      } else {
        ref.count += 1;
      }
    }
  }
  return [...byId.values()];
}

/** Joins the text around a removed image, without leaving doubled or dangling spaces. */
function joinAround(left: string, right: string): string {
  const head = left.replace(/[ \t]+$/, "");
  const tail = right.replace(/^[ \t]+/, "");
  if (tail.length === 0) {
    return head;
  }
  if (head.trim().length === 0) {
    return left + tail;
  }
  return CLOSING_PUNCTUATION.test(tail) ? head + tail : `${head} ${tail}`;
}

/**
 * `markdown` without its image references to attachment `id`. A line left empty is dropped with
 * the blank line it would leave doubled; other text, code blocks and other images stay as is.
 */
export function removeAttachmentRefs(markdown: string, id: string): string {
  const lines = splitLines(markdown);
  const replaced = new Map<number, string | null>();
  for (const { index, masked } of proseLines(lines)) {
    const matches = [...masked.matchAll(IMAGE)].filter((match) => decodeId(match[2]) === id);
    if (matches.length === 0) {
      continue;
    }
    const { body, ending } = lineBody(lines[index]);
    let next = body;
    for (const match of matches.reverse()) {
      const start = match.index;
      next = joinAround(next.slice(0, start), next.slice(start + match[0].length));
    }
    replaced.set(index, EMPTY_BLOCK.test(next) ? null : next + ending);
  }
  if (replaced.size === 0) {
    return markdown;
  }

  const out: string[] = [];
  const isBlank = (line: string | undefined) => line !== undefined && line.trim().length === 0;
  let afterDrop = false;
  for (const [index, line] of lines.entries()) {
    const next = replaced.has(index) ? replaced.get(index) : line;
    if (next === null || next === undefined) {
      afterDrop = true;
      continue;
    }
    if (afterDrop && isBlank(next) && (out.length === 0 || isBlank(out.at(-1)))) {
      continue;
    }
    afterDrop = false;
    out.push(next);
  }
  if (afterDrop) {
    while (isBlank(out.at(-1))) {
      out.pop();
    }
    const last = out.at(-1);
    if (last !== undefined && !markdown.endsWith("\n")) {
      out[out.length - 1] = lineBody(last).body;
    }
  }
  return out.join("");
}

/** Every attachment id `text` references through a blob URL, in first-occurrence order. */
export function attachmentIdsIn(text: string): Set<string> {
  const ids = new Set<string>();
  if (!text.includes("/api/files/")) {
    return ids;
  }
  for (const match of text.matchAll(BLOB_URL)) {
    ids.add(decodeId(match[1]));
  }
  return ids;
}

/** For each referenced attachment id, the cached notes that reference it (in `docs` order). */
export function attachmentUsage(docs: readonly VaultDocument[]): Map<string, VaultDocument[]> {
  const usage = new Map<string, VaultDocument[]>();
  for (const doc of docs) {
    for (const id of attachmentIdsIn(doc.text)) {
      const notes = usage.get(id);
      if (notes === undefined) {
        usage.set(id, [doc]);
      } else {
        notes.push(doc);
      }
    }
  }
  return usage;
}
