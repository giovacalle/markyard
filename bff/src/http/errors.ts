// The HTTP status of every expected failure, attached once here (typed HTTP errors pattern):
// the domain classes stay HTTP-free, and a failure missing from an endpoint's list is a defect.

import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import {
  Conflict,
  Forbidden,
  InvalidRequest,
  NameExists,
  NotFound,
  NotImplemented,
  PreconditionRequired,
  RateLimited,
  TokenExpired,
  TooLarge,
  Unauthenticated,
  UpstreamError,
} from "../domain/errors.ts";

export const InvalidRequest400 = HttpApiSchema.status(400)(InvalidRequest);
export const Unauthenticated401 = HttpApiSchema.status(401)(Unauthenticated);
export const Forbidden403 = HttpApiSchema.status(403)(Forbidden);
export const NotFound404 = HttpApiSchema.status(404)(NotFound);
export const NameExists409 = HttpApiSchema.status(409)(NameExists);
export const Conflict412 = HttpApiSchema.status(412)(Conflict);
export const TokenExpired410 = HttpApiSchema.status(410)(TokenExpired);
export const TooLarge413 = HttpApiSchema.status(413)(TooLarge);
export const PreconditionRequired428 = HttpApiSchema.status(428)(PreconditionRequired);
export const RateLimited429 = HttpApiSchema.status(429)(RateLimited);
export const NotImplemented501 = HttpApiSchema.status(501)(NotImplemented);
export const UpstreamError502 = HttpApiSchema.status(502)(UpstreamError);

/** What any route behind `signedIn` and Drive can fail with. */
export const DriveErrors = [
  Unauthenticated401,
  NotFound404,
  RateLimited429,
  UpstreamError502,
  NotImplemented501,
] as const;

/** What a route inside the vault can fail with: also 400 `vault_not_configured`. */
export const VaultErrors = [...DriveErrors, InvalidRequest400] as const;

/** What a route that also validates a request body can fail with. */
export const DriveWriteErrors = [...DriveErrors, InvalidRequest400, NameExists409] as const;
