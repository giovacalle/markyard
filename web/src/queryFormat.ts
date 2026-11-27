import type { QueryResult } from "./queryEngine";

const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T/;

/** Matches a fenced `query` code block, including indented, blockquoted, or list-nested fences. */
export const QUERY_FENCE_RE =
  /^[ \t]*(?:>[ \t]*|(?:[-*+]|\d+[.)])[ \t]+)*(?:`{3,}|~{3,})[ \t]*query(?:\s|$)/im;

export function hasQueryFence(text: string): boolean {
  return QUERY_FENCE_RE.test(text);
}

/** Formats an ISO timestamp string to `YYYY-MM-DD` for the `modified` column, leaving other values untouched. */
export function formatModifiedDate(value: string): string {
  const match = ISO_TIMESTAMP_RE.exec(value);
  return match !== null ? match[1] : value;
}

export function formatQueryCountLabel(type: QueryResult["type"], count: number): string {
  if (type === "notes") {
    return count === 1 ? "matching note" : "matching notes";
  }
  return count === 1 ? "matching task" : "matching tasks";
}

export function formatQueryFooter(
  result: QueryResult,
  cachedCount: number,
  totalKnownNotes: number,
): string {
  const known = Math.max(totalKnownNotes, cachedCount);
  const cacheLabel =
    known > cachedCount
      ? `${cachedCount} of ${known} notes cached`
      : `${cachedCount} ${cachedCount === 1 ? "cached note" : "cached notes"}`;
  if (result.view.kind === "count") {
    return cacheLabel;
  }
  const shown = result.rows.length;
  const resultLabel =
    result.totalMatched > shown
      ? `${shown} of ${result.totalMatched} results`
      : `${shown} ${shown === 1 ? "result" : "results"}`;
  return `${resultLabel} · ${cacheLabel}`;
}
