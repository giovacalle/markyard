// The signed-in session and the sign-in state, as they travel inside sealed cookies.
// The JSON shape mirrors the Rust serde structs: field order `rt, at, exp, email`, absent
// optional fields omitted, unknown fields ignored, and a wrong type rejects the whole value.
// `name` (the Google account display name) was added after the port; it follows `email` and is
// optional, so cookies sealed before it existed still decode. `rootFolderId` (the account's own
// vault folder) follows `name` the same way.

import { isValidId } from "./drive.ts";

export const SESSION_COOKIE = "__Host-s";
export const STATE_COOKIE = "__Host-state";
/** The longest display name a session keeps; longer ones are cut. */
export const MAX_NAME_LENGTH = 200;
/** Browsers cap one cookie's `name=value` at 4096 bytes. */
export const MAX_COOKIE_NAME_VALUE_BYTES = 4096;

export interface Session {
  readonly rt: string;
  readonly at?: string | undefined;
  readonly exp?: number | undefined;
  readonly email: string;
  /** The account display name, when Google gave a non-blank one. */
  readonly name?: string | undefined;
  /** The vault folder this account picked; the instance `ROOT_FOLDER_ID` applies without one. */
  readonly rootFolderId?: string | undefined;
}

export interface SignInState {
  readonly state: string;
  readonly verifier: string;
}

type Json = Record<string, unknown>;

const isObject = (u: unknown): u is Json =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/** A JSON number serde accepts as `u64`. */
export const isU64 = (u: unknown): u is number =>
  typeof u === "number" && Number.isSafeInteger(u) && u >= 0;

/** serde `Option<T>`: a missing key or `null` is `None`; anything else must be a `T`. */
const optional = <T>(
  obj: Json,
  key: string,
  guard: (u: unknown) => u is T,
): { ok: true; value: T | undefined } | { ok: false } => {
  const v = obj[key];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  return guard(v) ? { ok: true, value: v } : { ok: false };
};

const isString = (u: unknown): u is string => typeof u === "string";

/** A display name trimmed and capped, or `undefined` when it is not a non-blank string. */
export const normalizeName = (u: unknown): string | undefined => {
  if (!isString(u)) return undefined;
  const name = Array.from(u.trim()).slice(0, MAX_NAME_LENGTH).join("").trim();
  return name === "" ? undefined : name;
};

/** Parses JSON text, answering `undefined` instead of throwing. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export const encodeSession = (session: Session): string => {
  const out: Json = { rt: session.rt };
  if (session.at !== undefined) out["at"] = session.at;
  if (session.exp !== undefined) out["exp"] = session.exp;
  out["email"] = session.email;
  const name = normalizeName(session.name);
  if (name !== undefined) out["name"] = name;
  if (session.rootFolderId !== undefined && isValidId(session.rootFolderId))
    out["rootFolderId"] = session.rootFolderId;
  return JSON.stringify(out);
};

export const decodeSession = (json: unknown): Session | undefined => {
  if (!isObject(json) || !isString(json["rt"]) || !isString(json["email"])) return undefined;
  const at = optional(json, "at", isString);
  const exp = optional(json, "exp", isU64);
  const name = optional(json, "name", isString);
  const root = optional(json, "rootFolderId", isString);
  if (!at.ok || !exp.ok || !name.ok || !root.ok) return undefined;
  return {
    rt: json["rt"],
    at: at.value,
    exp: exp.value,
    email: json["email"],
    name: normalizeName(name.value),
    // A malformed id is dropped (the account falls back to the instance root), not fatal.
    rootFolderId: root.value !== undefined && isValidId(root.value) ? root.value : undefined,
  };
};

export const encodeSignInState = (value: SignInState): string =>
  JSON.stringify({ state: value.state, verifier: value.verifier });

export const decodeSignInState = (json: unknown): SignInState | undefined =>
  isObject(json) && isString(json["state"]) && isString(json["verifier"])
    ? { state: json["state"], verifier: json["verifier"] }
    : undefined;

/** The value of cookie `name` in a `Cookie` header, as Rust `cookie_value` finds it. */
export const cookieValue = (header: string | null, name: string): string | undefined => {
  if (header === null) return undefined;
  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
};
