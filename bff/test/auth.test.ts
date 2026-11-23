// Port of the Rust `core/tests/auth.rs` tests (sign-in, session and refresh, same-origin, logout).

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { sealSession } from "../src/application/auth.ts";
import { CookieSealer } from "../src/application/ports.ts";
import { encodeSession, MAX_COOKIE_NAME_VALUE_BYTES } from "../src/domain/session.ts";
import { page } from "../src/http/routes/auth-pages.ts";
import { importKeyring, makeCookieSealer } from "../src/infrastructure/cookie-seal.ts";

import {
  AT,
  CLEAR_SESSION,
  CLEAR_STATE,
  EMAIL,
  FakeGoogle,
  formPairs,
  get,
  json,
  KEY_1,
  KEYS_1,
  leaks,
  NEW_AT,
  NOW,
  ORIGIN,
  on,
  request,
  RT,
  send,
  SESSION_ATTRS,
  sessionCookie,
  sessionCookieOf,
  setCookies,
  storedSession,
  tamper,
  testEnv,
  cookieKeysBinding,
  text,
  unreachable,
  sealWith,
  unsealWith,
  urlLeaks,
} from "./support/harness.ts";

const base64UrlNoPad = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const challengeOf = async (verifier: string): Promise<string> =>
  base64UrlNoPad(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

const queryPairs = (location: string): Array<[string, string]> =>
  formPairs(location.slice(location.indexOf("?") + 1));

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("login", () => {
  it("login_redirects_to_google_with_state_pkce_offline_consent_and_drive_scope", async () => {
    const google = new FakeGoogle();
    const res = await send(get("/api/auth/login"), { google });

    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith("https://fake.test/auth?")).toBe(true);

    const state = "000102030405060708090a0b0c0d0e0f";
    const verifier = base64UrlNoPad(Uint8Array.from({ length: 32 }, (_, i) => i + 16));
    expect(queryPairs(location)).toEqual(
      formPairs(
        new URLSearchParams([
          ["access_type", "offline"],
          ["client_id", "client-id.test"],
          ["code_challenge", await challengeOf(verifier)],
          ["code_challenge_method", "S256"],
          ["prompt", "consent"],
          ["redirect_uri", "https://notes.test/api/auth/callback"],
          ["response_type", "code"],
          ["scope", "https://www.googleapis.com/auth/drive"],
          ["state", state],
        ]).toString(),
      ),
    );

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.startsWith("__Host-state=")).toBe(true);
    const rest = cookies[0]!.slice("__Host-state=".length);
    const semi = rest.indexOf(";");
    expect(rest.slice(semi + 1)).toBe(" Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600");
    const sealed = (await unsealWith(KEYS_1, rest.slice(0, semi))) as Record<string, unknown>;
    expect(sealed["state"]).toBe(state);
    expect(sealed["verifier"]).toBe(verifier);

    expect(google.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

const STATE = "000102030405060708090a0b0c0d0e0f";

const tokenOk = () =>
  json(200, { access_token: AT, refresh_token: RT, expires_in: 3599, token_type: "Bearer" });

const aboutOk = (email: string, displayName?: unknown) =>
  json(200, {
    user:
      displayName === undefined ? { emailAddress: email } : { displayName, emailAddress: email },
  });

/** Runs the real login route: the sealed state cookie value and the `code_challenge` Google got. */
const startLogin = async (): Promise<{ cookie: string; challenge: string }> => {
  const res = await send(get("/api/auth/login"));
  const cookie = setCookies(res)[0]!.slice("__Host-state=".length).split(";")[0]!;
  const challenge = queryPairs(res.headers.get("location")!).find(
    ([k]) => k === "code_challenge",
  )![1];
  return { cookie, challenge };
};

const callback = (query: string, stateCookie?: string): Request =>
  get(
    `/api/auth/callback?${query}`,
    stateCookie === undefined ? {} : { cookie: `theme=dark; __Host-state=${stateCookie}` },
  );

const expectHtmlPage = async (res: Response, status: number, textPart: string) => {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const body = await res.clone().text();
  expect(body).toContain(textPart);
  expect(body).toContain('href="/"');
  expect(body).not.toContain("<script");
  expect(body).not.toContain("style");
};

const expectStateClearedAndNoSession = (res: Response) => {
  const cookies = setCookies(res);
  expect(cookies).toContain(CLEAR_STATE);
  expect(cookies.some((c) => c.startsWith("__Host-s="))).toBe(false);
};

describe("callback", () => {
  it("callback_rejects_missing_wrong_or_tampered_state", async () => {
    const { cookie } = await startLogin();
    const cases: Array<[string, Request]> = [
      ["no state cookie", callback(`code=c&state=${STATE}`)],
      ["no state in query", callback("code=c", cookie)],
      ["wrong state", callback("code=c&state=ffffffffffffffffffffffffffffffff", cookie)],
      ["tampered cookie", callback(`code=c&state=${STATE}`, tamper(cookie))],
    ];
    for (const [label, req] of cases) {
      const google = new FakeGoogle();
      const res = await send(req, { google });
      await expectHtmlPage(res, 400, "Sign-in failed");
      expectStateClearedAndNoSession(res);
      expect(google.calls, `${label}: upstream was called`).toEqual([]);
    }
  });

  it("callback_with_google_error_param_is_400_without_upstream", async () => {
    const { cookie } = await startLogin();
    const google = new FakeGoogle();
    const res = await send(callback(`error=access_denied&state=${STATE}`, cookie), { google });

    await expectHtmlPage(res, 400, "Sign-in failed");
    expectStateClearedAndNoSession(res);
    expect(google.calls).toEqual([]);
  });

  it("callback_for_allowed_account_sets_strict_session_cookie", async () => {
    const { cookie, challenge } = await startLogin();
    const google = new FakeGoogle([
      on("POST", "https://fake.test/token", tokenOk()),
      on("GET", "https://fake.test/drive/v3/about", aboutOk("Owner@Example.COM")),
    ]);
    const res = await send(callback(`code=auth-code-1&state=${STATE}`, cookie), { google });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await leaks(res, [AT, RT])).toEqual([]);
    expect(urlLeaks(google, [AT, RT])).toEqual([]);

    const session = sessionCookieOf(res)!;
    expect(session.attrs).toBe(SESSION_ATTRS);
    expect(await unsealWith(KEYS_1, session.value)).toEqual({
      rt: RT,
      at: AT,
      exp: NOW + 3599,
      email: "Owner@Example.COM",
    });
    expect(setCookies(res)).toContain(CLEAR_STATE);

    const tokenCalls = google.callsTo("POST", "https://fake.test/token");
    expect(tokenCalls).toHaveLength(1);
    const form = formPairs(tokenCalls[0]!.text);
    const verifier = form.find(([k]) => k === "code_verifier")![1];
    expect(await challengeOf(verifier)).toBe(challenge);
    expect(form.filter(([k]) => k !== "code_verifier")).toEqual([
      ["client_id", "client-id.test"],
      ["client_secret", "client-secret-value"],
      ["code", "auth-code-1"],
      ["grant_type", "authorization_code"],
      ["redirect_uri", "https://notes.test/api/auth/callback"],
    ]);
    expect(google.calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    const aboutCalls = google.callsTo("GET", "https://fake.test/drive/v3/about");
    expect(aboutCalls).toHaveLength(1);
    expect(aboutCalls[0]!.headers.get("authorization")).toBe("Bearer ya29.access-token-value");
    expect(google.callsTo("POST", "https://fake.test/revoke")).toEqual([]);
  });

  it("callback_for_stranger_revokes_grant_and_shows_private_page", async () => {
    const { cookie } = await startLogin();
    const google = new FakeGoogle([
      on("POST", "https://fake.test/token", tokenOk()),
      on("GET", "https://fake.test/drive/v3/about", aboutOk("stranger@example.com")),
      on("POST", "https://fake.test/revoke", text(200, "{}")),
    ]);
    const res = await send(callback(`code=auth-code-1&state=${STATE}`, cookie), { google });

    await expectHtmlPage(res, 403, "private");
    expectStateClearedAndNoSession(res);
    expect(await leaks(res, [AT, RT])).toEqual([]);
    expect(urlLeaks(google, [AT, RT])).toEqual([]);

    const revokes = google.callsTo("POST", "https://fake.test/revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.url).toBe("https://fake.test/revoke");
    expect(revokes[0]!.text).toBe(`token=${RT.replace(/\//g, "%2F")}`);
  });

  it("callback_token_failure_is_502_without_session_or_revoke", async () => {
    const { cookie } = await startLogin();
    const google = new FakeGoogle([
      on(
        "POST",
        "https://fake.test/token",
        text(400, '{"error":"invalid_grant","secret":"leak-me"}'),
      ),
    ]);
    const res = await send(callback(`code=auth-code-1&state=${STATE}`, cookie), { google });

    await expectHtmlPage(res, 502, "Sign-in failed");
    expectStateClearedAndNoSession(res);
    expect(await leaks(res, ["leak-me"])).toEqual([]);
    expect(google.callsTo("POST", "https://fake.test/revoke")).toEqual([]);
  });

  it("callback_about_failure_is_502_without_session_or_revoke", async () => {
    const { cookie } = await startLogin();
    const google = new FakeGoogle([
      on("POST", "https://fake.test/token", tokenOk()),
      on("GET", "https://fake.test/drive/v3/about", text(500, "boom")),
      on("POST", "https://fake.test/revoke", text(200, "{}")),
    ]);
    const res = await send(callback(`code=auth-code-1&state=${STATE}`, cookie), { google });

    await expectHtmlPage(res, 502, "Sign-in failed");
    expectStateClearedAndNoSession(res);
    expect(await leaks(res, [AT, RT])).toEqual([]);
    expect(urlLeaks(google, [AT, RT])).toEqual([]);
    expect(google.callsTo("POST", "https://fake.test/revoke")).toEqual([]);
  });

  it("callback_token_without_refresh_token_is_502_without_session_or_revoke", async () => {
    const { cookie } = await startLogin();
    const google = new FakeGoogle([
      on("POST", "https://fake.test/token", json(200, { access_token: AT, expires_in: 3599 })),
      on("GET", "https://fake.test/drive/v3/about", aboutOk(EMAIL)),
      on("POST", "https://fake.test/revoke", text(200, "{}")),
    ]);
    const res = await send(callback(`code=auth-code-1&state=${STATE}`, cookie), { google });

    await expectHtmlPage(res, 502, "Sign-in failed");
    expectStateClearedAndNoSession(res);
    expect(await leaks(res, [AT])).toEqual([]);
    expect(urlLeaks(google, [AT])).toEqual([]);
    expect(google.callsTo("POST", "https://fake.test/revoke")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session and refresh
// ---------------------------------------------------------------------------

const sessionReq = (cookie?: string): Request =>
  get("/api/session", cookie === undefined ? {} : { cookie: `theme=dark; __Host-s=${cookie}` });

const refreshOk = () => json(200, { access_token: NEW_AT, expires_in: 3599, token_type: "Bearer" });

const SESSION_ENDED = {
  code: "unauthenticated",
  message: "Your session has ended. Sign in again.",
  reason: "session_ended",
};

describe("session", () => {
  it("session_without_cookie_is_401_without_reason_and_calls_nothing", async () => {
    const google = new FakeGoogle();
    const res = await send(sessionReq(), { google });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"code":"unauthenticated","message":"Not signed in"}');
    expect(setCookies(res)).toEqual([]);
    expect(google.calls).toEqual([]);
  });

  it("tampered_or_unknown_key_version_cookie_is_401_session_ended_and_cleared", async () => {
    const valid = await sessionCookie(storedSession(1_800_003_600));
    const unknownVersion = await sessionCookie(storedSession(1_800_003_600), [
      { version: 9, key: KEY_1 },
    ]);
    for (const [label, cookie] of [
      ["tampered", tamper(valid)],
      ["unknown key version", unknownVersion],
      ["empty", ""],
    ] as const) {
      const google = new FakeGoogle();
      const res = await send(sessionReq(cookie), { google });

      expect(res.status, label).toBe(401);
      expect(await res.text(), label).toBe(JSON.stringify(SESSION_ENDED));
      expect(setCookies(res), label).toEqual([CLEAR_SESSION]);
      expect(google.calls, label).toEqual([]);
    }
  });

  it("session_with_valid_access_token_returns_email_without_upstream", async () => {
    const cookie = await sessionCookie(storedSession(NOW + 61));
    const google = new FakeGoogle();
    const res = await send(sessionReq(cookie), { google });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.clone().json()).toEqual({ email: EMAIL });
    expect(setCookies(res)).toEqual([]);
    expect(await leaks(res, [AT, RT])).toEqual([]);
    expect(google.calls).toEqual([]);
  });

  it("expired_access_token_is_refreshed_and_cookie_rewritten", async () => {
    // 59 seconds left is inside the 60 second safety margin, so it counts as expired.
    const cookie = await sessionCookie(storedSession(NOW + 59));
    const google = new FakeGoogle([on("POST", "https://fake.test/token", refreshOk())]);
    const res = await send(sessionReq(cookie), { google });

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ email: EMAIL });
    expect(await leaks(res, [AT, RT, NEW_AT])).toEqual([]);
    expect(urlLeaks(google, [AT, RT, NEW_AT])).toEqual([]);

    const renewed = sessionCookieOf(res)!;
    expect(renewed.attrs).toBe(SESSION_ATTRS);
    expect(await unsealWith(KEYS_1, renewed.value)).toEqual({
      rt: RT,
      at: NEW_AT,
      exp: NOW + 3599,
      email: EMAIL,
    });

    const calls = google.callsTo("POST", "https://fake.test/token");
    expect(calls).toHaveLength(1);
    expect(formPairs(calls[0]!.text)).toEqual([
      ["client_id", "client-id.test"],
      ["client_secret", "client-secret-value"],
      ["grant_type", "refresh_token"],
      ["refresh_token", RT],
    ]);
    expect(google.calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("session_without_cached_access_token_is_refreshed", async () => {
    const cookie = await sessionCookie(storedSession());
    const google = new FakeGoogle([on("POST", "https://fake.test/token", refreshOk())]);
    const res = await send(sessionReq(cookie), { google });

    expect(res.status).toBe(200);
    const renewed = (await unsealWith(KEYS_1, sessionCookieOf(res)!.value)) as Record<
      string,
      unknown
    >;
    expect(renewed["at"]).toBe(NEW_AT);
  });

  it("key_rotation_unseals_old_version_and_reseals_with_newest", async () => {
    const key2 = new Uint8Array(32).fill(8);
    const oldCookie = await sessionCookie(storedSession(1));
    const env = testEnv({
      COOKIE_KEYS: cookieKeysBinding([
        { version: 1, key: KEY_1 },
        { version: 2, key: key2 },
      ]),
    });
    const google = new FakeGoogle([
      on(
        "POST",
        "https://fake.test/token",
        json(200, { access_token: NEW_AT, refresh_token: "1//rotated-refresh", expires_in: 3599 }),
      ),
    ]);
    const res = await send(sessionReq(oldCookie), { google, env });

    expect(res.status).toBe(200);
    // Only key 2 is offered: the rewritten cookie must have been sealed with the newest key.
    const renewed = (await unsealWith(
      [{ version: 2, key: key2 }],
      sessionCookieOf(res)!.value,
    )) as Record<string, unknown>;
    expect(renewed["rt"]).toBe("1//rotated-refresh");
    expect(renewed["at"]).toBe(NEW_AT);
  });

  it("refused_refresh_invalid_grant_clears_cookie_and_answers_401_session_ended", async () => {
    const cookie = await sessionCookie(storedSession(1));
    const google = new FakeGoogle([
      on(
        "POST",
        "https://fake.test/token",
        json(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
      ),
    ]);
    const res = await send(sessionReq(cookie), { google });

    expect(res.status).toBe(401);
    expect(await res.clone().json()).toEqual(SESSION_ENDED);
    expect(setCookies(res)).toEqual([CLEAR_SESSION]);
    expect(await leaks(res, [AT, RT])).toEqual([]);
  });

  it("refresh_invalid_client_is_502_and_keeps_cookie", async () => {
    const cookie = await sessionCookie(storedSession(1));
    for (const status of [400, 401]) {
      const google = new FakeGoogle([
        on("POST", "https://fake.test/token", json(status, { error: "invalid_client" })),
      ]);
      const res = await send(sessionReq(cookie), { google });

      expect(res.status, `HTTP ${status}`).toBe(502);
      const body = (await res.clone().json()) as Record<string, unknown>;
      expect(body["code"]).toBe("upstream_error");
      expect(body).not.toHaveProperty("reason");
      expect(setCookies(res), `HTTP ${status}`).toEqual([]);
      expect(await leaks(res, [AT, RT])).toEqual([]);
    }
  });

  it("refresh_upstream_5xx_or_transport_error_is_502_and_keeps_cookie", async () => {
    const cookie = await sessionCookie(storedSession(1));
    for (const answer of [text(503, "unavailable"), unreachable("connection reset")]) {
      const google = new FakeGoogle([on("POST", "https://fake.test/token", answer)]);
      const res = await send(sessionReq(cookie), { google });

      expect(res.status).toBe(502);
      expect(((await res.clone().json()) as Record<string, unknown>)["code"]).toBe(
        "upstream_error",
      );
      expect(setCookies(res)).toEqual([]);
      expect(await leaks(res, [AT, RT])).toEqual([]);
      expect(urlLeaks(google, [AT, RT])).toEqual([]);
    }
  });

  it("removing_email_from_allowed_emails_invalidates_active_and_expired_sessions", async () => {
    const freshCookie = await sessionCookie(storedSession(NOW + 3600));
    const expiredCookie = await sessionCookie(storedSession(NOW - 10));
    const env = testEnv({ ALLOWED_EMAILS: "other@example.com" });

    for (const [label, cookie] of [
      ["fresh", freshCookie],
      ["expired", expiredCookie],
    ] as const) {
      const google = new FakeGoogle();
      const res = await send(sessionReq(cookie), { google, env });

      expect(res.status, label).toBe(401);
      expect(await res.clone().json(), label).toEqual(SESSION_ENDED);
      expect(setCookies(res), label).toEqual([CLEAR_SESSION]);
      expect(google.calls, label).toEqual([]);
    }
  });

  it("allowed_emails_check_on_active_session_is_case_insensitive_and_honors_wildcard", async () => {
    const mixedCaseCookie = await sessionCookie({
      ...storedSession(NOW + 3600),
      email: "Owner@Example.COM",
    });
    const resCase = await send(sessionReq(mixedCaseCookie), {
      env: testEnv({ ALLOWED_EMAILS: "owner@example.com" }),
    });
    expect(resCase.status).toBe(200);

    const anyCookie = await sessionCookie({
      ...storedSession(NOW + 3600),
      email: "anyone@example.com",
    });
    const resWildcard = await send(sessionReq(anyCookie), {
      env: testEnv({ ALLOWED_EMAILS: "*" }),
    });
    expect(resWildcard.status).toBe(200);
  });

  it("auth_error_page_escapes_html_metacharacters", async () => {
    const res = page(400, 'Bad <script>"title"</script>', "Msg & 'quotes' > <img src=x>", []);
    const body = await res.text();
    expect(body).toContain("<title>Bad &lt;script&gt;&quot;title&quot;&lt;/script&gt;</title>");
    expect(body).toContain("<p>Msg &amp; &#39;quotes&#39; &gt; &lt;img src=x&gt;</p>");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
  });
});

// ---------------------------------------------------------------------------
// Same-origin rule and sign out
// ---------------------------------------------------------------------------

const logout = (headers: Record<string, string>): Request =>
  request("POST", "/api/auth/logout", { headers, cookie: "__Host-s=whatever", sameOrigin: false });

describe("same-origin and logout", () => {
  it("cross_origin_post_is_rejected", async () => {
    const cases: Array<[string, Request]> = [
      ["foreign Origin", logout({ origin: "https://evil.example" })],
      [
        "own origin but cross-site fetch metadata",
        logout({ origin: ORIGIN, "sec-fetch-site": "cross-site" }),
      ],
      ["no Origin", logout({})],
    ];
    for (const [label, req] of cases) {
      const google = new FakeGoogle();
      const res = await send(req, { google });

      expect(res.status, label).toBe(403);
      expect(await res.text(), label).toBe(
        '{"code":"forbidden","message":"Cross-origin requests are not allowed"}',
      );
      expect(setCookies(res), label).toEqual([]);
      expect(google.calls, label).toEqual([]);
    }
  });

  it("logout_from_own_origin_clears_cookie", async () => {
    for (const headers of [
      { origin: ORIGIN },
      { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    ] as Array<Record<string, string>>) {
      const google = new FakeGoogle();
      const res = await send(logout(headers), { google });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(setCookies(res)).toEqual([CLEAR_SESSION]);
      expect(res.headers.get("clear-site-data")).toBe('"cache"');
      expect(google.calls).toEqual([]);
    }
  });

  it("logout_without_a_session_cookie_still_answers_204", async () => {
    const res = await send(request("POST", "/api/auth/logout"));

    expect(res.status).toBe(204);
    expect(setCookies(res)).toEqual([CLEAR_SESSION]);
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
  });
});

// ---------------------------------------------------------------------------
// Account display name
// ---------------------------------------------------------------------------

const signIn = async (about: ReturnType<typeof json>) => {
  const { cookie } = await startLogin();
  const google = new FakeGoogle([
    on("POST", "https://fake.test/token", tokenOk()),
    on("GET", "https://fake.test/drive/v3/about", about),
  ]);
  const res = await send(callback(`code=auth-code-1&state=${STATE}`, cookie), { google });
  return { res, google };
};

describe("display name", () => {
  it("callback_asks_drive_for_display_name_and_seals_it_trimmed", async () => {
    const { res, google } = await signIn(aboutOk(EMAIL, "  Ada Lovelace  "));

    expect(res.status).toBe(302);
    const aboutCalls = google.callsTo("GET", "https://fake.test/drive/v3/about");
    expect(new URL(aboutCalls[0]!.url).searchParams.get("fields")).toBe(
      "user(displayName,emailAddress)",
    );
    expect(await unsealWith(KEYS_1, sessionCookieOf(res)!.value)).toEqual({
      rt: RT,
      at: AT,
      exp: NOW + 3599,
      email: EMAIL,
      name: "Ada Lovelace",
    });
  });

  it("callback_without_usable_display_name_omits_name", async () => {
    for (const displayName of [undefined, "   ", 42, null]) {
      const { res } = await signIn(aboutOk(EMAIL, displayName));
      const sealed = (await unsealWith(KEYS_1, sessionCookieOf(res)!.value)) as Record<
        string,
        unknown
      >;
      expect(sealed, String(displayName)).not.toHaveProperty("name");
      expect(sealed["email"]).toBe(EMAIL);
    }
  });

  it("session_returns_name_from_cookie_without_upstream", async () => {
    const cookie = await sessionCookie({ ...storedSession(NOW + 3600), name: "Ada Lovelace" });
    const google = new FakeGoogle();
    const res = await send(sessionReq(cookie), { google });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: EMAIL, name: "Ada Lovelace" });
    expect(google.calls).toEqual([]);
  });

  it("old_cookie_without_name_still_answers_email_only", async () => {
    // A cookie sealed before `name` existed: exactly `{rt, at, exp, email}`.
    const raw = JSON.stringify({ rt: RT, at: AT, exp: NOW + 3600, email: EMAIL });
    const google = new FakeGoogle();
    const res = await send(sessionReq(await sealWith(KEYS_1, raw)), { google });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: EMAIL });
    expect(google.calls).toEqual([]);
  });

  it("refresh_preserves_name", async () => {
    const cookie = await sessionCookie({ ...storedSession(NOW + 59), name: "Ada Lovelace" });
    const google = new FakeGoogle([on("POST", "https://fake.test/token", refreshOk())]);
    const res = await send(sessionReq(cookie), { google });

    expect(await res.json()).toEqual({ email: EMAIL, name: "Ada Lovelace" });
    expect(await unsealWith(KEYS_1, sessionCookieOf(res)!.value)).toEqual({
      rt: RT,
      at: NEW_AT,
      exp: NOW + 3599,
      email: EMAIL,
      name: "Ada Lovelace",
    });
  });

  it("oversized_cookie_drops_at_and_exp_but_keeps_name", async () => {
    const sealer = makeCookieSealer(await importKeyring(KEYS_1));
    const session = {
      rt: "r".repeat(200),
      at: "a".repeat(4000),
      exp: NOW,
      email: EMAIL,
      name: "Ada Lovelace",
    };
    const value = await Effect.runPromise(
      sealSession(session, new Uint8Array(12).fill(1)).pipe(
        Effect.provideService(CookieSealer, sealer),
      ),
    );
    expect(`__Host-s=${value}`.length).toBeLessThanOrEqual(MAX_COOKIE_NAME_VALUE_BYTES);
    expect(await unsealWith(KEYS_1, value)).toEqual({
      rt: session.rt,
      email: EMAIL,
      name: "Ada Lovelace",
    });
  });

  it("encoded_name_follows_email_and_is_capped", () => {
    const long = "n".repeat(250);
    expect(encodeSession({ rt: RT, email: EMAIL, name: long })).toBe(
      JSON.stringify({ rt: RT, email: EMAIL, name: "n".repeat(200) }),
    );
  });
});
