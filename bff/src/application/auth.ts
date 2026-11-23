// Sign-in flow, session lookup and refresh (port of Rust `core/src/auth.rs`).

import * as Effect from "effect/Effect";

import { asciiLower } from "../domain/drive.ts";
import { base64UrlNoPad, hex, utf8 } from "../domain/encoding.ts";
import {
  googleUnreachable,
  notSignedIn,
  type Unauthenticated,
  type UpstreamError,
} from "../domain/errors.ts";
import {
  cookieValue,
  decodeSession,
  decodeSignInState,
  encodeSession,
  encodeSignInState,
  isU64,
  MAX_COOKIE_NAME_VALUE_BYTES,
  normalizeName,
  parseJson,
  SESSION_COOKIE,
  STATE_COOKIE,
  type Session,
} from "../domain/session.ts";
import { sessionEnded } from "./failures.ts";
import { AppConfig, CookieSealer, Entropy, ResponseSink, type Upstream } from "./ports.ts";
import { bearer, formPost, sendBuffered } from "./upstream.ts";

const SCOPE = "https://www.googleapis.com/auth/drive";
export const SESSION_MAX_AGE = 2_592_000;
export const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
/** An access token counts as expired this many seconds before its `exp`. */
export const EXPIRY_MARGIN = 60;

const nonceOf = (random: Uint8Array): Uint8Array => random.slice(48, 60);

export const sessionCookieHeader = (sealed: string): string =>
  `${SESSION_COOKIE}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`;

/** Seals a session, dropping `at` and `exp` (never `name` or `rootFolderId`) when `__Host-s=<value>` would exceed 4096 bytes. */
export const sealSession = (
  session: Session,
  nonce: Uint8Array,
): Effect.Effect<string, never, CookieSealer> =>
  Effect.gen(function* () {
    const sealer = yield* CookieSealer;
    const sealed = yield* sealer.seal(encodeSession(session), nonce);
    if (SESSION_COOKIE.length + 1 + sealed.length <= MAX_COOKIE_NAME_VALUE_BYTES) return sealed;
    return yield* sealer.seal(
      encodeSession({
        rt: session.rt,
        email: session.email,
        name: session.name,
        rootFolderId: session.rootFolderId,
      }),
      nonce,
    );
  });

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresIn: number;
}

const decodeTokenResponse = (json: unknown): TokenResponse | undefined => {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  const rt = o["refresh_token"];
  if (typeof o["access_token"] !== "string" || !isU64(o["expires_in"])) return undefined;
  if (rt !== undefined && rt !== null && typeof rt !== "string") return undefined;
  return {
    accessToken: o["access_token"],
    refreshToken: rt ?? undefined,
    expiresIn: o["expires_in"],
  };
};

const isInvalidGrant = (json: unknown): boolean =>
  typeof json === "object" &&
  json !== null &&
  (json as Record<string, unknown>)["error"] === "invalid_grant";

/** The account of a Drive `about` answer: the email is required, the display name optional. */
const aboutUser = (json: unknown): { email: string; name: string | undefined } | undefined => {
  if (typeof json !== "object" || json === null) return undefined;
  const user = (json as Record<string, unknown>)["user"];
  if (typeof user !== "object" || user === null) return undefined;
  const fields = user as Record<string, unknown>;
  const email = fields["emailAddress"];
  return typeof email === "string"
    ? { email, name: normalizeName(fields["displayName"]) }
    : undefined;
};

const sha256 = (text: string): Effect.Effect<Uint8Array> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", utf8(text) as BufferSource)).pipe(
    Effect.map((digest) => new Uint8Array(digest)),
  );

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginRedirect {
  readonly location: string;
  /** The full `Set-Cookie` value of the sealed sign-in state. */
  readonly stateCookie: string;
}

/** `GET /api/auth/login`: redirect to Google with `state` and PKCE; no upstream call. */
export const login: Effect.Effect<LoginRedirect, never, AppConfig | Entropy | CookieSealer> =
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const random = yield* (yield* Entropy).random64;
    const state = hex(random.slice(0, 16));
    const verifier = base64UrlNoPad(random.slice(16, 48));
    const challenge = base64UrlNoPad(yield* sha256(verifier));
    const query = new URLSearchParams([
      ["response_type", "code"],
      ["client_id", config.clientId],
      ["redirect_uri", `${config.publicOrigin}/api/auth/callback`],
      ["scope", SCOPE],
      ["state", state],
      ["code_challenge", challenge],
      ["code_challenge_method", "S256"],
      ["access_type", "offline"],
      ["prompt", "consent"],
    ]).toString();
    const sealer = yield* CookieSealer;
    const sealed = yield* sealer.seal(encodeSignInState({ state, verifier }), nonceOf(random));
    return {
      location: `${config.google.auth}?${query}`,
      stateCookie: `${STATE_COOKIE}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    };
  });

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export type CallbackOutcome =
  | { readonly _tag: "SignedIn"; readonly sessionCookie: string }
  | { readonly _tag: "Failed"; readonly status: 400 | 502; readonly message: string }
  | { readonly _tag: "NotAllowed" };

const INVALID_REQUEST = {
  _tag: "Failed",
  status: 400,
  message: "The sign-in request was not valid. Try again.",
} as const;
const GOOGLE_FAILED = {
  _tag: "Failed",
  status: 502,
  message: "Google did not complete the sign-in. Try again.",
} as const;

/** `GET /api/auth/callback`: finish the code exchange and apply the allowlist. */
export const callback = (
  url: URL,
  cookieHeader: string | null,
): Effect.Effect<CallbackOutcome, never, AppConfig | Entropy | CookieSealer | Upstream> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const sealer = yield* CookieSealer;
    const params = new URLSearchParams(url.search);
    const rawState = cookieValue(cookieHeader, STATE_COOKIE);
    const plaintext = rawState === undefined ? undefined : yield* sealer.unseal(rawState);
    const stored = plaintext === undefined ? undefined : decodeSignInState(parseJson(plaintext));
    const state = params.get("state");
    const code = params.get("code");
    if (stored === undefined || state === null || code === null || params.has("error"))
      return INVALID_REQUEST;
    if (stored.state !== state) return INVALID_REQUEST;

    const tokenAnswer = yield* Effect.option(
      sendBuffered(
        formPost(config.google.token, [
          ["grant_type", "authorization_code"],
          ["code", code],
          ["code_verifier", stored.verifier],
          ["client_id", config.clientId],
          ["client_secret", config.clientSecret],
          ["redirect_uri", `${config.publicOrigin}/api/auth/callback`],
        ]),
      ),
    );
    const tokens =
      tokenAnswer._tag === "Some" && tokenAnswer.value.ok
        ? decodeTokenResponse(tokenAnswer.value.json)
        : undefined;
    if (tokens === undefined || tokens.refreshToken === undefined) return GOOGLE_FAILED;
    const refreshToken = tokens.refreshToken;

    const aboutAnswer = yield* Effect.option(
      sendBuffered(
        new Request(`${config.google.drive}/drive/v3/about?fields=user(displayName,emailAddress)`, {
          headers: { authorization: bearer(tokens.accessToken) },
        }),
      ),
    );
    const account =
      aboutAnswer._tag === "Some" && aboutAnswer.value.ok
        ? aboutUser(aboutAnswer.value.json)
        : undefined;
    if (account === undefined) return GOOGLE_FAILED;

    const email = account.email.trim();
    if (!config.allowAllEmails && !config.allowedEmails.includes(asciiLower(email))) {
      // The result is ignored: the account is refused whether or not Google confirms the revoke.
      yield* Effect.ignore(sendBuffered(formPost(config.google.revoke, [["token", refreshToken]])));
      return { _tag: "NotAllowed" } as const;
    }

    const entropy = yield* Entropy;
    const now = yield* entropy.nowSeconds;
    const random = yield* entropy.random64;
    const sealed = yield* sealSession(
      {
        rt: refreshToken,
        at: tokens.accessToken,
        exp: now + tokens.expiresIn,
        email,
        name: account.name,
      },
      nonceOf(random),
    );
    return { _tag: "SignedIn", sessionCookie: sessionCookieHeader(sealed) } as const;
  });

// ---------------------------------------------------------------------------
// The signed-in session
// ---------------------------------------------------------------------------

/**
 * Resolves the signed-in session of a request, refreshing the access token when it has expired.
 * A rewritten cookie goes to the `ResponseSink`. Fails with 401 for a missing or unusable session
 * (clearing the cookie when one came in) and 502 when Google could not be asked. Every route that
 * needs a session runs this first.
 */
export const authorized = (
  cookieHeader: string | null,
): Effect.Effect<
  Session,
  Unauthenticated | UpstreamError,
  AppConfig | Entropy | CookieSealer | Upstream | ResponseSink
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const raw = cookieValue(cookieHeader, SESSION_COOKIE);
    if (raw === undefined) return yield* Effect.fail(notSignedIn());
    const plaintext = yield* (yield* CookieSealer).unseal(raw);
    const session = plaintext === undefined ? undefined : decodeSession(parseJson(plaintext));
    if (session === undefined) return yield* sessionEnded;
    if (
      !config.allowAllEmails &&
      !config.allowedEmails.includes(asciiLower(session.email.trim()))
    ) {
      return yield* sessionEnded;
    }

    const entropy = yield* Entropy;
    const now = yield* entropy.nowSeconds;
    if (
      session.at !== undefined &&
      session.exp !== undefined &&
      now + EXPIRY_MARGIN < session.exp
    ) {
      return session;
    }

    const res = yield* sendBuffered(
      formPost(config.google.token, [
        ["grant_type", "refresh_token"],
        ["refresh_token", session.rt],
        ["client_id", config.clientId],
        ["client_secret", config.clientSecret],
      ]),
    ).pipe(Effect.mapError(googleUnreachable));
    if (res.status === 400 && isInvalidGrant(res.json)) return yield* sessionEnded;
    if (!res.ok) return yield* Effect.fail(googleUnreachable());
    const refreshed = decodeTokenResponse(res.json);
    if (refreshed === undefined) return yield* Effect.fail(googleUnreachable());

    const renewed: Session = {
      rt: refreshed.refreshToken ?? session.rt,
      at: refreshed.accessToken,
      exp: now + refreshed.expiresIn,
      email: session.email,
      name: session.name,
      rootFolderId: session.rootFolderId,
    };
    yield* resealSession(renewed);
    return renewed;
  });

/** Seals `session` with a fresh nonce and sends it as this response's rewritten session cookie. */
export const resealSession = (
  session: Session,
): Effect.Effect<void, never, Entropy | CookieSealer | ResponseSink> =>
  Effect.gen(function* () {
    const random = yield* (yield* Entropy).random64;
    const sealed = yield* sealSession(session, nonceOf(random));
    (yield* ResponseSink).refreshSession(sessionCookieHeader(sealed));
  });

/**
 * The session's access token, for routes that call Drive. An authorized session always carries
 * one; an empty one would only earn a Drive 401.
 */
export const signedIn = (cookieHeader: string | null) =>
  authorized(cookieHeader).pipe(Effect.map((session) => session.at ?? ""));
