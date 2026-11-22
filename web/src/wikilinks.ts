/** A Markdown note the app knows about, with its folder names below the vault root. */
export interface VaultNote {
  id: string;
  name: string;
  /** Folder names from just below the root down to the note's folder (`[]` at the root). */
  path: readonly string[];
}

/** One `[[Target#Heading|Alias]]` occurrence with its source offsets. */
export interface Wikilink {
  /** Offset of the opening `[[`. */
  from: number;
  /** Offset just past the closing `]]`. */
  to: number;
  raw: string;
  /** Trimmed target, e.g. `Folder/Note` (empty for a same-note `[[#Heading]]`). */
  target: string;
  targetFrom: number;
  targetTo: number;
  heading?: string;
  alias?: string;
}

export interface SourceLine {
  text: string;
  /** Offset of the line's first character in the whole text. */
  from: number;
  /** 1-based line number. */
  number: number;
  /** Whether the line belongs to a fenced code block (its fences included). */
  inFence: boolean;
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const LINK = /\[\[([^[\]|#\r\n]*)(?:#([^[\]|\r\n]*))?(?:\|([^[\]\r\n]*))?\]\]/g;

/** Splits `text` into lines (any line ending) and marks fenced code blocks. */
export function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const breaks = /\r\n|\r|\n/g;
  let fence: string | null = null;
  let start = 0;
  let number = 1;
  for (;;) {
    const match = breaks.exec(text);
    const end = match === null ? text.length : match.index;
    const line = text.slice(start, end);
    const marker = FENCE.exec(line)?.[1];
    let inFence = fence !== null;
    if (fence === null && marker !== undefined) {
      fence = marker;
      inFence = true;
    } else if (fence !== null && marker?.[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
    lines.push({ text: line, from: start, number, inFence });
    if (match === null) {
      return lines;
    }
    start = match.index + match[0].length;
    number += 1;
  }
}

/** Replaces inline code spans with spaces, keeping every offset in place. */
export function maskInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i += 1;
      continue;
    }
    let run = 1;
    while (line[i + run] === "`") {
      run += 1;
    }
    let close = -1;
    for (let j = i + run; j < line.length;) {
      if (line[j] !== "`") {
        j += 1;
        continue;
      }
      let other = 1;
      while (line[j + other] === "`") {
        other += 1;
      }
      if (other === run) {
        close = j;
        break;
      }
      j += other;
    }
    if (close === -1) {
      out += line.slice(i, i + run);
      i += run;
      continue;
    }
    out += " ".repeat(close + run - i);
    i = close + run;
  }
  return out;
}

function linksInLine(line: SourceLine): Wikilink[] {
  if (line.inFence || !line.text.includes("[[")) {
    return [];
  }
  const masked = maskInlineCode(line.text);
  const links: Wikilink[] = [];
  LINK.lastIndex = 0;
  for (let match = LINK.exec(masked); match !== null; match = LINK.exec(masked)) {
    const rawTarget = match[1];
    const target = rawTarget.trim();
    const heading = match[2]?.trim();
    if (target.length === 0 && (heading === undefined || heading.length === 0)) {
      continue;
    }
    const from = line.from + match.index;
    const targetFrom = from + 2 + (rawTarget.length - rawTarget.trimStart().length);
    const alias = match[3]?.trim();
    links.push({
      from,
      to: from + match[0].length,
      raw: line.text.slice(match.index, match.index + match[0].length),
      target,
      targetFrom,
      targetTo: targetFrom + target.length,
      heading: heading === undefined || heading.length === 0 ? undefined : heading,
      alias: alias === undefined || alias.length === 0 ? undefined : alias,
    });
  }
  return links;
}

/** Every wikilink in `text`, skipping fenced code blocks and inline code spans. */
export function parseWikilinks(text: string): Wikilink[] {
  return sourceLines(text).flatMap(linksInLine);
}

/** `Note.md` → `Note` (any case of the extension). */
export function noteStem(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

function targetSegments(target: string): string[] {
  const segments = noteStem(target.trim())
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name.toLowerCase() === b[i].toLowerCase());
}

/**
 * Finds the note a wikilink target names: same stem (case-insensitive), folder segments matching
 * the end of the note's path. Among several, a note in `fromPath` (the linking note's folder) wins,
 * then the shortest path.
 */
export function resolveWikilink<T extends VaultNote>(
  target: string,
  notes: readonly T[],
  fromPath?: readonly string[],
): T | null {
  const segments = targetSegments(target);
  const stem = segments.pop()?.toLowerCase();
  if (stem === undefined) {
    return null;
  }
  const candidates = notes.filter(
    (note) =>
      noteStem(note.name).toLowerCase() === stem &&
      note.path.length >= segments.length &&
      samePath(note.path.slice(note.path.length - segments.length), segments),
  );
  if (candidates.length === 0) {
    return null;
  }
  const rank = (note: T) => (fromPath !== undefined && samePath(note.path, fromPath) ? 0 : 1);
  return [...candidates].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.path.length - b.path.length ||
      a.path.join("/").localeCompare(b.path.join("/")),
  )[0];
}

/**
 * The target to write for `note` so it resolves back to it from anywhere: its stem, or its full
 * folder path when another note shares the stem.
 */
export function linkTargetFor(note: VaultNote, notes: readonly VaultNote[]): string {
  const stem = noteStem(note.name);
  const ambiguous = notes.some(
    (other) => other.id !== note.id && noteStem(other.name).toLowerCase() === stem.toLowerCase(),
  );
  return ambiguous && note.path.length > 0 ? `${note.path.join("/")}/${stem}` : stem;
}

/**
 * Points every link `matches` accepts at `newStem`, replacing only the note-name part of its target
 * (folder segments, `.md`, heading and alias are kept), so every other byte stays as it was.
 */
export function rewriteWikilinks(
  text: string,
  matches: (link: Wikilink) => boolean,
  newStem: string,
): { text: string; count: number } {
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const link of parseWikilinks(text)) {
    if (link.target.length === 0 || !matches(link)) {
      continue;
    }
    const slash = link.target.lastIndexOf("/");
    const prefix = slash === -1 ? "" : link.target.slice(0, slash + 1);
    const ext = link.target.toLowerCase().endsWith(".md") ? link.target.slice(-3) : "";
    const next = `${prefix}${newStem}${ext}`;
    if (next === link.target) {
      continue;
    }
    out += text.slice(cursor, link.targetFrom) + next;
    cursor = link.targetTo;
    count += 1;
  }
  return count === 0 ? { text, count } : { text: out + text.slice(cursor), count };
}

export interface BacklinkContext {
  /** 1-based line number of the linking line. */
  line: number;
  /** The linking line, trimmed. */
  text: string;
}

/** The lines of `text` holding at least one link `matches` accepts. */
export function backlinkContexts(
  text: string,
  matches: (link: Wikilink) => boolean,
): BacklinkContext[] {
  const out: BacklinkContext[] = [];
  for (const line of sourceLines(text)) {
    if (linksInLine(line).some(matches)) {
      out.push({ line: line.number, text: line.text.trim() });
    }
  }
  return out;
}
