import { frontmatterTags, parseFrontmatter } from "./frontmatter";
import { parseTasks } from "./tasks";
import type { VaultDocument } from "./vaultDocuments";
import { maskInlineCode, noteStem, sourceLines } from "./wikilinks";

export type QueryType = "notes" | "tasks";

export type QueryView =
  | { kind: "list" }
  | { kind: "table"; columns: string[] }
  | { kind: "tasks" }
  | { kind: "count" };

export interface QuerySort {
  field: string;
  direction: "asc" | "desc";
}

export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains";

export type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "relativeDate"; offset: number; unit: "d" | "w" | "m" };

export type WhereExpr =
  | { kind: "or"; left: WhereExpr; right: WhereExpr }
  | { kind: "and"; left: WhereExpr; right: WhereExpr }
  | { kind: "not"; operand: WhereExpr }
  | { kind: "tag"; tag: string }
  | { kind: "truthy"; field: string }
  | { kind: "compare"; field: string; op: CompareOp; value: LiteralValue };

export interface QuerySpec {
  type: QueryType;
  /** Normalized folder prefix without leading/trailing slashes; `""` means root only. */
  from?: string;
  where?: WhereExpr;
  sort?: QuerySort;
  limit?: number;
  view: QueryView;
}

export type ParseQueryResult = { ok: true; query: QuerySpec } | { ok: false; error: string };

export type FieldValue = string | number | boolean | readonly string[] | undefined;

export interface NoteQueryRow {
  kind: "note";
  id: string;
  name: string;
  title: string;
  folder: string;
  path: string;
  modified: string;
  tags: readonly string[];
  getField: (name: string) => FieldValue;
}

export interface TaskQueryRow {
  kind: "task";
  id: string;
  name: string;
  title: string;
  folder: string;
  path: string;
  modified: string;
  text: string;
  done: boolean;
  due?: string;
  line: number;
  offset: number;
  tags: readonly string[];
  getField: (name: string) => FieldValue;
}

export type QueryResult =
  | { type: "notes"; view: QueryView; rows: NoteQueryRow[]; totalMatched: number }
  | { type: "tasks"; view: QueryView; rows: TaskQueryRow[]; totalMatched: number };

const ALLOWED_KEYS = new Set(["type", "from", "where", "sort", "limit", "view"]);
const IDENTIFIER_RE = /^[A-Za-z_][\w.-]*$/;
const RELATIVE_DATE_RE = /^today(?:([+-])(\d+)([dwm]))?$/i;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/;
const INLINE_TAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const HAS_LETTER_RE = /\p{L}/u;
const RESERVED_WORDS = new Set(["and", "or", "not", "contains"]);

const MAX_TOKENS = 512;
const MAX_EXPR_DEPTH = 32;

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
  }
  return trimmed;
}

type Token =
  | { kind: "lparen"; pos: number }
  | { kind: "rparen"; pos: number }
  | { kind: "op"; value: Exclude<CompareOp, "contains">; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "tag"; value: string; pos: number }
  | { kind: "word"; value: string; pos: number };

type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; error: string };

function tokenizeWhere(input: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (tokens.length >= MAX_TOKENS) {
      return { ok: false, error: "Where expression is too long." };
    }
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", pos: i });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", pos: i });
      i += 1;
      continue;
    }
    if (ch === "=") {
      if (input[i + 1] === "=") {
        return { ok: false, error: 'Unexpected "==" in where clause. Use "=" for equality.' };
      }
      tokens.push({ kind: "op", value: "=", pos: i });
      i += 1;
      continue;
    }
    if (ch === "!") {
      if (input[i + 1] !== "=") {
        return { ok: false, error: 'Unexpected "!" in where clause. Use "NOT" or "!=".' };
      }
      tokens.push({ kind: "op", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (ch === "<" || ch === ">") {
      if (input[i + 1] === "=") {
        tokens.push({ kind: "op", value: ch === "<" ? "<=" : ">=", pos: i });
        i += 2;
      } else {
        tokens.push({ kind: "op", value: ch, pos: i });
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i += 1;
      let out = "";
      let closed = false;
      while (i < input.length) {
        const cur = input[i];
        if (quote === '"' && cur === "\\" && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === "n") out += "\n";
          else if (next === "t") out += "\t";
          else out += next;
          i += 2;
          continue;
        }
        if (quote === "'" && cur === "'" && input[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        if (quote === "'" && cur === "\\" && i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        if (cur === quote) {
          closed = true;
          i += 1;
          break;
        }
        out += cur;
        i += 1;
      }
      if (!closed) {
        return { ok: false, error: `Unterminated string literal at position ${start + 1}.` };
      }
      tokens.push({ kind: "string", value: out, pos: start });
      continue;
    }
    if (ch === "#") {
      const start = i;
      i += 1;
      const bodyStart = i;
      while (i < input.length && /[\p{L}\p{N}_/-]/u.test(input[i])) {
        i += 1;
      }
      const tag = input.slice(bodyStart, i);
      if (tag.length === 0 || !/^[\p{L}\p{N}_]/u.test(tag)) {
        return { ok: false, error: `Invalid tag at position ${start + 1}.` };
      }
      tokens.push({ kind: "tag", value: tag.toLowerCase(), pos: start });
      continue;
    }

    const start = i;
    while (i < input.length && !/[\s()=!<>"']/.test(input[i])) {
      i += 1;
    }
    tokens.push({ kind: "word", value: input.slice(start, i), pos: start });
  }
  return { ok: true, tokens };
}

type ParseWhereResult = { ok: true; expr: WhereExpr } | { ok: false; error: string };

/** Parses a non-Turing-complete `where` boolean expression with bounded recursion depth. */
export function parseWhere(input: string): ParseWhereResult {
  const lexed = tokenizeWhere(input);
  if (!lexed.ok) {
    return lexed;
  }
  const { tokens } = lexed;
  if (tokens.length === 0) {
    return { ok: false, error: 'Missing expression for "where".' };
  }

  let index = 0;

  const peek = (): Token | undefined => tokens[index];
  const consume = (): Token | undefined => {
    const token = tokens[index];
    if (token !== undefined) {
      index += 1;
    }
    return token;
  };

  const isKeyword = (token: Token | undefined, word: string): boolean =>
    token !== undefined && token.kind === "word" && token.value.toLowerCase() === word;

  const parseOr = (depth: number): ParseWhereResult => {
    if (depth > MAX_EXPR_DEPTH) {
      return { ok: false, error: "Where expression is too deeply nested." };
    }
    const leftRes = parseAnd(depth + 1);
    if (!leftRes.ok) return leftRes;
    let expr = leftRes.expr;
    while (isKeyword(peek(), "or")) {
      consume();
      const rightRes = parseAnd(depth + 1);
      if (!rightRes.ok) return rightRes;
      expr = { kind: "or", left: expr, right: rightRes.expr };
    }
    return { ok: true, expr };
  };

  const parseAnd = (depth: number): ParseWhereResult => {
    if (depth > MAX_EXPR_DEPTH) {
      return { ok: false, error: "Where expression is too deeply nested." };
    }
    const leftRes = parseNot(depth + 1);
    if (!leftRes.ok) return leftRes;
    let expr = leftRes.expr;
    while (isKeyword(peek(), "and")) {
      consume();
      const rightRes = parseNot(depth + 1);
      if (!rightRes.ok) return rightRes;
      expr = { kind: "and", left: expr, right: rightRes.expr };
    }
    return { ok: true, expr };
  };

  const parseNot = (depth: number): ParseWhereResult => {
    if (depth > MAX_EXPR_DEPTH) {
      return { ok: false, error: "Where expression is too deeply nested." };
    }
    if (isKeyword(peek(), "not")) {
      consume();
      const operand = parseNot(depth + 1);
      if (!operand.ok) return operand;
      return { ok: true, expr: { kind: "not", operand: operand.expr } };
    }
    return parsePrimary(depth + 1);
  };

  const parseLiteral = (
    op: CompareOp,
  ): { ok: true; value: LiteralValue } | { ok: false; error: string } => {
    const tok = consume();
    if (tok === undefined) {
      return { ok: false, error: `Expected a value after "${op}".` };
    }
    if (tok.kind === "string") {
      return { ok: true, value: { kind: "string", value: tok.value } };
    }
    if (tok.kind === "tag") {
      return { ok: true, value: { kind: "string", value: tok.value } };
    }
    if (tok.kind !== "word") {
      return { ok: false, error: `Expected a value after "${op}".` };
    }
    const lower = tok.value.toLowerCase();
    if (RESERVED_WORDS.has(lower)) {
      return { ok: false, error: `Expected a value after "${op}", found "${tok.value}".` };
    }
    const rel = RELATIVE_DATE_RE.exec(tok.value);
    if (rel !== null) {
      const sign = rel[1] === "-" ? -1 : 1;
      const amount = rel[2] === undefined ? 0 : Number.parseInt(rel[2], 10);
      const unit = (rel[3]?.toLowerCase() ?? "d") as "d" | "w" | "m";
      return { ok: true, value: { kind: "relativeDate", offset: sign * amount, unit } };
    }
    if (lower === "true") {
      return { ok: true, value: { kind: "boolean", value: true } };
    }
    if (lower === "false") {
      return { ok: true, value: { kind: "boolean", value: false } };
    }
    if (NUMBER_RE.test(tok.value)) {
      const num = Number(tok.value);
      if (Number.isFinite(num)) {
        return { ok: true, value: { kind: "number", value: num } };
      }
    }
    return { ok: true, value: { kind: "string", value: tok.value } };
  };

  const parsePrimary = (depth: number): ParseWhereResult => {
    if (depth > MAX_EXPR_DEPTH) {
      return { ok: false, error: "Where expression is too deeply nested." };
    }
    const tok = peek();
    if (tok === undefined) {
      return { ok: false, error: "Unexpected end of where expression." };
    }
    if (tok.kind === "lparen") {
      consume();
      const inner = parseOr(depth + 1);
      if (!inner.ok) return inner;
      const close = consume();
      if (close?.kind !== "rparen") {
        return { ok: false, error: 'Missing closing ")" in where expression.' };
      }
      return inner;
    }
    if (tok.kind === "tag") {
      consume();
      return { ok: true, expr: { kind: "tag", tag: tok.value } };
    }
    if (tok.kind === "word") {
      const lower = tok.value.toLowerCase();
      if (RESERVED_WORDS.has(lower)) {
        return { ok: false, error: `Unexpected keyword "${tok.value}" in where expression.` };
      }
      if (!IDENTIFIER_RE.test(tok.value)) {
        return { ok: false, error: `Invalid field name "${tok.value}" in where expression.` };
      }
      consume();
      const field = tok.value;
      const next = peek();
      if (next?.kind === "op") {
        consume();
        const val = parseLiteral(next.value);
        if (!val.ok) return val;
        return { ok: true, expr: { kind: "compare", field, op: next.value, value: val.value } };
      }
      if (isKeyword(next, "contains")) {
        consume();
        const val = parseLiteral("contains");
        if (!val.ok) return val;
        return { ok: true, expr: { kind: "compare", field, op: "contains", value: val.value } };
      }
      return { ok: true, expr: { kind: "truthy", field } };
    }
    if (tok.kind === "rparen") {
      return { ok: false, error: 'Unexpected ")" in where expression.' };
    }
    if (tok.kind === "op") {
      return { ok: false, error: `Unexpected operator "${tok.value}" in where expression.` };
    }
    return { ok: false, error: `Unexpected string "${tok.value}" in where expression.` };
  };

  const result = parseOr(0);
  if (!result.ok) {
    return result;
  }
  const leftover = peek();
  if (leftover !== undefined) {
    const label =
      leftover.kind === "lparen"
        ? "("
        : leftover.kind === "rparen"
          ? ")"
          : leftover.kind === "tag"
            ? `#${leftover.value}`
            : leftover.value;
    return { ok: false, error: `Unexpected token "${label}" in where expression.` };
  }
  return result;
}

function parseView(raw: string): { ok: true; view: QueryView } | { ok: false; error: string } {
  const value = stripQuotes(raw);
  const lower = value.toLowerCase();
  if (lower === "list") return { ok: true, view: { kind: "list" } };
  if (lower === "tasks") return { ok: true, view: { kind: "tasks" } };
  if (lower === "count") return { ok: true, view: { kind: "count" } };

  const tableMatch = /^table\s*\((.*)\)$/i.exec(value);
  if (tableMatch !== null) {
    const inner = tableMatch[1].trim();
    if (inner.length === 0) {
      return { ok: false, error: 'Invalid view: "table()" requires at least one column.' };
    }
    const columns: string[] = [];
    for (const part of inner.split(",")) {
      const col = stripQuotes(part);
      if (col.length === 0) {
        return { ok: false, error: "Invalid view: empty column name in table(...)." };
      }
      if (!IDENTIFIER_RE.test(col)) {
        return { ok: false, error: `Invalid table column "${col}".` };
      }
      columns.push(col);
    }
    return { ok: true, view: { kind: "table", columns } };
  }

  return {
    ok: false,
    error: `Invalid view "${value}". Expected "list", "table(col1, col2)", "tasks", or "count".`,
  };
}

function parseSort(raw: string): { ok: true; sort: QuerySort } | { ok: false; error: string } {
  const value = stripQuotes(raw);
  const parts = value.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 2) {
    return { ok: false, error: `Invalid sort "${value}". Expected "<field> [asc|desc]".` };
  }
  const [field, dirRaw] = parts;
  if (!IDENTIFIER_RE.test(field)) {
    return { ok: false, error: `Invalid sort field "${field}".` };
  }
  if (dirRaw === undefined) {
    return { ok: true, sort: { field, direction: "asc" } };
  }
  const dir = dirRaw.toLowerCase();
  if (dir !== "asc" && dir !== "desc") {
    return { ok: false, error: `Invalid sort direction "${dirRaw}". Expected "asc" or "desc".` };
  }
  return { ok: true, sort: { field, direction: dir } };
}

/** Parses a YAML-structured `query` code block into a validated `QuerySpec`. Never throws. */
export function parseQuery(source: string): ParseQueryResult {
  const seen = new Map<string, string>();
  const lines = source.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const trimmed = lines[idx].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      return { ok: false, error: `Invalid line ${idx + 1}: expected "key: value".` };
    }
    const rawKey = trimmed.slice(0, colon).trim();
    const key = rawKey.toLowerCase();
    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        error: `Unknown key "${rawKey}". Supported keys: type, from, where, sort, limit, view.`,
      };
    }
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate key "${rawKey}".` };
    }
    const rawValue = trimmed.slice(colon + 1).trim();
    seen.set(key, rawValue);
  }

  let type: QueryType = "notes";
  const typeRaw = seen.get("type");
  if (typeRaw !== undefined) {
    const val = stripQuotes(typeRaw).toLowerCase();
    if (val !== "notes" && val !== "tasks") {
      return {
        ok: false,
        error: `Invalid type "${stripQuotes(typeRaw)}". Expected "notes" or "tasks".`,
      };
    }
    type = val;
  }

  let from: string | undefined;
  const fromRaw = seen.get("from");
  if (fromRaw !== undefined) {
    if (fromRaw.length === 0) {
      return { ok: false, error: 'Missing value for "from". Use "" or "/" for the root folder.' };
    }
    const unquoted = stripQuotes(fromRaw);
    from = unquoted.replace(/^\/+|\/+$/g, "");
  }

  let where: WhereExpr | undefined;
  const whereRaw = seen.get("where");
  if (whereRaw !== undefined) {
    const parsedWhere = parseWhere(whereRaw);
    if (!parsedWhere.ok) {
      return parsedWhere;
    }
    where = parsedWhere.expr;
  }

  let sort: QuerySort | undefined;
  const sortRaw = seen.get("sort");
  if (sortRaw !== undefined) {
    const parsedSort = parseSort(sortRaw);
    if (!parsedSort.ok) {
      return parsedSort;
    }
    sort = parsedSort.sort;
  }

  let limit: number | undefined;
  const limitRaw = seen.get("limit");
  if (limitRaw !== undefined) {
    const unquoted = stripQuotes(limitRaw);
    if (!/^[1-9]\d*$/.test(unquoted)) {
      return { ok: false, error: `Invalid limit "${unquoted}". Expected a positive integer.` };
    }
    const parsedLimit = Number.parseInt(unquoted, 10);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) {
      return { ok: false, error: `Invalid limit "${unquoted}". Expected a positive integer.` };
    }
    limit = parsedLimit;
  }

  let view: QueryView = type === "tasks" ? { kind: "tasks" } : { kind: "list" };
  const viewRaw = seen.get("view");
  if (viewRaw !== undefined) {
    const parsedView = parseView(viewRaw);
    if (!parsedView.ok) {
      return parsedView;
    }
    if (parsedView.view.kind === "tasks" && type !== "tasks") {
      return { ok: false, error: 'View "tasks" requires "type: tasks".' };
    }
    view = parsedView.view;
  }

  return { ok: true, query: { type, from, where, sort, limit, view } };
}

/** Resolves `today±Nd/w/m` against a local calendar date `now` into `YYYY-MM-DD`. */
export function resolveRelativeDate(now: Date, offset: number, unit: "d" | "w" | "m"): string {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  let date: Date;
  if (unit === "d") {
    date = new Date(year, month, day + offset);
  } else if (unit === "w") {
    date = new Date(year, month, day + offset * 7);
  } else {
    const targetMonth = month + offset;
    const lastDay = new Date(year, targetMonth + 1, 0).getDate();
    date = new Date(year, targetMonth, Math.min(day, lastDay));
  }
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function extractBodyTags(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of sourceLines(body)) {
    if (line.inFence || !line.text.includes("#")) {
      continue;
    }
    const masked = maskInlineCode(line.text);
    for (const match of masked.matchAll(INLINE_TAG_RE)) {
      const raw = match[1];
      const lower = raw.toLowerCase();
      if (HAS_LETTER_RE.test(lower) && !seen.has(lower)) {
        seen.add(lower);
        out.push(raw);
      }
    }
  }
  return out;
}

function mergeTags(primary: readonly string[], secondary: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [primary, secondary]) {
    for (const tag of list) {
      const lower = tag.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.push(tag);
      }
    }
  }
  return out;
}

function parseFiniteNumber(value: FieldValue): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (NUMBER_RE.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function parseBooleanValue(value: FieldValue): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return null;
}

function extractIsoDate(value: FieldValue): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = ISO_DATE_PREFIX_RE.exec(value.trim());
  return match ? match[1] : null;
}

function isTruthyField(value: FieldValue): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower !== "" && lower !== "false" && lower !== "null" && lower !== "~";
  }
  return value.length > 0;
}

function isEmptyLiteral(literal: LiteralValue): boolean {
  return literal.kind === "string" && literal.value === "";
}

function evalCompare(
  fieldValue: FieldValue,
  op: CompareOp,
  literal: LiteralValue,
  now: Date,
): boolean {
  const rhsDate =
    literal.kind === "relativeDate"
      ? resolveRelativeDate(now, literal.offset, literal.unit)
      : literal.kind === "string" && ISO_DATE_RE.test(literal.value)
        ? literal.value
        : null;

  const rhsString =
    literal.kind === "relativeDate"
      ? resolveRelativeDate(now, literal.offset, literal.unit)
      : String(literal.value);

  if (fieldValue === undefined) {
    if (op === "!=") {
      return !isEmptyLiteral(literal);
    }
    return false;
  }

  if (op === "contains") {
    const needle = rhsString.toLowerCase();
    if (Array.isArray(fieldValue)) {
      return fieldValue.some((item) => item.toLowerCase().includes(needle));
    }
    if (typeof fieldValue === "string") {
      return fieldValue.toLowerCase().includes(needle);
    }
    return String(fieldValue).toLowerCase().includes(needle);
  }

  if (op === "=" || op === "!=") {
    let eq: boolean;
    if (Array.isArray(fieldValue)) {
      const needle = rhsString.toLowerCase();
      eq = fieldValue.some((item) => item.toLowerCase() === needle);
    } else if (literal.kind === "boolean") {
      const lhsBool = parseBooleanValue(fieldValue);
      eq = lhsBool !== null && lhsBool === literal.value;
    } else if (literal.kind === "number") {
      const lhsNum = parseFiniteNumber(fieldValue);
      eq = lhsNum !== null && lhsNum === literal.value;
    } else if (rhsDate !== null) {
      const lhsDate = extractIsoDate(fieldValue);
      eq = lhsDate !== null ? lhsDate === rhsDate : String(fieldValue).toLowerCase() === rhsDate;
    } else {
      eq = String(fieldValue).toLowerCase() === rhsString.toLowerCase();
    }
    return op === "=" ? eq : !eq;
  }

  // Ordering operators: <, <=, >, >=
  if (Array.isArray(fieldValue) || fieldValue === "") {
    return false;
  }

  let cmp: number;
  const lhsNum = parseFiniteNumber(fieldValue);
  const rhsNum =
    literal.kind === "number"
      ? literal.value
      : literal.kind === "string"
        ? parseFiniteNumber(literal.value)
        : null;

  if (lhsNum !== null && rhsNum !== null) {
    cmp = lhsNum - rhsNum;
  } else if (rhsDate !== null) {
    const lhsDate = extractIsoDate(fieldValue);
    if (lhsDate === null) {
      return false;
    }
    cmp = lhsDate < rhsDate ? -1 : lhsDate > rhsDate ? 1 : 0;
  } else {
    const lhsStr = String(fieldValue).toLowerCase();
    const rhsLower = rhsString.toLowerCase();
    cmp = lhsStr < rhsLower ? -1 : lhsStr > rhsLower ? 1 : 0;
  }

  switch (op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
  }
}

interface EvalContext {
  getField: (name: string) => FieldValue;
  hasTag: (tagLower: string) => boolean;
  now: Date;
}

function evalWhere(expr: WhereExpr, ctx: EvalContext): boolean {
  switch (expr.kind) {
    case "or":
      return evalWhere(expr.left, ctx) || evalWhere(expr.right, ctx);
    case "and":
      return evalWhere(expr.left, ctx) && evalWhere(expr.right, ctx);
    case "not":
      return !evalWhere(expr.operand, ctx);
    case "tag":
      return ctx.hasTag(expr.tag);
    case "truthy":
      return isTruthyField(ctx.getField(expr.field));
    case "compare":
      return evalCompare(ctx.getField(expr.field), expr.op, expr.value, ctx.now);
  }
}

function matchesFrom(path: readonly string[], from: string | undefined): boolean {
  if (from === undefined) {
    return true;
  }
  const folder = path.join("/").toLowerCase();
  const target = from.toLowerCase();
  return target === "" ? folder === "" : folder === target || folder.startsWith(`${target}/`);
}

function isMissingForSort(value: FieldValue): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function compareSortValues(a: FieldValue, b: FieldValue, direction: "asc" | "desc"): number {
  const aMissing = isMissingForSort(a);
  const bMissing = isMissingForSort(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  let cmp: number;
  const aNum = parseFiniteNumber(a);
  const bNum = parseFiniteNumber(b);
  if (aNum !== null && bNum !== null) {
    cmp = aNum - bNum;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    cmp = Number(a) - Number(b);
  } else {
    const aStr = Array.isArray(a) ? a.join(", ") : String(a);
    const bStr = Array.isArray(b) ? b.join(", ") : String(b);
    const aIsIso = ISO_DATE_PREFIX_RE.test(aStr);
    const bIsIso = ISO_DATE_PREFIX_RE.test(bStr);
    if (aIsIso && bIsIso) {
      cmp = aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    } else {
      cmp = aStr.localeCompare(bStr, undefined, { sensitivity: "base" });
    }
  }
  return direction === "desc" ? -cmp : cmp;
}

interface PreparedNote {
  doc: VaultDocument;
  title: string;
  folder: string;
  path: string;
  modified: string;
  tags: string[];
  tagSet: Set<string>;
  frontmatter: Map<string, string | string[]>;
  body: string;
}

function prepareNote(doc: VaultDocument): PreparedNote {
  const title = noteStem(doc.name);
  const folder = doc.path.join("/");
  const path = folder.length > 0 ? `${folder}/${title}` : title;
  const modified = doc.modifiedTime ?? "";
  const fm = parseFrontmatter(doc.text);
  const frontmatter = new Map<string, string | string[]>();
  if (fm !== null) {
    for (const prop of fm.properties) {
      frontmatter.set(prop.key.toLowerCase(), prop.value);
    }
  }
  const body = fm === null ? doc.text : doc.text.slice(fm.end);
  const tags = mergeTags(frontmatterTags(fm), extractBodyTags(body));
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  return { doc, title, folder, path, modified, tags, tagSet, frontmatter, body };
}

function noteFieldLookup(note: PreparedNote): (name: string) => FieldValue {
  return (name: string): FieldValue => {
    const key = name.toLowerCase();
    switch (key) {
      case "title":
        return note.title;
      case "name":
        return note.doc.name;
      case "folder":
        return note.folder;
      case "path":
        return note.path;
      case "modified":
        return note.modified;
      case "tags":
        return note.tags;
      default:
        return note.frontmatter.get(key);
    }
  };
}

/** Evaluates a parsed `QuerySpec` against locally cached vault documents. */
export function executeQuery(
  query: QuerySpec,
  docs: readonly VaultDocument[],
  now: Date = new Date(),
): QueryResult {
  const inScope = docs.filter((doc) => matchesFrom(doc.path, query.from)).map(prepareNote);

  if (query.type === "notes") {
    const rows: NoteQueryRow[] = [];
    for (const note of inScope) {
      const getField = noteFieldLookup(note);
      if (
        query.where !== undefined &&
        !evalWhere(query.where, {
          getField,
          hasTag: (tagLower) => note.tagSet.has(tagLower),
          now,
        })
      ) {
        continue;
      }
      rows.push({
        kind: "note",
        id: note.doc.id,
        name: note.doc.name,
        title: note.title,
        folder: note.folder,
        path: note.path,
        modified: note.modified,
        tags: note.tags,
        getField,
      });
    }

    const explicitSort = query.sort;
    rows.sort((a, b) => {
      if (explicitSort !== undefined) {
        const cmp = compareSortValues(
          a.getField(explicitSort.field),
          b.getField(explicitSort.field),
          explicitSort.direction,
        );
        if (cmp !== 0) return cmp;
      } else {
        const modCmp = compareSortValues(a.modified, b.modified, "desc");
        if (modCmp !== 0) return modCmp;
      }
      return (
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
        a.path.localeCompare(b.path, undefined, { sensitivity: "base" })
      );
    });

    const totalMatched = rows.length;
    const limited = query.limit !== undefined ? rows.slice(0, query.limit) : rows;
    return { type: "notes", view: query.view, rows: limited, totalMatched };
  }

  const rows: TaskQueryRow[] = [];
  for (const note of inScope) {
    const parentLookup = noteFieldLookup(note);
    for (const task of parseTasks(note.doc.text)) {
      const taskTagSet = new Set(task.tags.map((t) => t.toLowerCase()));
      const getField = (name: string): FieldValue => {
        const key = name.toLowerCase();
        switch (key) {
          case "text":
            return task.text;
          case "done":
            return task.done;
          case "due":
            return task.due ?? "";
          case "line":
            return task.line;
          case "tags":
            return task.tags;
          default:
            return parentLookup(key);
        }
      };

      if (
        query.where !== undefined &&
        !evalWhere(query.where, {
          getField,
          hasTag: (tagLower) => taskTagSet.has(tagLower) || note.tagSet.has(tagLower),
          now,
        })
      ) {
        continue;
      }

      rows.push({
        kind: "task",
        id: note.doc.id,
        name: note.doc.name,
        title: note.title,
        folder: note.folder,
        path: note.path,
        modified: note.modified,
        text: task.text,
        done: task.done,
        due: task.due,
        line: task.line,
        offset: task.offset,
        tags: task.tags,
        getField,
      });
    }
  }

  const explicitSort = query.sort;
  rows.sort((a, b) => {
    if (explicitSort !== undefined) {
      const cmp = compareSortValues(
        a.getField(explicitSort.field),
        b.getField(explicitSort.field),
        explicitSort.direction,
      );
      if (cmp !== 0) return cmp;
    } else {
      const dueCmp = compareSortValues(a.due, b.due, "asc");
      if (dueCmp !== 0) return dueCmp;
    }
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.line - b.line;
  });

  const totalMatched = rows.length;
  const limited = query.limit !== undefined ? rows.slice(0, query.limit) : rows;
  return { type: "tasks", view: query.view, rows: limited, totalMatched };
}
