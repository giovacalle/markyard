// The whole BFF as one Web handler (ADR 0003): the HttpApi JSON routes and the plain HttpRouter
// routes are merged into a single `HttpRouter.toWebHandler`, built once at module scope. Every
// request gets its ports through a per-request `Context`. The thin outer wrapper owns what Rust
// `lib.rs` did around routing: the misconfigured answer, the same-origin guard, the extra
// response headers recorded in `ResponseSink`, and the security headers.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";

import {
  parseConfig,
  productionGoogleUrls,
  type Config,
  type GoogleUrls,
} from "../application/config.ts";
import {
  AppConfig,
  CookieSealer,
  Entropy,
  ResponseSink,
  StateStore,
  Upstream,
  WorkerEnv,
  type StateStoreService,
} from "../application/ports.ts";
import { SESSION_COOKIE } from "../domain/session.ts";
import { stateStoreFromEnv } from "../infrastructure/d1-state-store.ts";
import { importKeyring, makeCookieSealer } from "../infrastructure/cookie-seal.ts";
import { fetchUpstream, type FetchFn } from "../infrastructure/fetch-upstream.ts";
import { Api } from "./api.ts";
import { AttachmentsListLive } from "./handlers/attachments.ts";
import { ChangesLive } from "./handlers/changes.ts";
import { CreateLive } from "./handlers/create.ts";
import { DriveLive } from "./handlers/drive.ts";
import { FilesLive } from "./handlers/files.ts";
import { FoldersLive } from "./handlers/folders.ts";
import { LinkPreviewLive } from "./handlers/link-preview.ts";
import { RevisionsLive } from "./handlers/revisions.ts";
import { SearchLive } from "./handlers/search.ts";
import { SessionLive } from "./handlers/session.ts";
import { StateLive } from "./handlers/state.ts";
import { SystemLive } from "./handlers/system.ts";
import { VaultLive } from "./handlers/vault.ts";
import { AttachmentsLive } from "./routes/attachments.ts";
import { AuthPagesLive } from "./routes/auth-pages.ts";
import { FileContentLive } from "./routes/file-content.ts";
import { LinkPreviewImageLive } from "./routes/link-preview-image.ts";
import { respond } from "./routes/respond.ts";
import { RevisionContentLive } from "./routes/revision-content.ts";

export const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export const NOSNIFF = "nosniff";
/** Stops proxies from caching private Drive data or weakening strong `ETag`s via compression. */
export const NO_STORE_NO_TRANSFORM = "no-store, no-transform";

const jsonError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Any method and path no other route claims (static and parametric routes win in find-my-way). */
const NotFoundLive = HttpRouter.addAll([
  HttpRouter.route(
    "*",
    "*",
    Effect.sync(() => respond(jsonError(404, "not_found", "Not found"))),
  ),
]);

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([
    SystemLive,
    SessionLive,
    FoldersLive,
    CreateLive,
    FilesLive,
    SearchLive,
    ChangesLive,
    VaultLive,
    RevisionsLive,
    AttachmentsListLive,
    LinkPreviewLive,
    StateLive,
    DriveLive,
  ]),
  Layer.provide(HttpServer.layerServices),
);

const AppLive = Layer.mergeAll(
  ApiLive,
  AuthPagesLive,
  FileContentLive,
  AttachmentsLive,
  LinkPreviewImageLive,
  RevisionContentLive,
  NotFoundLive,
);

/**
 * Built once per isolate. Rust matched paths exactly, so the find-my-way leniencies are off:
 * `/api/health/`, `/API/health` and `//api/health` are 404 there, and ids had no length cap.
 */
const app = HttpRouter.toWebHandler(AppLive, {
  disableLogger: true,
  routerConfig: {
    ignoreTrailingSlash: false,
    ignoreDuplicateSlashes: false,
    caseSensitive: true,
    maxParamLength: 8192,
  },
});

export const withSecurityHeaders = (response: Response): Response => {
  const out = mutable(response);
  out.headers.set("content-security-policy", CSP);
  out.headers.set("x-content-type-options", NOSNIFF);
  if (!out.headers.has("cache-control")) {
    out.headers.set("cache-control", NO_STORE_NO_TRANSFORM);
  }
  return out;
};

/** A copy whose headers can be changed (a `fetch` answer passed through has immutable ones). */
const mutable = (response: Response): Response => new Response(response.body, response);

/** Rust `misconfigured`: 500 text naming the bad binding, never its value. */
export const misconfigured = (bindingError: string): Response =>
  withSecurityHeaders(
    new Response(`Server misconfigured: ${bindingError}`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );

/** State-changing requests are accepted only from the app's own origin. */
const isSameOrigin = (request: Request, config: Config): boolean => {
  const site = request.headers.get("sec-fetch-site");
  return (
    request.headers.get("origin") === config.publicOrigin &&
    (site === null || site === "same-origin")
  );
};

interface Recorded {
  readonly cookies: Array<string>;
  refresh: string | undefined;
  readonly headers: Map<string, string>;
}

const makeSink = (recorded: Recorded): ResponseSink["Service"] => ({
  setCookie: (cookie) => void recorded.cookies.push(cookie),
  refreshSession: (cookie) => void (recorded.refresh = cookie),
  setHeader: (name, value) => void recorded.headers.set(name.toLowerCase(), value),
});

/** Applies the recorded headers; the refreshed session cookie follows Rust `with_cookie`. */
const applySink = (response: Response, recorded: Recorded): Response => {
  const out = mutable(response);
  for (const [name, value] of recorded.headers) out.headers.set(name, value);
  for (const cookie of recorded.cookies) out.headers.append("set-cookie", cookie);
  const setsSession = out.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (recorded.refresh !== undefined && !setsSession)
    out.headers.append("set-cookie", recorded.refresh);
  return out;
};

export interface Deps {
  /** Outbound `fetch` (the Workers global in production, a fake in tests). */
  readonly fetch: FetchFn;
  readonly entropy: Entropy["Service"];
  readonly google?: GoogleUrls;
}

type Env = Readonly<Record<string, unknown>>;

type Prepared =
  | {
      readonly ok: true;
      readonly config: Config;
      readonly sealer: Promise<CookieSealer["Service"]>;
      readonly stateStore: StateStoreService;
    }
  | { readonly ok: false; readonly error: string };

/**
 * The Worker `fetch`: `(request, env) => Response`. Config and imported keys are cached per `env`
 * object (ADR 0003), so an isolate parses and imports them once.
 */
export const makeFetch = (deps: Deps) => {
  const cache = new WeakMap<Env, Prepared>();
  const upstream = fetchUpstream(deps.fetch);
  const google = deps.google ?? productionGoogleUrls;

  const prepare = (env: Env): Prepared => {
    const cached = cache.get(env);
    if (cached !== undefined) return cached;
    const parsed = parseConfig((name) => {
      const value = env[name];
      return typeof value === "string" ? value : undefined;
    }, google);
    const prepared: Prepared = parsed.ok
      ? {
          ok: true,
          config: parsed.config,
          sealer: importKeyring(parsed.config.keys).then(makeCookieSealer),
          stateStore: stateStoreFromEnv(env),
        }
      : parsed;
    cache.set(env, prepared);
    return prepared;
  };

  return async (request: Request, env: Env): Promise<Response> => {
    const prepared = prepare(env);
    if (!prepared.ok) return misconfigured(prepared.error);
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !isSameOrigin(request, prepared.config)
    ) {
      return withSecurityHeaders(
        jsonError(403, "forbidden", "Cross-origin requests are not allowed"),
      );
    }
    const recorded: Recorded = { cookies: [], refresh: undefined, headers: new Map() };
    const context = Context.make(WorkerEnv, env).pipe(
      Context.add(AppConfig, prepared.config),
      Context.add(Entropy, deps.entropy),
      Context.add(Upstream, upstream),
      Context.add(CookieSealer, await prepared.sealer),
      Context.add(ResponseSink, makeSink(recorded)),
      Context.add(StateStore, prepared.stateStore),
    );
    const response = await app.handler(request, context);
    return withSecurityHeaders(applySink(response, recorded));
    // `applySink` and `withSecurityHeaders` each copy; the body stream is passed, not read.
  };
};
