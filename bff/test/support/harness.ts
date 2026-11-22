// Test harness shared by every route test: the real Worker `fetch` (`makeFetch`) with Google
// replaced by a scripted fake, the fixed context of the Rust tests, and cookie helpers.
//
//   const google = new FakeGoogle([on("POST", "https://fake.test/token", json(200, {...}))]);
//   const res = await send(get("/api/session", { cookie: sessionCookieHeader(await sessionCookie(...)) }), { google });
//   expect(google.callsTo("POST", "https://fake.test/token")).toHaveLength(1);

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";

import { parseConfig, type CookieKey, type GoogleUrls } from "../../src/application/config.ts";
import { AppConfig, ResponseSink, Upstream } from "../../src/application/ports.ts";
import { encodeSession, type Session } from "../../src/domain/session.ts";
import { makeFetch } from "../../src/http/app.ts";
import { importKeyring, seal, unseal } from "../../src/infrastructure/cookie-seal.ts";
import { fetchUpstream } from "../../src/infrastructure/fetch-upstream.ts";

export const ORIGIN = "https://notes.test";
export const NOW = 1_800_000_000;
export const KEY_1: Uint8Array = new Uint8Array(32).fill(7);
export const AT = "ya29.access-token-value";
export const RT = "1//refresh-token-value";
export const NEW_AT = "ya29.refreshed-access-token";
export const EMAIL = "owner@example.com";
export const CLEAR_SESSION = "__Host-s=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
export const CLEAR_STATE = "__Host-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
export const SESSION_ATTRS = " Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000";

/** Rust test `ctx().config.google`. */
export const FAKE_GOOGLE: GoogleUrls = {
  auth: "https://fake.test/auth",
  token: "https://fake.test/token",
  revoke: "https://fake.test/revoke",
  drive: "https://fake.test",
};

/** Rust test `ctx().random`: byte `i` is `i`. */
export const RANDOM: Uint8Array = Uint8Array.from({ length: 64 }, (_, i) => i);

export const hex32 = (key: Uint8Array): string =>
  Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");

/** `COOKIE_KEYS` for a list of keys. */
export const cookieKeysBinding = (keys: ReadonlyArray<CookieKey>): string =>
  keys.map((k) => `${k.version}:${hex32(k.key)}`).join(",");

/** The Worker bindings of Rust test `ctx()`. Pass overrides to change one binding. */
export const testEnv = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, unknown> => {
  const env: Record<string, unknown> = {
    PUBLIC_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: "client-id.test",
    GOOGLE_CLIENT_SECRET: "client-secret-value",
    ALLOWED_EMAILS: EMAIL,
    COOKIE_KEYS: cookieKeysBinding([{ version: 1, key: KEY_1 }]),
    ROOT_FOLDER_ID: "root-id",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
};

// ---------------------------------------------------------------------------
// Fake Google
// ---------------------------------------------------------------------------

/** A scripted answer. `body` may be a stream, for download routes. */
export interface Answer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
}

/** An answer, or a transport failure (`fetch` rejects with this message). */
export type Scripted = Answer | { readonly unreachable: string };

export interface Route {
  readonly method: string;
  /** Matches when the URL starts with it (Rust auth tests) or, with `contains`, includes it. */
  readonly url: string;
  readonly contains?: boolean;
  /** Answer only the first matching call; later calls fall through to the next route. */
  readonly once?: boolean;
  readonly answer: Scripted;
}

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  /** The whole request body (streams are read to the end). */
  readonly body: Uint8Array;
  readonly text: string;
}

export const on = (
  method: string,
  url: string,
  answer: Scripted,
  options: Partial<Route> = {},
): Route => ({
  method,
  url,
  answer,
  ...options,
});

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Answer => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export const text = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Answer => ({
  status,
  headers,
  body,
});

export const unreachable = (message = "connection reset"): Scripted => ({ unreachable: message });

/**
 * Scripted fake Google, like the Rust `Fake`: the first route whose method and URL match answers;
 * an unscripted call fails the request as a transport error and is listed in `unexpected`.
 */
export class FakeGoogle {
  readonly calls: Array<Recorded> = [];
  readonly unexpected: Array<string> = [];
  private readonly routes: Array<Route & { used?: boolean }>;

  constructor(routes: ReadonlyArray<Route> = []) {
    this.routes = routes.map((r) => ({ ...r }));
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const body = new Uint8Array(await request.arrayBuffer());
    this.calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      text: new TextDecoder().decode(body),
    });
    const route = this.routes.find(
      (r) =>
        r.method === request.method &&
        !(r.once === true && r.used === true) &&
        (r.contains === true ? request.url.includes(r.url) : request.url.startsWith(r.url)),
    );
    if (route === undefined) {
      this.unexpected.push(`${request.method} ${request.url}`);
      throw new Error(`unscripted upstream call: ${request.method} ${request.url}`);
    }
    route.used = true;
    if ("unreachable" in route.answer) throw new Error(route.answer.unreachable);
    const { status, headers, body: answerBody } = route.answer;
    return new Response((answerBody ?? null) as BodyInit | null, { status, headers });
  };

  callsTo(method: string, urlPrefix: string): Array<Recorded> {
    return this.calls.filter((c) => c.method === method && c.url.startsWith(urlPrefix));
  }

  callsContaining(fragment: string): Array<Recorded> {
    return this.calls.filter((c) => c.url.includes(fragment));
  }
}

// ---------------------------------------------------------------------------
// Running requests
// ---------------------------------------------------------------------------

export interface SendOptions {
  readonly google?: FakeGoogle;
  readonly env?: Record<string, unknown>;
  readonly now?: number;
  readonly random?: Uint8Array;
  /** Bound as `STATE_DB` on top of `env` (or `testEnv()`), enabling cloud state sync. */
  readonly stateDb?: unknown;
}

/** Runs one request through the real Worker `fetch` with the Rust test context. */
export const send = (request: Request, options: SendOptions = {}): Promise<Response> => {
  const google = options.google ?? new FakeGoogle();
  const random = options.random ?? RANDOM;
  const handle = makeFetch({
    fetch: google.fetch,
    google: FAKE_GOOGLE,
    entropy: {
      nowSeconds: Effect.succeed(options.now ?? NOW),
      random64: Effect.sync(() => random.slice()),
    },
  });
  const env = options.env ?? testEnv();
  return handle(
    request,
    options.stateDb === undefined ? env : { ...env, STATE_DB: options.stateDb },
  );
};

export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** A `Cookie` header value. */
  readonly cookie?: string;
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
  /** Non-GET requests carry `Origin: ORIGIN` unless this is `false`. */
  readonly sameOrigin?: boolean;
}

/** A request to `ORIGIN + path`. Stream bodies are sent with `duplex: "half"`. */
export const request = (method: string, path: string, options: RequestOptions = {}): Request => {
  const headers = new Headers(options.headers);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    options.sameOrigin !== false &&
    !headers.has("origin")
  ) {
    headers.set("origin", ORIGIN);
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (options.body !== undefined) {
    init.body = options.body as BodyInit;
    if (options.body instanceof ReadableStream) init.duplex = "half";
  }
  return new Request(`${ORIGIN}${path}`, init);
};

export const get = (path: string, options: RequestOptions = {}): Request =>
  request("GET", path, options);

/** A one-shot byte stream, for streamed upload and download tests. */
export const streamOf = (bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
};

// ---------------------------------------------------------------------------
// Reading responses
// ---------------------------------------------------------------------------

export const setCookies = (res: Response): Array<string> => res.headers.getSetCookie();

/** The `__Host-s` value and attributes set by a response, if any. */
export const sessionCookieOf = (res: Response): { value: string; attrs: string } | undefined => {
  const cookie = setCookies(res).find((c) => c.startsWith("__Host-s="));
  if (cookie === undefined) return undefined;
  const rest = cookie.slice("__Host-s=".length);
  const semi = rest.indexOf(";");
  return { value: rest.slice(0, semi), attrs: rest.slice(semi + 1) };
};

/** Asserts nothing in the response body or headers contains any of `tokens`. */
export const leaks = async (
  res: Response,
  tokens: ReadonlyArray<string>,
): Promise<Array<string>> => {
  const body = await res.clone().text();
  const found: Array<string> = [];
  for (const token of tokens) {
    if (body.includes(token)) found.push(`body: ${token}`);
    for (const [name, value] of res.headers)
      if (value.includes(token)) found.push(`${name}: ${token}`);
  }
  return found;
};

/** Upstream URLs that contain any of `tokens`. */
export const urlLeaks = (google: FakeGoogle, tokens: ReadonlyArray<string>): Array<string> =>
  google.calls.flatMap((c) => tokens.filter((t) => c.url.includes(t)).map((t) => `${c.url}: ${t}`));

/** The sorted `key=value` pairs of a form body or query string. */
export const formPairs = (encoded: string): Array<[string, string]> =>
  [...new URLSearchParams(encoded)].sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1,
  );

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export const KEYS_1: ReadonlyArray<CookieKey> = [{ version: 1, key: KEY_1 }];

/** Rust `session::seal(value, keys, [nonceByte; 12])` for any JSON value. */
export const sealWith = async (
  keys: ReadonlyArray<CookieKey>,
  plaintext: string,
  nonceByte = 1,
): Promise<string> =>
  seal(await importKeyring(keys), plaintext, new Uint8Array(12).fill(nonceByte));

export const unsealWith = async (
  keys: ReadonlyArray<CookieKey>,
  cookie: string,
): Promise<unknown> => {
  const plaintext = await unseal(await importKeyring(keys), cookie);
  return plaintext === undefined ? undefined : JSON.parse(plaintext);
};

/** Rust test `stored_session(exp)`: with an access token only when `exp` is given. */
export const storedSession = (exp?: number): Session =>
  exp === undefined ? { rt: RT, email: EMAIL } : { rt: RT, at: AT, exp, email: EMAIL };

/** A sealed `__Host-s` value for `session` (key 1, nonce `[1; 12]`). */
export const sessionCookie = (
  session: Session,
  keys: ReadonlyArray<CookieKey> = KEYS_1,
): Promise<string> => sealWith(keys, encodeSession(session));

/** A `Cookie` header carrying a valid session whose access token is fresh for an hour. */
export const signedInCookie = async (
  session: Session = storedSession(NOW + 3600),
): Promise<string> => `theme=dark; __Host-s=${await sessionCookie(session)}`;

/** Flips one character in the middle of a cookie, like the Rust tests do. */
export const tamper = (cookie: string): string => {
  const mid = Math.floor(cookie.length / 2);
  return `${cookie.slice(0, mid)}${cookie[mid] === "A" ? "B" : "A"}${cookie.slice(mid + 1)}`;
};

// ---------------------------------------------------------------------------
// Running a use case or Drive call without HTTP
// ---------------------------------------------------------------------------

export interface DirectRun<A, E> {
  readonly exit: Exit.Exit<A, E>;
  /** What the effect recorded in its `ResponseSink`. */
  readonly sink: {
    cookies: Array<string>;
    refresh: string | undefined;
    headers: Record<string, string>;
  };
}

/** Runs an effect needing `AppConfig | Upstream | ResponseSink` against the fake, like a route would. */
export const runDirect = async <A, E>(
  effect: Effect.Effect<A, E, AppConfig | Upstream | ResponseSink>,
  google: FakeGoogle = new FakeGoogle(),
): Promise<DirectRun<A, E>> => {
  const parsed = parseConfig((name) => testEnv()[name] as string | undefined, FAKE_GOOGLE);
  if (!parsed.ok) throw new Error(parsed.error);
  const sink: DirectRun<A, E>["sink"] = { cookies: [], refresh: undefined, headers: {} };
  const context = Context.make(AppConfig, parsed.config).pipe(
    Context.add(Upstream, fetchUpstream(google.fetch)),
    Context.add(ResponseSink, {
      setCookie: (cookie) => void sink.cookies.push(cookie),
      refreshSession: (cookie) => void (sink.refresh = cookie),
      setHeader: (name, value) => void (sink.headers[name.toLowerCase()] = value),
    }),
  );
  const exit = await Effect.runPromiseExit(Effect.provideContext(effect, context));
  return { exit, sink };
};
