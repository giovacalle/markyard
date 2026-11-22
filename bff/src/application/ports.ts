// Ports: what the use cases need from the outside world. Every one of them is provided per
// request by the Worker entry (`http/app.ts`), so handlers list them as request requirements.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

import type { UpstreamError } from "../domain/errors.ts";
import type { StoredUserState, UserState } from "../domain/state.ts";
import type { Config } from "./config.ts";

/** The raw Worker `env` bindings of the current request. */
export class WorkerEnv extends Context.Service<WorkerEnv, Readonly<Record<string, unknown>>>()(
  "@markyard/bff/WorkerEnv",
) {}

/** The configuration parsed from `WorkerEnv`, cached per `env` object. */
export class AppConfig extends Context.Service<AppConfig, Config>()("@markyard/bff/AppConfig") {}

/** The clock and the randomness of a request (Rust `Ctx.now` / `Ctx.random`). */
export class Entropy extends Context.Service<
  Entropy,
  {
    /** Unix time in whole seconds. */
    readonly nowSeconds: Effect.Effect<number>;
    /** 64 fresh random bytes: `[0..16)` sign-in state, `[16..48)` PKCE verifier, `[48..60)` nonce. */
    readonly random64: Effect.Effect<Uint8Array>;
  }
>()("@markyard/bff/Entropy") {}

/** Google could not be reached at all (DNS, TLS, reset): no HTTP status came back. */
export class UpstreamUnreachable extends Data.TaggedError("UpstreamUnreachable")<{
  readonly cause: unknown;
}> {}

/**
 * Outbound HTTP: Google and previewed links are reached only through this port. The response
 * body is left unread, so file downloads can be passed through as raw Web streams.
 */
export class Upstream extends Context.Service<
  Upstream,
  { readonly send: (request: Request) => Effect.Effect<Response, UpstreamUnreachable> }
>()("@markyard/bff/Upstream") {}

/** AES-256-GCM cookie sealing with the configured keys (the highest version seals). */
export class CookieSealer extends Context.Service<
  CookieSealer,
  {
    readonly seal: (plaintext: string, nonce: Uint8Array) => Effect.Effect<string>;
    /** The plaintext, or `undefined` for a tampered, unknown-key or malformed cookie. */
    readonly unseal: (cookie: string) => Effect.Effect<string | undefined>;
  }
>()("@markyard/bff/CookieSealer") {}

/**
 * Headers the current response must carry beyond what its handler encodes: cookies set while
 * resolving the session, a refreshed session cookie, `Retry-After`, `ETag`. The Worker entry
 * creates one per request and applies it to the finished response (Rust `with_cookie` rules).
 */
export class ResponseSink extends Context.Service<
  ResponseSink,
  {
    /** Appends a `Set-Cookie` header. */
    readonly setCookie: (cookie: string) => void;
    /** The rewritten session cookie; dropped when the response already sets `__Host-s=`. */
    readonly refreshSession: (cookie: string) => void;
    /** Sets (replaces) a header. */
    readonly setHeader: (name: string, value: string) => void;
  }
>()("@markyard/bff/ResponseSink") {}

/** The synced UI state, keyed by account email. Disabled when no database is bound. */
export interface StateStoreService {
  /** `false` when the Worker has no `STATE_DB` binding: reads and writes answer `null`. */
  readonly enabled: boolean;
  readonly get: (email: string) => Effect.Effect<StoredUserState | null, UpstreamError>;
  /**
   * Writes `state` unless a newer `updatedAt` is already stored, then answers the stored
   * (winning) row.
   */
  readonly put: (
    email: string,
    state: UserState,
    updatedAt: number,
  ) => Effect.Effect<StoredUserState | null, UpstreamError>;
}

export class StateStore extends Context.Service<StateStore, StateStoreService>()(
  "@markyard/bff/StateStore",
) {}

/** Everything a handler may require from the per-request context. */
export type RequestServices =
  | WorkerEnv
  | AppConfig
  | Entropy
  | Upstream
  | CookieSealer
  | ResponseSink
  | StateStore;
