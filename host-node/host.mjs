// The Node 24 host (#39): one Web-standard handler that sends `/api/*` to the unchanged BFF and
// everything else to the shared static host, like `runWorkerFirst: ["/api/*"]` on Cloudflare.

import { makeFetch } from "../bff/src/http/app.ts";
import { systemEntropy } from "../bff/src/infrastructure/entropy.ts";
import { createStaticHandler } from "./static-host.mjs";

/** The variables the BFF reads, with the same names as the Cloudflare Worker bindings. */
export const BFF_ENV_NAMES = Object.freeze([
  "PUBLIC_ORIGIN",
  "ALLOWED_EMAILS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "COOKIE_KEYS",
]);

/**
 * The BFF `env`, built once. `makeFetch` caches config and imported keys per `env` object, so the
 * host must pass this same object to every request.
 */
export const bffEnvFrom = (source) => {
  const env = {};
  for (const name of BFF_ENV_NAMES) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  return Object.freeze(env);
};

const isApiPath = (pathname) => pathname === "/api" || pathname.startsWith("/api/");

/**
 * @param {{
 *   distDir: string,
 *   env: Readonly<Record<string, unknown>>,
 *   fetch?: (request: Request) => Promise<Response>,
 *   entropy?: unknown,
 *   google?: unknown,
 * }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export const createHost = ({ distDir, env, fetch: upstreamFetch, entropy, google }) => {
  const bff = makeFetch({
    fetch: upstreamFetch ?? ((request) => fetch(request)),
    entropy: entropy ?? systemEntropy,
    google,
  });
  const serveStatic = createStaticHandler({ distDir });

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (!isApiPath(pathname)) {
      const response = await serveStatic(request);
      if (response !== undefined) return response;
    }
    // `/api/*`, and static misses that are not navigations: the BFF answers (JSON 404 catch-all).
    return bff(request, env);
  };
};

/**
 * Wraps a handler with a one-line access log per request. Only the path is logged: query strings
 * can carry OAuth codes and Drive ids.
 */
export const withAccessLog = (handler, log) => async (request) => {
  const started = performance.now();
  const { pathname } = new URL(request.url);
  let status = 500;
  try {
    const response = await handler(request);
    status = response.status;
    return response;
  } finally {
    const ms = (performance.now() - started).toFixed(1);
    log(`${new Date().toISOString()} ${request.method} ${pathname} ${status} ${ms}ms`);
  }
};
