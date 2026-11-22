// Plain-router answers. These routes build Web `Response`s directly and wrap them with
// `HttpServerResponse.raw`, which passes a `Response` through untouched (status, every
// `Set-Cookie`, the body stream).

import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  Conflict,
  InvalidRequest,
  NameExists,
  NotFound,
  NotImplemented,
  PreconditionRequired,
  RateLimited,
  TooLarge,
  Unauthenticated,
  UpstreamError,
  type ApiError,
} from "../../domain/errors.ts";

export const respond = (response: Response): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.raw(response);

const STATUS: ReadonlyArray<readonly [abstract new (...args: never) => ApiError, number]> = [
  [InvalidRequest, 400],
  [Unauthenticated, 401],
  [NotFound, 404],
  [NameExists, 409],
  [Conflict, 412],
  [TooLarge, 413],
  [PreconditionRequired, 428],
  [RateLimited, 429],
  [NotImplemented, 501],
  [UpstreamError, 502],
];

/** The JSON `{code, message, reason?}` answer of an expected failure, as HttpApi encodes it. */
export const errorResponse = (error: ApiError): Response => {
  const status = STATUS.find(([cls]) => error instanceof cls)?.[1] ?? 500;
  const body: Record<string, string> = { code: error.code, message: error.message };
  if (error.reason !== undefined) body["reason"] = error.reason;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};

/** Runs a plain-router handler, answering its expected failures as JSON errors. */
export const handleErrors = <R>(
  effect: Effect.Effect<Response, ApiError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catch((error: ApiError) => Effect.succeed(errorResponse(error))),
    Effect.map(respond),
  );
