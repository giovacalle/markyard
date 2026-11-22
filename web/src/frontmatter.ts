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

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function scalarOrList(key: string, raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map(unquote)
      .filter((item) => item !== "");
  }
  if (TAG_KEYS.has(key.toLowerCase())) {
    return value
      .split(/[\s,]+/)
      .map((tag) => unquote(tag).replace(/^#/, ""))
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
      last.value = [...(Array.isArray(last.value) ? last.value : []), unquote(item[1])];
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
