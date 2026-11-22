// Failures that also need a response header. They record the header in the request's
// `ResponseSink` and fail with the body, so whoever answers the request sends both.

import * as Effect from "effect/Effect";

import {
  rateLimitedError,
  sessionEndedError,
  type RateLimited,
  type Unauthenticated,
} from "../domain/errors.ts";
import { SESSION_COOKIE } from "../domain/session.ts";
import { ResponseSink } from "./ports.ts";

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** A session that came in but cannot be used: 401 `session_ended`, with the cookie cleared. */
export const sessionEnded: Effect.Effect<never, Unauthenticated, ResponseSink> = Effect.gen(
  function* () {
    const sink = yield* ResponseSink;
    sink.setCookie(CLEAR_SESSION_COOKIE);
    return yield* Effect.fail(sessionEndedError());
  },
);

/** Drive rate-limited the request: 429 `rate_limited` with `Retry-After: <seconds>`. */
export const rateLimited = (
  retryAfterSeconds: number,
): Effect.Effect<never, RateLimited, ResponseSink> =>
  Effect.gen(function* () {
    const sink = yield* ResponseSink;
    sink.setHeader("retry-after", String(retryAfterSeconds));
    return yield* Effect.fail(rateLimitedError());
  });
