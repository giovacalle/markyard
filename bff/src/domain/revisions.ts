// Drive version history rules that need no I/O: decoding Drive v3 `revisions.list` and
// `revisions.get`, and the newest-first revision list the web app reads.

type Json = Record<string, unknown>;
const isObject = (u: unknown): u is Json =>
  typeof u === "object" && u !== null && !Array.isArray(u);
const isString = (u: unknown): u is string => typeof u === "string";

/** Drive v3 int64 fields (`size`) are decimal strings. */
const decodeSize = (u: unknown): number | undefined | null => {
  if (u === undefined || u === null) return undefined;
  if (!isString(u) || !/^[0-9]{1,15}$/.test(u)) return null;
  return Number(u);
};

/** What the web app sees of one revision. Key order is the wire order; absent keys are omitted. */
export interface Revision {
  readonly id: string;
  readonly modifiedTime: string;
  readonly size?: number;
  /** The display name of whoever saved it, or their email when Drive has no name. */
  readonly author?: string;
  readonly keepForever: boolean;
}

const decodeAuthor = (u: unknown): string | undefined | null => {
  if (u === undefined || u === null) return undefined;
  if (!isObject(u)) return null;
  const { displayName, emailAddress } = u;
  if (isString(displayName) && displayName !== "") return displayName;
  if (isString(emailAddress) && emailAddress !== "") return emailAddress;
  return undefined;
};

export const decodeRevision = (json: unknown): Revision | undefined => {
  if (!isObject(json)) return undefined;
  const { id, modifiedTime } = json;
  if (!isString(id) || !isString(modifiedTime)) return undefined;
  const size = decodeSize(json["size"]);
  const author = decodeAuthor(json["lastModifyingUser"]);
  const keepForever = json["keepForever"] ?? false;
  if (size === null || author === null || typeof keepForever !== "boolean") return undefined;
  return {
    id,
    modifiedTime,
    ...(size === undefined ? {} : { size }),
    ...(author === undefined ? {} : { author }),
    keepForever,
  };
};

export interface RevisionPage {
  readonly revisions: ReadonlyArray<Revision>;
  readonly nextPageToken: string | undefined;
}

export const decodeRevisionPage = (json: unknown): RevisionPage | undefined => {
  if (!isObject(json)) return undefined;
  const raw = json["revisions"] ?? [];
  if (!Array.isArray(raw)) return undefined;
  const revisions: Array<Revision> = [];
  for (const item of raw) {
    const revision = decodeRevision(item);
    if (revision === undefined) return undefined;
    revisions.push(revision);
  }
  const token = json["nextPageToken"];
  if (token !== undefined && token !== null && !isString(token)) return undefined;
  return { revisions, nextPageToken: token ?? undefined };
};

/** What `revisions.get` answers about one revision before its bytes are fetched. */
export interface RevisionMeta {
  readonly id: string;
  /** Bytes; `undefined` for revisions Drive cannot download (Google Docs). */
  readonly size: number | undefined;
}

export const decodeRevisionMeta = (json: unknown): RevisionMeta | undefined => {
  if (!isObject(json) || !isString(json["id"])) return undefined;
  const size = decodeSize(json["size"]);
  return size === null ? undefined : { id: json["id"], size };
};

const timeOf = (revision: Revision): number => {
  const t = Date.parse(revision.modifiedTime);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** Newest first; revisions saved at the same instant keep Drive's order. */
export const newestFirst = (revisions: ReadonlyArray<Revision>): Array<Revision> =>
  revisions
    .map((revision, index) => ({ revision, index }))
    .sort((a, b) => timeOf(b.revision) - timeOf(a.revision) || a.index - b.index)
    .map(({ revision }) => revision);
