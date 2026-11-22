// The `StateStore` port on Cloudflare D1. The binding is duck-typed (no `@cloudflare/workers-types`,
// no `alchemy` import, ADR 0003): only `prepare().bind().first()/run()` is used.

import * as Effect from "effect/Effect";

import type { StateStoreService } from "../application/ports.ts";
import { asciiLower } from "../domain/drive.ts";
import { stateStoreUnreachable } from "../domain/errors.ts";
import { parseJson } from "../domain/session.ts";
import { decodeUserState, type StoredUserState, type UserState } from "../domain/state.ts";

export interface D1PreparedStatementLike {
  bind(...values: ReadonlyArray<unknown>): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS user_state (email TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)";
const SELECT_ROW = "SELECT state_json, updated_at FROM user_state WHERE email = ?1";
/** A write wins only when it is not older than the stored one, so devices converge. */
const UPSERT = `INSERT INTO user_state (email, state_json, updated_at)
VALUES (?1, ?2, ?3)
ON CONFLICT(email) DO UPDATE SET
  state_json = excluded.state_json,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= user_state.updated_at`;

interface Row {
  readonly state_json: unknown;
  readonly updated_at: unknown;
}

export const disabledStateStore: StateStoreService = {
  enabled: false,
  get: () => Effect.succeed(null),
  put: () => Effect.succeed(null),
};

const isD1 = (u: unknown): u is D1DatabaseLike =>
  typeof u === "object" && u !== null && typeof (u as D1DatabaseLike).prepare === "function";

/** The D1 store when `env.STATE_DB` is a D1 binding, else the disabled one. */
export const stateStoreFromEnv = (env: Readonly<Record<string, unknown>>): StateStoreService => {
  const binding = env["STATE_DB"];
  return isD1(binding) ? makeD1StateStore(binding) : disabledStateStore;
};

/** One table check per database per isolate; a failed one is retried by the next request. */
const ensured = new WeakMap<D1DatabaseLike, Promise<void>>();

const ensureTable = (db: D1DatabaseLike): Promise<void> => {
  const cached = ensured.get(db);
  if (cached !== undefined) return cached;
  const pending = db
    .prepare(CREATE_TABLE)
    .run()
    .then(
      () => undefined,
      (error: unknown) => {
        ensured.delete(db);
        throw error;
      },
    );
  ensured.set(db, pending);
  return pending;
};

/** A stored row as state; a corrupt one reads as no state. */
const decodeRow = (row: Row | null): StoredUserState | null => {
  if (row === null || typeof row.state_json !== "string") return null;
  const updatedAt = row.updated_at;
  if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 0)
    return null;
  const state = decodeUserState(parseJson(row.state_json));
  return state === undefined ? null : { state, updatedAt };
};

export const makeD1StateStore = (db: D1DatabaseLike): StateStoreService => {
  const query = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: () => ensureTable(db).then(run),
      catch: stateStoreUnreachable,
    });
  const read = (key: string) => db.prepare(SELECT_ROW).bind(key).first<Row>().then(decodeRow);

  return {
    enabled: true,
    get: (email) => query(() => read(asciiLower(email))),
    put: (email: string, state: UserState, updatedAt: number) => {
      const key = asciiLower(email);
      return query(async () => {
        await db.prepare(UPSERT).bind(key, JSON.stringify(state), updatedAt).run();
        return read(key);
      });
    },
  };
};
