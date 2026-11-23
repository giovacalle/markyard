// Parsing and surgical round-trip editing for a note's leading YAML frontmatter.
// Mutations splice only the touched property's UTF-16 span so comments, blank lines,
// key order, CRLF/LF endings, leading UTF-8 BOM, `...` fences, and complex YAML survive byte-for-byte.

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

export type EditablePropertyKind = "tags" | "boolean" | "list" | "text" | "complex";
export type EditablePropertyStyle = "scalar" | "flow-list" | "block-list";

export interface EditableFrontmatterProperty {
  key: string;
  value: string | string[];
  kind: EditablePropertyKind;
  booleanValue?: boolean;
  listItems?: string[];
  /** Start offset of the property's first line (column 0). */
  blockStart: number;
  /** End offset of the property's last line (excluding its trailing line break). */
  blockEnd: number;
  /** Start offset of the property's value span. */
  valueStart: number;
  /** End offset of the property's value span. */
  valueEnd: number;
  style: EditablePropertyStyle;
}

export interface EditableFrontmatter {
  bom: boolean;
  eol: "\r\n" | "\n" | "\r";
  /** Offset just past the opening `---` line (including its line break). */
  openEnd: number;
  /** Start offset of the closing fence line (`---` or `...`). */
  closeStart: number;
  /** Offset just past the closing fence (excluding its trailing line break). */
  closeEnd: number;
  closingFence: "---" | "...";
  /** Start offset of the body after the closing fence (and at most one blank separator line). */
  bodyStart: number;
  /** Raw frontmatter text from offset 0 through `closeEnd` (including BOM and closing fence). */
  raw: string;
  hasComments: boolean;
  properties: EditableFrontmatterProperty[];
}

export interface SplitFrontmatterResult {
  frontmatterRaw: string;
  body: string;
  bodyStart: number;
  frontmatterLineCount: number;
}

const TAG_KEYS = new Set(["tags", "tag", "keywords"]);

export function isTagKey(key: string): boolean {
  return TAG_KEYS.has(key.toLowerCase());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to simple slice for non-JSON YAML escape sequences.
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function isQuotedScalar(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") {
    return false;
  }
  if (trimmed[trimmed.length - 1] !== quote) {
    return false;
  }
  // Verify the opening quote isn't closed early before the final character.
  let i = 1;
  while (i < trimmed.length - 1) {
    const ch = trimmed[i];
    if (quote === '"' && ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === "'" && ch === "'" && trimmed[i + 1] === "'") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return false;
    }
    i += 1;
  }
  return true;
}

function cleanTag(raw: string): string {
  return unquote(raw).replace(/^#/, "").trim();
}

function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
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
  return out;
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

// ---------------------------------------------------------------------------
// Span-aware parser and surgical round-trip patcher
// ---------------------------------------------------------------------------

interface ScannedLine {
  text: string;
  start: number;
  end: number;
  eol: "\r\n" | "\n" | "\r" | "";
  next: number;
}

function detectEol(text: string): "\r\n" | "\n" | "\r" {
  const match = /\r\n|\n|\r/.exec(text);
  if (match?.[0] === "\r\n" || match?.[0] === "\r" || match?.[0] === "\n") {
    return match[0];
  }
  return "\n";
}

function scanLines(text: string, startOffset: number): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let pos = startOffset;
  while (pos < text.length) {
    let end = pos;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
      end += 1;
    }
    let eol: "\r\n" | "\n" | "\r" | "" = "";
    if (text[end] === "\r" && text[end + 1] === "\n") {
      eol = "\r\n";
    } else if (text[end] === "\n") {
      eol = "\n";
    } else if (text[end] === "\r") {
      eol = "\r";
    }
    const next = end + eol.length;
    lines.push({ text: text.slice(pos, end), start: pos, end, eol, next });
    pos = next;
  }
  return lines;
}

/**
 * Finds an unquoted inline YAML comment (` #...`) in `raw` and returns the trimmed value slice
 * before it plus the offset where the value ends (excluding any space before `#`).
 */
function stripInlineComment(raw: string): {
  value: string;
  endOffset: number;
  hasComment: boolean;
} {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#" && (i === 0 || /[ \t]/.test(raw[i - 1]))) {
      let end = i;
      while (end > 0 && /[ \t]/.test(raw[end - 1])) {
        end -= 1;
      }
      return { value: raw.slice(0, end), endOffset: end, hasComment: true };
    }
  }
  let end = raw.length;
  while (end > 0 && /[ \t]/.test(raw[end - 1])) {
    end -= 1;
  }
  return { value: raw.slice(0, end), endOffset: end, hasComment: false };
}

/**
 * Parses a flat single-line flow sequence `[a, "b, c"]`, or returns `null` if it is unbalanced or
 * contains nested collections / anchors / aliases (which must be treated as complex YAML).
 */
function parseSimpleFlowList(raw: string): string[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    return null;
  }
  const inner = raw.slice(1, -1);
  const items: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inDouble) {
      current += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        i += 1;
        current += inner[i];
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          i += 1;
          current += inner[i];
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      return null;
    } else if (ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (inSingle || inDouble) {
    return null;
  }
  const tail = current.trim();
  if (tail !== "" || items.length > 0) {
    if (tail !== "") {
      items.push(tail);
    }
  }
  for (const item of items) {
    if (!isQuotedScalar(item) && (isAnchorOrAliasOrTag(item) || looksLikeInlineMapEntry(item))) {
      return null;
    }
  }
  return items;
}

function isBlockScalarHeader(value: string): boolean {
  return /^[|>](?:[+-]\d*|\d+[+-]?)?$/.test(value);
}

function isAnchorOrAliasOrTag(value: string): boolean {
  return /^[&*!]/.test(value);
}

function looksLikeInlineMapEntry(value: string): boolean {
  return /^[^\s"'][^:]*:(?:\s|$)/.test(value);
}

function isComplexInlineScalar(value: string): boolean {
  if (value === "") {
    return false;
  }
  if (isQuotedScalar(value)) {
    return false;
  }
  if (isBlockScalarHeader(value) || isAnchorOrAliasOrTag(value)) {
    return true;
  }
  if (value.startsWith("{") || (value.startsWith("[") && parseSimpleFlowList(value) === null)) {
    return true;
  }
  return false;
}

const AMBIGUOUS_YAML_WORD = /^(?:true|false|null|~|yes|no|on|off)$/i;

/** Formats a string as a safe YAML scalar, quoting only when YAML syntax requires it. */
export function formatYamlScalar(value: string, options?: { flow?: boolean }): string {
  if (value === "") {
    return '""';
  }
  const needsQuote =
    /^\s|\s$/.test(value) ||
    /[\r\n\t]/.test(value) ||
    /:(?:\s|$)/.test(value) ||
    /(?:^|\s)#/.test(value) ||
    /^(?:[-?:](?:\s|$)|[,[\]{}#&*!|>'"%@`])/.test(value) ||
    AMBIGUOUS_YAML_WORD.test(value) ||
    (options?.flow === true && /[,[\]{}]/.test(value));
  return needsQuote ? JSON.stringify(value) : value;
}

function formatFlowList(items: readonly string[]): string {
  return `[${items.map((item) => formatYamlScalar(item, { flow: true })).join(", ")}]`;
}

/**
 * Parses leading YAML frontmatter with exact UTF-16 byte spans and complex-YAML detection for
 * surgical round-trip editing. Returns `null` when the note has no closed frontmatter block.
 */
export function parseFrontmatterEditable(text: string): EditableFrontmatter | null {
  const bom = text.startsWith("\uFEFF");
  const lines = scanLines(text, bom ? 1 : 0);
  if (lines.length === 0 || lines[0].text.trimEnd() !== "---") {
    return null;
  }
  const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line.text));
  if (close === -1) {
    return null;
  }

  const eol = lines[0].eol || detectEol(text);
  const openEnd = lines[0].next;
  const closeStart = lines[close].start;
  const closeEnd = lines[close].end;
  const closingFence: "---" | "..." = lines[close].text.startsWith("...") ? "..." : "---";

  let bodyStart = lines[close].next;
  if (
    lines[close].eol !== "" &&
    close + 1 < lines.length &&
    lines[close + 1].text === "" &&
    lines[close + 1].eol !== ""
  ) {
    bodyStart = lines[close + 1].next;
  }

  let hasComments = false;
  const properties: EditableFrontmatterProperty[] = [];

  let i = 1;
  while (i < close) {
    const line = lines[i];
    if (/^\s*$/.test(line.text)) {
      i += 1;
      continue;
    }
    if (/^\s*#/.test(line.text)) {
      hasComments = true;
      i += 1;
      continue;
    }

    const entry = /^([^\s#:][^:]*):(.*)$/.exec(line.text);
    if (!entry) {
      i += 1;
      continue;
    }

    const key = entry[1].trim();
    const isTags = isTagKey(key);
    const colonOffset = line.start + entry[1].length;
    const rawAfterColon = entry[2];
    const leadingSpacesMatch = /^[ \t]*/.exec(rawAfterColon);
    const leadingSpacesLen = leadingSpacesMatch?.[0].length ?? 0;
    const afterSpaces = rawAfterColon.slice(leadingSpacesLen);

    let inlineValue: string;
    let inlineValueEnd: number;
    let keyLineHasComment = false;

    if (isTags) {
      let trimmedEnd = afterSpaces.length;
      while (trimmedEnd > 0 && /[ \t]/.test(afterSpaces[trimmedEnd - 1])) {
        trimmedEnd -= 1;
      }
      inlineValue = afterSpaces.slice(0, trimmedEnd);
      inlineValueEnd = colonOffset + 1 + leadingSpacesLen + trimmedEnd;
    } else {
      const stripped = stripInlineComment(afterSpaces);
      inlineValue = stripped.value;
      inlineValueEnd = colonOffset + 1 + leadingSpacesLen + stripped.endOffset;
      if (stripped.hasComment) {
        hasComments = true;
        keyLineHasComment = true;
      }
    }

    // Collect any indented continuation lines belonging to this key, without swallowing trailing
    // blank lines or comments that belong to the next sibling key.
    let lastContentLine = i;
    let internalComment = false;
    let scan = i + 1;
    let sawIntermediateComment = false;
    while (scan < close) {
      const nextLine = lines[scan];
      if (/^\s*$/.test(nextLine.text)) {
        scan += 1;
        continue;
      }
      if (/^\s*#/.test(nextLine.text)) {
        sawIntermediateComment = true;
        scan += 1;
        continue;
      }
      if (/^[ \t]+/.test(nextLine.text)) {
        if (sawIntermediateComment) {
          internalComment = true;
          hasComments = true;
        }
        lastContentLine = scan;
        sawIntermediateComment = false;
        scan += 1;
        continue;
      }
      break;
    }

    const blockStart = line.start;
    const blockEnd = lines[lastContentLine].end;
    const hasIndentedChildren = lastContentLine > i;

    if (hasIndentedChildren) {
      if (inlineValue !== "" || internalComment) {
        // Block scalar (`|` / `>`), anchored subtree, multi-line plain scalar, or list with internal comments.
        properties.push({
          key,
          value: text.slice(colonOffset + 1, blockEnd).trim(),
          kind: "complex",
          blockStart,
          blockEnd,
          valueStart: colonOffset + 1,
          valueEnd: blockEnd,
          style: "scalar",
        });
        i = lastContentLine + 1;
        continue;
      }

      // Check whether every indented non-blank line is a simple scalar block-list item at uniform indent.
      const items: string[] = [];
      let expectedIndent: string | null = null;
      let simpleBlockList = true;
      for (let k = i + 1; k <= lastContentLine; k += 1) {
        const childText = lines[k].text;
        if (/^\s*$/.test(childText)) {
          continue;
        }
        const itemMatch = /^([ \t]+)-(?:[ \t]+(.*))?$/.exec(childText);
        if (!itemMatch || itemMatch[2] === undefined) {
          simpleBlockList = false;
          break;
        }
        const indent = itemMatch[1];
        if (expectedIndent === null) {
          expectedIndent = indent;
        } else if (indent !== expectedIndent) {
          simpleBlockList = false;
          break;
        }
        const rawItem = isTags ? itemMatch[2].trim() : stripInlineComment(itemMatch[2]).value;
        if (!isTags && stripInlineComment(itemMatch[2]).hasComment) {
          hasComments = true;
          simpleBlockList = false;
          break;
        }
        if (
          rawItem === "" ||
          (!isQuotedScalar(rawItem) &&
            (isComplexInlineScalar(rawItem) ||
              looksLikeInlineMapEntry(rawItem) ||
              /^-\s/.test(rawItem)))
        ) {
          simpleBlockList = false;
          break;
        }
        const parsedItem = isTags ? cleanTag(rawItem) : unquote(rawItem);
        if (!isTags || parsedItem !== "") {
          items.push(parsedItem);
        }
      }

      if (simpleBlockList) {
        const cleaned = isTags ? dedupeTags(items) : items;
        properties.push({
          key,
          value: cleaned,
          kind: isTags ? "tags" : "list",
          listItems: cleaned,
          blockStart,
          blockEnd,
          valueStart: lines[i + 1].start,
          valueEnd: blockEnd,
          style: "block-list",
        });
      } else {
        properties.push({
          key,
          value: text.slice(colonOffset + 1, blockEnd).trim(),
          kind: "complex",
          blockStart,
          blockEnd,
          valueStart: colonOffset + 1,
          valueEnd: blockEnd,
          style: "scalar",
        });
      }
      i = lastContentLine + 1;
      continue;
    }

    // Single-line property.
    const valueStart = inlineValue === "" ? colonOffset + 1 : colonOffset + 1 + leadingSpacesLen;
    const valueEnd =
      inlineValue === "" ? (keyLineHasComment ? colonOffset + 1 : line.end) : inlineValueEnd;

    if (isComplexInlineScalar(inlineValue)) {
      properties.push({
        key,
        value: inlineValue,
        kind: "complex",
        blockStart,
        blockEnd,
        valueStart,
        valueEnd,
        style: "scalar",
      });
      i += 1;
      continue;
    }

    if (inlineValue.startsWith("[") && inlineValue.endsWith("]")) {
      const parsedFlow = parseSimpleFlowList(inlineValue);
      if (parsedFlow === null) {
        properties.push({
          key,
          value: inlineValue,
          kind: "complex",
          blockStart,
          blockEnd,
          valueStart,
          valueEnd,
          style: "scalar",
        });
      } else {
        const items = parsedFlow
          .map(isTags ? cleanTag : unquote)
          .filter((item) => !isTags || item !== "");
        const finalItems = isTags ? dedupeTags(items) : items;
        properties.push({
          key,
          value: finalItems,
          kind: isTags ? "tags" : "list",
          listItems: finalItems,
          blockStart,
          blockEnd,
          valueStart,
          valueEnd,
          style: "flow-list",
        });
      }
      i += 1;
      continue;
    }

    if (isTags) {
      const items =
        inlineValue === ""
          ? []
          : dedupeTags(
              inlineValue
                .split(/[\s,]+/)
                .map(cleanTag)
                .filter((tag) => tag !== ""),
            );
      properties.push({
        key,
        value: items,
        kind: "tags",
        listItems: items,
        blockStart,
        blockEnd,
        valueStart,
        valueEnd,
        style: "scalar",
      });
      i += 1;
      continue;
    }

    if (!isQuotedScalar(inlineValue) && /^(true|false)$/i.test(inlineValue)) {
      properties.push({
        key,
        value: inlineValue,
        kind: "boolean",
        booleanValue: inlineValue.toLowerCase() === "true",
        blockStart,
        blockEnd,
        valueStart,
        valueEnd,
        style: "scalar",
      });
      i += 1;
      continue;
    }

    properties.push({
      key,
      value: inlineValue === "" ? "" : unquote(inlineValue),
      kind: "text",
      blockStart,
      blockEnd,
      valueStart,
      valueEnd,
      style: "scalar",
    });
    i += 1;
  }

  return {
    bom,
    eol,
    openEnd,
    closeStart,
    closeEnd,
    closingFence,
    bodyStart,
    raw: text.slice(0, closeEnd),
    hasComments,
    properties,
  };
}

/**
 * Splits a note into its leading frontmatter prefix (including closing fence and at most one blank
 * separator line) and its editable body, guaranteeing `frontmatterRaw + body === text`.
 */
export function splitFrontmatter(text: string): SplitFrontmatterResult {
  const fm = parseFrontmatterEditable(text);
  if (fm === null) {
    return { frontmatterRaw: "", body: text, bodyStart: 0, frontmatterLineCount: 0 };
  }
  const frontmatterRaw = text.slice(0, fm.bodyStart);
  const body = text.slice(fm.bodyStart);
  const breaks = frontmatterRaw.match(/\r\n|\r|\n/g)?.length ?? 0;
  const endsWithBreak = /(?:\r\n|\r|\n)$/.test(frontmatterRaw);
  const frontmatterLineCount = endsWithBreak ? breaks : breaks + 1;
  return { frontmatterRaw, body, bodyStart: fm.bodyStart, frontmatterLineCount };
}

/**
 * Recombines a split frontmatter prefix and body, inserting a line break if the frontmatter had no
 * trailing newline and the body became non-empty (so the closing `---` fence is never corrupted).
 */
export function joinFrontmatter(frontmatterRaw: string, body: string): string {
  if (frontmatterRaw === "") {
    return body;
  }
  if (body === "" || /(?:\r\n|\r|\n)$/.test(frontmatterRaw)) {
    return frontmatterRaw + body;
  }
  return frontmatterRaw + detectEol(frontmatterRaw) + body;
}

/** Ensures the note starts with a YAML frontmatter block, preserving BOM and line endings. */
export function ensureFrontmatter(text: string): string {
  if (parseFrontmatterEditable(text) !== null) {
    return text;
  }
  const bom = text.startsWith("\uFEFF");
  const prefix = bom ? "\uFEFF" : "";
  const rest = bom ? text.slice(1) : text;
  const eol = detectEol(rest);
  if (rest.length === 0) {
    return `${prefix}---${eol}---${eol}`;
  }
  if (/^(?:\r\n|\r|\n)/.test(rest)) {
    return `${prefix}---${eol}---${eol}${rest}`;
  }
  return `${prefix}---${eol}---${eol}${eol}${rest}`;
}

function normalizePropertyInputItems(key: string, value: string | readonly string[]): string[] {
  const isTags = isTagKey(key);
  const rawList = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.trim() === ""
        ? []
        : isTags
          ? value.split(/[\s,]+/)
          : value.split(",")
      : [];
  const cleaned = rawList.map((item) => (isTags ? cleanTag(item) : item.trim())).filter(Boolean);
  return isTags ? dedupeTags(cleaned) : cleaned;
}

/** Adds a new property at the end of the frontmatter block (creating frontmatter if absent). */
export function addFrontmatterProperty(
  text: string,
  key: string,
  value: string | boolean | readonly string[],
): string {
  const cleanKey = key.trim().replace(/:+$/, "").trim();
  if (cleanKey === "" || /[\r\n:]/.test(cleanKey)) {
    return text;
  }
  const ensured = ensureFrontmatter(text);
  const fm = parseFrontmatterEditable(ensured);
  if (fm === null) {
    return text;
  }

  let formattedLine: string;
  if (typeof value === "boolean") {
    formattedLine = `${cleanKey}: ${value ? "true" : "false"}`;
  } else if (typeof value !== "string" || isTagKey(cleanKey)) {
    const items = normalizePropertyInputItems(cleanKey, value);
    formattedLine = `${cleanKey}: ${formatFlowList(items)}`;
  } else {
    formattedLine = value === "" ? `${cleanKey}:` : `${cleanKey}: ${formatYamlScalar(value)}`;
  }

  return `${ensured.slice(0, fm.closeStart)}${formattedLine}${fm.eol}${ensured.slice(fm.closeStart)}`;
}

function replaceBlockListProperty(
  text: string,
  fm: EditableFrontmatter,
  prop: EditableFrontmatterProperty,
  items: readonly string[],
): string {
  const firstLineSlice = text.slice(prop.valueStart, prop.blockEnd);
  const indent = /^([ \t]+)-/.exec(firstLineSlice)?.[1] ?? "  ";
  if (items.length > 0) {
    const replacement = items.map((item) => `${indent}- ${formatYamlScalar(item)}`).join(fm.eol);
    return `${text.slice(0, prop.valueStart)}${replacement}${text.slice(prop.blockEnd)}`;
  }
  // Emptying a block list: if the key line has no trailing comment, collapse to `key: []`.
  const keyLineEnd = text.indexOf(fm.eol, prop.blockStart);
  const colonPos = text.indexOf(":", prop.blockStart);
  const keyLineText = keyLineEnd === -1 ? "" : text.slice(colonPos + 1, keyLineEnd);
  if (keyLineText.trim() === "" && colonPos !== -1 && colonPos < prop.valueStart) {
    return `${text.slice(0, colonPos + 1)} []${text.slice(prop.blockEnd)}`;
  }
  // Keep any comment on the key line and remove only the item lines beneath it.
  const beforeFirstItemBreak =
    keyLineEnd !== -1 && keyLineEnd < prop.valueStart ? keyLineEnd : prop.valueStart;
  return `${text.slice(0, beforeFirstItemBreak)}${text.slice(prop.blockEnd)}`;
}

function replaceScalarSpan(
  text: string,
  prop: EditableFrontmatterProperty,
  formattedValue: string,
): string {
  const colonPos = text.indexOf(":", prop.blockStart);
  if (colonPos === -1 || colonPos >= prop.valueStart) {
    return text;
  }
  const hasExistingValue = prop.valueStart > colonPos + 1 && prop.valueEnd > prop.valueStart;
  if (formattedValue === "") {
    // Drop dangling spaces between `:` and an emptied scalar value, keeping any trailing comment.
    return `${text.slice(0, colonPos + 1)}${text.slice(prop.valueEnd)}`;
  }
  if (hasExistingValue) {
    return `${text.slice(0, prop.valueStart)}${formattedValue}${text.slice(prop.valueEnd)}`;
  }
  return `${text.slice(0, colonPos + 1)} ${formattedValue}${text.slice(prop.valueEnd)}`;
}

/**
 * Surgically updates the property at `index` in place, preserving all untouched lines, comments,
 * indentation, CRLF/LF, BOM, and `...` fences. No-op when `index` is out of range or `complex`.
 */
export function setFrontmatterProperty(
  text: string,
  index: number,
  newValue: string | boolean | readonly string[],
): string {
  const fm = parseFrontmatterEditable(text);
  if (fm === null) {
    return text;
  }
  const prop = fm.properties[index];
  if (prop === undefined || prop.kind === "complex") {
    return text;
  }

  if (prop.kind === "tags" || prop.kind === "list") {
    const items =
      typeof newValue === "boolean"
        ? [newValue ? "true" : "false"]
        : normalizePropertyInputItems(prop.key, newValue);
    if (prop.style === "block-list") {
      return replaceBlockListProperty(text, fm, prop, items);
    }
    if (prop.style === "flow-list") {
      return `${text.slice(0, prop.valueStart)}${formatFlowList(items)}${text.slice(prop.valueEnd)}`;
    }
    // Plain scalar tags line (e.g. `tags: test`): single tag stays plain scalar, multiple become flow list.
    const formatted =
      items.length === 0
        ? "[]"
        : items.length === 1
          ? formatYamlScalar(items[0])
          : formatFlowList(items);
    return replaceScalarSpan(text, prop, formatted);
  }

  if (prop.kind === "boolean") {
    if (typeof newValue === "boolean") {
      return replaceScalarSpan(text, prop, newValue ? "true" : "false");
    }
    if (typeof newValue === "string") {
      const trimmed = newValue.trim();
      if (/^(true|false)$/i.test(trimmed)) {
        return replaceScalarSpan(text, prop, trimmed.toLowerCase());
      }
      return replaceScalarSpan(text, prop, trimmed === "" ? "" : formatYamlScalar(newValue));
    }
    return replaceScalarSpan(text, prop, formatFlowList(newValue));
  }

  // `text` property
  if (typeof newValue === "boolean") {
    return replaceScalarSpan(text, prop, newValue ? "true" : "false");
  }
  if (typeof newValue !== "string") {
    return replaceScalarSpan(text, prop, formatFlowList(newValue));
  }
  return replaceScalarSpan(text, prop, newValue === "" ? "" : formatYamlScalar(newValue));
}

/**
 * Updates the note's tags property (preserving flow/block list style), or adds `tags: [...]` if
 * none exists. Strips leading `#` and deduplicates case-insensitively.
 */
export function setFrontmatterTags(text: string, tags: readonly string[]): string {
  const cleaned = dedupeTags(tags);
  const fm = parseFrontmatterEditable(text);
  if (fm !== null) {
    const existingIndex = fm.properties.findIndex((prop) => isTagKey(prop.key));
    if (existingIndex !== -1) {
      if (fm.properties[existingIndex].kind === "complex") {
        return text;
      }
      return setFrontmatterProperty(text, existingIndex, cleaned);
    }
  }
  if (cleaned.length === 0) {
    return text;
  }
  return addFrontmatterProperty(text, "tags", cleaned);
}

/**
 * Removes the property at `index`. If it was the last property and no comments or other content
 * remain in the frontmatter block, removes the empty frontmatter block and its blank separator line.
 */
export function deleteFrontmatterProperty(text: string, index: number): string {
  const fm = parseFrontmatterEditable(text);
  if (fm === null) {
    return text;
  }
  const prop = fm.properties[index];
  if (prop === undefined) {
    return text;
  }

  let deleteEnd = prop.blockEnd;
  if (text.startsWith("\r\n", deleteEnd)) {
    deleteEnd += 2;
  } else if (text[deleteEnd] === "\n" || text[deleteEnd] === "\r") {
    deleteEnd += 1;
  }

  const nextText = `${text.slice(0, prop.blockStart)}${text.slice(deleteEnd)}`;
  if (fm.properties.length === 1 && !fm.hasComments) {
    const updated = parseFrontmatterEditable(nextText);
    if (
      updated !== null &&
      updated.properties.length === 0 &&
      !updated.hasComments &&
      nextText.slice(updated.openEnd, updated.closeStart).trim() === ""
    ) {
      return `${updated.bom ? "\uFEFF" : ""}${nextText.slice(updated.bodyStart)}`;
    }
  }
  return nextText;
}
