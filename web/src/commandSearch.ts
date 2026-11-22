export const RECENT_FILES_STORAGE_KEY = "markyard:recent-files:v1";
const MAX_RECENT_FILES = 8;

export function getRecentFileIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_FILES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function saveRecentFileIds(ids: string[]): string[] {
  const trimmed = ids.slice(0, MAX_RECENT_FILES);
  try {
    window.localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
  return trimmed;
}

export function recordRecentFile(fileId: string): string[] {
  const existing = getRecentFileIds().filter((id) => id !== fileId);
  return saveRecentFileIds([fileId, ...existing]);
}

export function removeRecentFile(fileId: string): string[] {
  const next = getRecentFileIds().filter((id) => id !== fileId);
  return saveRecentFileIds(next);
}

export function clearRecentFiles(): void {
  try {
    window.localStorage.removeItem(RECENT_FILES_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

/** Formats local date as `YYYY-MM-DD`. */
export function formatLocalDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayNoteName(now: Date = new Date()): string {
  return `${formatLocalDate(now)}.md`;
}

export function todayNoteInitialContent(now: Date = new Date()): string {
  return `# ${formatLocalDate(now)}\n\n`;
}

export interface FuzzyMatch {
  score: number;
  indices: number[];
}

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = text[index - 1];
  return prev === " " || prev === "/" || prev === "-" || prev === "_" || prev === ".";
}

/**
 * Lightweight case-insensitive fuzzy matcher tuned for note filenames, folder paths, and commands.
 * Favors exact prefixes, contiguous runs, word boundaries, and shorter candidates.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return { score: 0, indices: [] };
  }
  const t = target.toLowerCase();

  const exactIdx = t.indexOf(q);
  if (exactIdx !== -1) {
    const indices: number[] = [];
    for (let i = 0; i < q.length; i += 1) {
      indices.push(exactIdx + i);
    }
    let score = 200 + q.length * 10 - target.length * 0.25;
    if (exactIdx === 0) {
      score += 80;
    } else if (isWordBoundary(t, exactIdx)) {
      score += 45;
    }
    if (t === q) {
      score += 120;
    }
    return { score, indices };
  }

  // Subsequence match ignoring whitespace in query when matching paths/words.
  const compactQ = q.replace(/\s+/g, "");
  if (compactQ.length === 0) {
    return null;
  }
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastMatch = -2;

  for (let ti = 0; ti < t.length && qi < compactQ.length; ti += 1) {
    if (t[ti] === compactQ[qi]) {
      indices.push(ti);
      score += 10;
      if (ti === lastMatch + 1) {
        score += 18;
      }
      if (isWordBoundary(t, ti)) {
        score += 14;
      }
      if (qi === 0 && ti === 0) {
        score += 20;
      }
      lastMatch = ti;
      qi += 1;
    }
  }

  if (qi !== compactQ.length) {
    return null;
  }
  const span = indices[indices.length - 1] - indices[0] + 1;
  score -= (span - compactQ.length) * 1.5;
  score -= target.length * 0.2;
  return { score, indices };
}

export interface ContentSnippet {
  before: string;
  match: string;
  after: string;
  line: number;
}

function stripFrontmatterWithOffset(text: string): { body: string; lineOffset: number } {
  const clean = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(clean);
  if (!fm) {
    return { body: clean, lineOffset: 0 };
  }
  const lineOffset = fm[0].split(/\r?\n/).length - 1;
  return { body: clean.slice(fm[0].length), lineOffset };
}

/**
 * Finds a readable snippet for a local full-text query inside a Markdown note.
 * Matches the full phrase first; if multi-word, requires every token to appear in the note.
 */
export function findContentSnippet(text: string, query: string): ContentSnippet | null {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return null;
  }
  const { body, lineOffset } = stripFrontmatterWithOffset(text);
  const lowerBody = body.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();

  let matchStart = lowerBody.indexOf(lowerQuery);
  let matchLength = trimmed.length;

  if (matchStart === -1) {
    const tokens = lowerQuery.split(/\s+/).filter((tok) => tok.length >= 2);
    if (tokens.length < 2) {
      return null;
    }
    let firstPos = Infinity;
    let firstLen = 0;
    for (const tok of tokens) {
      const idx = lowerBody.indexOf(tok);
      if (idx === -1) {
        return null;
      }
      if (idx < firstPos) {
        firstPos = idx;
        firstLen = tok.length;
      }
    }
    matchStart = firstPos;
    matchLength = firstLen;
  }

  // Locate the enclosing line so the snippet stays crisp and gives the 1-based line number.
  const lineStart = body.lastIndexOf("\n", matchStart - 1) + 1;
  const rawLineEnd = body.indexOf("\n", matchStart + matchLength);
  const lineEnd = rawLineEnd === -1 ? body.length : rawLineEnd;
  const lineText = body.slice(lineStart, lineEnd).replace(/\r$/, "");
  const line = lineOffset + body.slice(0, lineStart).split("\n").length;

  const relStart = matchStart - lineStart;
  const radiusBefore = 36;
  const radiusAfter = 56;
  const sliceStart = Math.max(0, relStart - radiusBefore);
  const sliceEnd = Math.min(lineText.length, relStart + matchLength + radiusAfter);

  const prefixEllipsis = sliceStart > 0 ? "…" : "";
  const suffixEllipsis = sliceEnd < lineText.length ? "…" : "";

  return {
    before: `${prefixEllipsis}${lineText.slice(sliceStart, relStart)}`,
    match: lineText.slice(relStart, relStart + matchLength),
    after: `${lineText.slice(relStart + matchLength, sliceEnd)}${suffixEllipsis}`,
    line,
  };
}

export interface HeadingItem {
  level: number;
  text: string;
  /** 1-based line number in the raw Markdown document. */
  line: number;
  /** 0-based order among rendered headings (matches Preview heading DOM order). */
  index: number;
}

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

/** Extracts ATX Markdown headings (`#`..`######`), skipping YAML frontmatter and fenced code blocks. */
export function extractHeadings(markdown: string): HeadingItem[] {
  const clean = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const lines = clean.split(/\r?\n/);
  const headings: HeadingItem[] = [];

  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (let j = 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "---") {
        i = j + 1;
        break;
      }
    }
  }

  let fence: { char: string; len: number } | null = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = { char: marker[0], len: marker.length };
      } else if (fence.char === marker[0] && marker.length >= fence.len) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      continue;
    }
    const headingMatch = /^(#{1,6})[ \t]+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const text = cleanHeadingText(headingMatch[2]);
      if (text.length > 0) {
        headings.push({
          level: headingMatch[1].length,
          text,
          line: i + 1,
          index: headings.length,
        });
      }
    }
  }

  return headings;
}
