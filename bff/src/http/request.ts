// Helpers every handler uses to read the current request the way the Rust router saw it.

import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { authorized, signedIn } from "../application/auth.ts";
import { readAtMost } from "../application/files.ts";
import { requireVaultRoot } from "../application/vaultRoot.ts";
import { MAX_FILE_BYTES, rawPathId } from "../domain/drive.ts";
import { notImplemented, type NotImplemented } from "../domain/errors.ts";
import { parseContentLength } from "../domain/files.ts";

/** Default cap for small JSON control-plane request bodies (rename, move, folder, vault). */
export const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Cap for `POST /api/folders/{id}/files` JSON bodies (10 MB note content + JSON escaping/overhead). */
export const MAX_CREATE_BODY_BYTES = 2 * MAX_FILE_BYTES + 64 * 1024;

/** The Web `Request` the Worker received. */
export const webRequest: Effect.Effect<Request, never, HttpServerRequest.HttpServerRequest> =
  Effect.gen(function* () {
    return (yield* HttpServerRequest.HttpServerRequest).source as Request;
  });

/**
 * Reads at most `maxBytes` of the request body as a stream, returning `undefined` when exceeded
 * (without buffering unbounded memory) and an empty array when the body is missing or unreadable.
 */
export const readBodyBytes = (
  maxBytes: number,
): Effect.Effect<Uint8Array | undefined, never, HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(webRequest, (request) => {
    const contentLength = parseContentLength(request.headers.get("content-length"));
    if (contentLength !== undefined && contentLength > maxBytes) {
      if (request.body !== null && !request.body.locked) {
        request.body.cancel().catch(() => undefined);
      }
      return Effect.succeed(undefined);
    }
    if (request.body === null) return Effect.succeed(new Uint8Array());
    return Effect.tryPromise(() => Effect.runPromise(readAtMost(request.body!, maxBytes))).pipe(
      Effect.orElseSucceed(() => new Uint8Array()),
    );
  });

/**
 * Reads up to `maxBytes` of the request body; an unreadable or oversized body becomes empty bytes,
 * which JSON body decoders reject with 400 `invalid_request`.
 */
export const bodyBytesOf = (
  maxBytes: number,
): Effect.Effect<Uint8Array, never, HttpServerRequest.HttpServerRequest> =>
  Effect.map(readBodyBytes(maxBytes), (bytes) => bytes ?? new Uint8Array());

/** Small JSON request body, capped at `MAX_JSON_BODY_BYTES`. */
export const bodyBytes = bodyBytesOf(MAX_JSON_BODY_BYTES);

/** The `Cookie` header of the current request. */
export const cookieHeader = Effect.map(webRequest, (request) => request.headers.get("cookie"));

/**
 * The access token of the signed-in session (refreshing it when needed), or the 401/502 failure
 * every signed-in route answers with. Run it before validating anything else, as Rust does.
 */
export const accessToken = Effect.flatMap(cookieHeader, signedIn);

/** The signed-in session (refreshing its access token when needed), or its 401/502 failure. */
export const signedInSession = Effect.flatMap(cookieHeader, authorized);

/**
 * The access token and vault root of the signed-in account, for routes that work inside the
 * vault: 401/502 without a usable session, then 400 `vault_not_configured` without a vault root.
 */
export const vaultAccess = Effect.gen(function* () {
  const session = yield* signedInSession;
  const rootFolderId = yield* requireVaultRoot(session);
  return { token: session.at ?? "", rootFolderId };
});

/** The query parameter `name` of the current request URL (first one wins), or `null`. */
export const queryParam = (
  name: string,
): Effect.Effect<string | null, never, HttpServerRequest.HttpServerRequest> =>
  Effect.map(webRequest, (request) => new URL(request.url).searchParams.get(name));

/**
 * The raw (still percent-encoded) `{id}` of `prefix{id}suffix` in the current path. Validate it
 * with `isValidId`: the decoded `params.id` of HttpApi would turn `a%41` into a valid id.
 */
export const pathId = (
  prefix: string,
  suffix = "",
): Effect.Effect<string, never, HttpServerRequest.HttpServerRequest> =>
  Effect.map(webRequest, (request) => rawPathId(request.url, prefix, suffix) ?? "");

/** The answer of a route that phase 2 has not ported yet: 501 `not_implemented`. */
export const notPorted: Effect.Effect<never, NotImplemented> = Effect.suspend(() =>
  Effect.fail(notImplemented()),
);
