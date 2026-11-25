// Expected failures of the BFF, one class per kind of answer. Every class has the same wire
// body, `{code, message, reason?}`, which is what the web app reads; the HTTP status of each
// class is attached once, in `http/errors.ts`. The classes are untagged so the encoded body
// carries no `_tag`.

import * as Schema from "effect/Schema";

const fields = {
  code: Schema.String,
  message: Schema.String,
  reason: Schema.optionalKey(Schema.String),
};

export class InvalidRequest extends Schema.Error<InvalidRequest>("InvalidRequest")(fields) {}
export class Unauthenticated extends Schema.Error<Unauthenticated>("Unauthenticated")(fields) {}
export class Forbidden extends Schema.Error<Forbidden>("Forbidden")(fields) {}
export class NotFound extends Schema.Error<NotFound>("NotFound")(fields) {}
export class NameExists extends Schema.Error<NameExists>("NameExists")(fields) {}
export class Conflict extends Schema.Error<Conflict>("Conflict")(fields) {}
export class TooLarge extends Schema.Error<TooLarge>("TooLarge")(fields) {}
export class PreconditionRequired extends Schema.Error<PreconditionRequired>(
  "PreconditionRequired",
)(fields) {}
export class TokenExpired extends Schema.Error<TokenExpired>("TokenExpired")(fields) {}
export class RateLimited extends Schema.Error<RateLimited>("RateLimited")(fields) {}
export class NotImplemented extends Schema.Error<NotImplemented>("NotImplemented")(fields) {}
export class UpstreamError extends Schema.Error<UpstreamError>("UpstreamError")(fields) {}

export type ApiError =
  | InvalidRequest
  | Unauthenticated
  | Forbidden
  | NotFound
  | NameExists
  | Conflict
  | TooLarge
  | PreconditionRequired
  | TokenExpired
  | RateLimited
  | NotImplemented
  | UpstreamError;

export const notFound = (): NotFound => new NotFound({ code: "not_found", message: "Not found" });

export const forbidden = (message: string): Forbidden =>
  new Forbidden({ code: "forbidden", message });

export const notSignedIn = (): Unauthenticated =>
  new Unauthenticated({ code: "unauthenticated", message: "Not signed in" });

/** The body of a session that came in but cannot be used. Its cookie is cleared by the caller. */
export const sessionEndedError = (): Unauthenticated =>
  new Unauthenticated({
    code: "unauthenticated",
    message: "Your session has ended. Sign in again.",
    reason: "session_ended",
  });

/** Google's token endpoint could not be asked (refresh flow). */
export const googleUnreachable = (): UpstreamError =>
  new UpstreamError({ code: "upstream_error", message: "Google could not be reached. Try again." });

/** A Drive call failed in a way the web app can only retry. */
export const driveUnreachable = (): UpstreamError =>
  new UpstreamError({
    code: "upstream_error",
    message: "Google Drive could not be reached. Try again.",
  });

export const conflict = (): Conflict =>
  new Conflict({ code: "conflict", message: "The note changed on Drive since it was opened." });

/** The body of a Drive rate limit. Its `Retry-After` header is set by the caller. */
export const rateLimitedError = (): RateLimited =>
  new RateLimited({ code: "rate_limited", message: "Google Drive is busy. Try again shortly." });

export const tooLarge = (): TooLarge =>
  new TooLarge({ code: "too_large", message: "File is larger than 10 MB" });

/** A previewed image over the 2 MiB proxy cap. */
export const previewImageTooLarge = (): TooLarge =>
  new TooLarge({ code: "too_large", message: "Image is larger than 2 MB" });

/** A previewed link could not be fetched (transport failure, timeout, bad redirect, 5xx). */
export const linkUnreachable = (): UpstreamError =>
  new UpstreamError({ code: "upstream_error", message: "The link could not be reached." });

export const preconditionRequired = (): PreconditionRequired =>
  new PreconditionRequired({
    code: "precondition_required",
    message: "A revision tag is required to save.",
  });

export const invalidRequest = (message: string): InvalidRequest =>
  new InvalidRequest({ code: "invalid_request", message });

export const invalidName = (message: string): InvalidRequest =>
  new InvalidRequest({ code: "invalid_name", message });

export const invalidMove = (message: string): InvalidRequest =>
  new InvalidRequest({ code: "invalid_move", message });

/** Drive no longer accepts a change page token; the web app starts over from a fresh one. */
export const tokenExpired = (): TokenExpired =>
  new TokenExpired({
    code: "token_expired",
    message: "The change token expired. Reload the folder tree.",
  });

export const nameExists = (message: string): NameExists =>
  new NameExists({ code: "name_exists", message });

export const notImplemented = (): NotImplemented =>
  new NotImplemented({ code: "not_implemented", message: "Not implemented" });

/** The synced-state database failed or could not be reached. */
export const stateStoreUnreachable = (): UpstreamError =>
  new UpstreamError({
    code: "upstream_error",
    message: "Saved settings could not be reached. Try again.",
  });

/** The account has no vault folder of its own and the instance configures none. */
export const vaultNotConfigured = (): InvalidRequest =>
  new InvalidRequest({
    code: "vault_not_configured",
    message: "No Google Drive vault folder is selected yet.",
  });
