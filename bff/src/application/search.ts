// `GET /api/search?q=` use case (port of Rust `core/src/search.rs`): full-text and filename search
// scoped to the account's vault root folder.
//
// One deliberate improvement over Rust (ADR 0003): the parent-folder path of each result is
// resolved with bounded concurrency, and a folder shared by several results is fetched once per
// request. The answer stays the one Rust's sequential loop gives: results keep Drive's order, and
// when several walks fail, the failure of the earliest result wins, with only its response
// headers applied (each lookup records its `ResponseSink` writes and the winner's are replayed).

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  isLiveFile,
  isLiveFolder,
  isValidId,
  kindOf,
  parentId,
  toNode,
  type Node,
} from "../domain/drive.ts";
import {
  getFile,
  searchFiles,
  type DriveFailure,
  type DriveR,
} from "../infrastructure/drive-client.ts";
import { NotFound } from "../domain/errors.ts";
import { ResponseSink } from "./ports.ts";

export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 200;
export const MAX_FOLDER_DEPTH = 12;
/** How many parent-path walks run at once. */
export const PATH_CONCURRENCY = 4;

export interface SearchResult {
  readonly node: Node;
  readonly path: ReadonlyArray<string>;
}

export interface SearchResponse {
  readonly results: ReadonlyArray<SearchResult>;
}

/** Rust `char::is_whitespace` (Unicode `White_Space`), which `str::trim` strips. */
const RUST_WHITESPACE =
  "[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]";
const LEADING = new RegExp(`^${RUST_WHITESPACE}+`, "u");
const TRAILING = new RegExp(`${RUST_WHITESPACE}+$`, "u");

/** Rust `str::trim`: unlike JS `trim`, it strips U+0085 and keeps U+FEFF. */
export const rustTrim = (s: string): string => s.replace(LEADING, "").replace(TRAILING, "");

/**
 * The Drive query text of a raw `q`: trimmed and cut to `MAX_QUERY_CHARS` code points, or
 * `undefined` when shorter than `MIN_QUERY_CHARS` (no Drive call is made).
 */
export const queryTextOf = (rawQ: string): string | undefined => {
  const chars = Array.from(rustTrim(rawQ));
  return chars.length < MIN_QUERY_CHARS ? undefined : chars.slice(0, MAX_QUERY_CHARS).join("");
};

type Sink = ResponseSink["Service"];
type SinkWrite = (sink: Sink) => void;

/** A failed Drive call and the response headers it asked for. */
interface Failed {
  readonly failure: DriveFailure;
  readonly writes: ReadonlyArray<SinkWrite>;
}

interface FolderInfo {
  readonly name: string;
  readonly parentId: string | undefined;
}

/** A folder lookup: the folder, `undefined` when it is not a live folder, or a failure. */
type Lookup = { readonly folder: FolderInfo | undefined } | Failed;

/** A path walk: the segments from root down, `undefined` outside the root, or a failure. */
type Walk = { readonly path: ReadonlyArray<string> | undefined } | Failed;

/** A `ResponseSink` that only records, so a lookup's headers are applied only if it wins. */
const recordingSink = (writes: Array<SinkWrite>): Sink => ({
  setCookie: (cookie) => void writes.push((s) => s.setCookie(cookie)),
  refreshSession: (cookie) => void writes.push((s) => s.refreshSession(cookie)),
  setHeader: (name, value) => void writes.push((s) => s.setHeader(name, value)),
});

const fetchFolder = (accessToken: string, id: string): Effect.Effect<Lookup, never, DriveR> =>
  Effect.suspend(() => {
    const writes: Array<SinkWrite> = [];
    return getFile(accessToken, id).pipe(
      Effect.provideService(ResponseSink, recordingSink(writes)),
      Effect.match({
        onSuccess: (file): Lookup => ({
          folder: isLiveFolder(file) ? { name: file.name, parentId: parentId(file) } : undefined,
        }),
        onFailure: (failure): Lookup =>
          failure instanceof NotFound ? { folder: undefined } : { failure, writes },
      }),
    );
  });

/** Folder lookups memoized for one request: concurrent walks share one in-flight fetch. */
const folderLookups = (accessToken: string) => {
  const cache = new Map<string, Deferred.Deferred<Lookup>>();
  return (id: string): Effect.Effect<Lookup, never, DriveR> =>
    Effect.suspend(() => {
      const hit = cache.get(id);
      if (hit !== undefined) return Deferred.await(hit);
      const deferred = Deferred.makeUnsafe<Lookup>();
      cache.set(id, deferred);
      return fetchFolder(accessToken, id).pipe(
        Effect.onExit((exit) => Deferred.done(deferred, exit)),
      );
    });
};

/**
 * Walks parent folders up to `rootId`, returning the folder names from root down to
 * `startParentId`, or `undefined` if it does not descend from `rootId` within the depth limit.
 */
const resolvePathToRoot = (
  lookup: (id: string) => Effect.Effect<Lookup, never, DriveR>,
  rootId: string,
  startParentId: string,
): Effect.Effect<Walk, never, DriveR> =>
  Effect.gen(function* () {
    const segments: Array<string> = [];
    const visited = new Set<string>();
    let current = startParentId;
    for (let step = 0; step <= MAX_FOLDER_DEPTH; step++) {
      if (current === rootId) return { path: segments.reverse() };
      if (!isValidId(current) || visited.has(current)) return { path: undefined };
      visited.add(current);
      const found = yield* lookup(current);
      if ("failure" in found) return found;
      if (found.folder === undefined) return { path: undefined };
      segments.push(found.folder.name);
      if (found.folder.parentId === undefined) return { path: undefined };
      current = found.folder.parentId;
    }
    return { path: undefined };
  });

/** Searches Drive for Markdown notes inside the root folder, each with its folder path. */
export const search = (
  accessToken: string,
  rootFolderId: string,
  rawQ: string,
): Effect.Effect<SearchResponse, DriveFailure, DriveR> =>
  Effect.gen(function* () {
    const queryText = queryTextOf(rawQ);
    if (queryText === undefined) return { results: [] };

    const candidates = (yield* searchFiles(accessToken, queryText)).flatMap((file) => {
      const parent = parentId(file);
      return kindOf(file) === "markdown" && isLiveFile(file) && parent !== undefined
        ? [{ file, parent }]
        : [];
    });

    const lookup = folderLookups(accessToken);
    const walks = yield* Effect.forEach(
      candidates,
      ({ parent }) => resolvePathToRoot(lookup, rootFolderId, parent),
      { concurrency: PATH_CONCURRENCY },
    );

    const results: Array<SearchResult> = [];
    for (const [i, walk] of walks.entries()) {
      if ("failure" in walk) {
        const sink = yield* ResponseSink;
        for (const write of walk.writes) write(sink);
        return yield* Effect.fail(walk.failure);
      }
      if (walk.path !== undefined)
        results.push({ node: toNode(candidates[i]!.file), path: walk.path });
    }
    return { results };
  });
