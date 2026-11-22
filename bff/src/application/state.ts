// Synced UI state use cases (`GET`/`PUT /api/state`). Both run after the session check and key
// the state by the session's email; without a bound database they answer `enabled: false`.

import * as Effect from "effect/Effect";

import { invalidRequest, type InvalidRequest, type UpstreamError } from "../domain/errors.ts";
import { decodePutStateBody, MAX_STATE_BYTES, type UserState } from "../domain/state.ts";
import { StateStore } from "./ports.ts";

export interface StateAnswer {
  readonly enabled: boolean;
  readonly state: UserState | null;
  readonly updatedAt: number | null;
}

const DISABLED: StateAnswer = { enabled: false, state: null, updatedAt: null };

const BAD_BODY = `The request body must be JSON {"state", "updatedAt"} of at most ${MAX_STATE_BYTES} bytes.`;

/** `GET /api/state`: the stored state of `email`, or nulls when there is none. */
export const read = (email: string): Effect.Effect<StateAnswer, UpstreamError, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    if (!store.enabled) return DISABLED;
    const row = yield* store.get(email);
    return { enabled: true, state: row?.state ?? null, updatedAt: row?.updatedAt ?? null };
  });

/**
 * `PUT /api/state`: store the body's state unless a newer one is stored, and answer the winner.
 * The body is validated even when the store is disabled, so a bad client fails the same way.
 */
export const write = (
  email: string,
  body: Uint8Array,
): Effect.Effect<StateAnswer, InvalidRequest | UpstreamError, StateStore> =>
  Effect.gen(function* () {
    const input = decodePutStateBody(body);
    if (input === undefined) return yield* Effect.fail(invalidRequest(BAD_BODY));
    const store = yield* StateStore;
    if (!store.enabled) return DISABLED;
    const saved = yield* store.put(email, input.state, input.updatedAt);
    return {
      enabled: true,
      state: saved?.state ?? input.state,
      updatedAt: saved?.updatedAt ?? input.updatedAt,
    };
  });
