// Read-only view of a note's leading YAML frontmatter. It never rewrites the note: the raw bytes
// stay in the file, and only `end`/`endLine` are used to fold them in the editor.

export interface FrontmatterProperty {
  key: string;
  value: string | string[];
}

export interface Frontmatter {
  /** Offset just past the closing fence (its line break excluded). */
  end: number;
  /** 1-based line number of the closing fence. */
  endLine: number;
  properties: FrontmatterProperty[];
}

const TAG_KEYS = new Set(["tags", "tag", "keywords"]);

export function isTagKey(key: string): boolean {
  return TAG_KEYS.has(key.toLowerCase());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function cleanTag(raw: string): string {
  return unquote(raw).replace(/^#/, "").trim();
}

function scalarOrList(key: string, raw: string): string | string[] {
  const value = raw.trim();
  const isTags = isTagKey(key);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map(isTags ? cleanTag : unquote)
      .filter((item) => item !== "");
  }
  if (isTags) {
    return value
      .split(/[\s,]+/)
      .map(cleanTag)
      .filter((tag) => tag !== "");
  }
  return unquote(value);
}

/** Parses simple `key: value` frontmatter (scalars, `[a, b]` and `- item` lists), or `null`. */
export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  if (lines[0]?.trimEnd() !== "---") {
    return null;
  }
  const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (close === -1) {
    return null;
  }

  const properties: FrontmatterProperty[] = [];
  for (const line of lines.slice(1, close)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    const last = properties.at(-1);
    if (item && last) {
      const value = isTagKey(last.key) ? cleanTag(item[1]) : unquote(item[1]);
      const existing = Array.isArray(last.value) ? last.value : [];
      if (!isTagKey(last.key) || value !== "") {
        last.value = [...existing, value];
      } else {
        last.value = existing;
      }
      continue;
    }
    const entry = /^([^\s#:][^:]*):(?:\s+(.*))?$/.exec(line);
    if (entry) {
      const key = entry[1].trim();
      properties.push({ key, value: entry[2] === undefined ? "" : scalarOrList(key, entry[2]) });
    }
  }

  const lineBreaks = text.match(/\r\n|\r|\n/g) ?? [];
  let end = text.startsWith("\uFEFF") ? 1 : 0;
  for (let i = 0; i < close; i += 1) {
    end += lines[i].length + (lineBreaks[i]?.length ?? 0);
  }
  end += lines[close].length;
  return { end, endLine: close + 1, properties };
}

/** Unique non-empty tag values from parsed frontmatter (order preserved, deduped case-insensitively). */
export function frontmatterTags(frontmatter: Frontmatter | null): string[] {
  if (frontmatter === null) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const prop of frontmatter.properties) {
    if (!isTagKey(prop.key)) {
      continue;
    }
    const values = Array.isArray(prop.value) ? prop.value : [prop.value];
    for (const raw of values) {
      const tag = raw.replace(/^#/, "").trim();
      if (tag === "") {
        continue;
      }
      const lower = tag.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.push(tag);
      }
    }
  }
  return out;
}

/** Unique non-empty frontmatter tags directly from raw note text. */
export function extractFrontmatterTags(text: string): string[] {
  return frontmatterTags(parseFrontmatter(text));
}

/**
 * Normalizes a `...` YAML frontmatter closing fence to `---` (exact same 3-byte length) so
 * remark-frontmatter strips it without shifting any body offsets or mutating the saved note.
 */
export function normalizeFrontmatterFence(text: string): string {
  const fm = parseFrontmatter(text);
  if (fm === null) {
    return text;
  }
  let closeLineStart = fm.end;
  while (
    closeLineStart > 0 &&
    text[closeLineStart - 1] !== "\n" &&
    text[closeLineStart - 1] !== "\r"
  ) {
    closeLineStart -= 1;
  }
  if (!text.startsWith("...", closeLineStart)) {
    return text;
  }
  return `${text.slice(0, closeLineStart)}---${text.slice(closeLineStart + 3)}`;
}
