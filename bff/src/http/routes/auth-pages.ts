// `GET /api/auth/login` and `GET /api/auth/callback`: top-level navigations answered with a
// redirect or a small static HTML page, so they live in the plain router (ADR 0003).

import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";

import { callback, CLEAR_STATE_COOKIE, login } from "../../application/auth.ts";
import { webRequest } from "../request.ts";
import { respond } from "./respond.ts";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** A small static HTML page for top-level navigations. It never echoes upstream content. */
export const page = (
  status: number,
  title: string,
  message: string,
  cookies: ReadonlyArray<string>,
): Response => {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${safeTitle}</title></head>` +
    `<body><h1>${safeTitle}</h1><p>${safeMessage}</p><p><a href="/">Back to Markyard</a></p></body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status, headers });
};

export const AuthPagesLive = HttpRouter.addAll([
  HttpRouter.route(
    "GET",
    "/api/auth/login",
    Effect.map(login, ({ location, stateCookie }) =>
      respond(
        new Response(null, { status: 302, headers: { location, "set-cookie": stateCookie } }),
      ),
    ),
  ),
  HttpRouter.route(
    "GET",
    "/api/auth/callback",
    Effect.gen(function* () {
      const request = yield* webRequest;
      const outcome = yield* callback(new URL(request.url), request.headers.get("cookie"));
      switch (outcome._tag) {
        case "SignedIn": {
          const headers = new Headers({ location: "/" });
          headers.append("set-cookie", outcome.sessionCookie);
          headers.append("set-cookie", CLEAR_STATE_COOKIE);
          return respond(new Response(null, { status: 302, headers }));
        }
        case "NotAllowed":
          return respond(
            page(
              403,
              "This instance is private",
              "This Google account is not allowed to use this instance.",
              [CLEAR_STATE_COOKIE],
            ),
          );
        case "Failed":
          return respond(
            page(outcome.status, "Sign-in failed", outcome.message, [CLEAR_STATE_COOKIE]),
          );
      }
    }),
  ),
]);
