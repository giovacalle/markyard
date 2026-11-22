// Port of the Rust `core/src/lib.rs` tests.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { CSP, misconfigured, NO_STORE_NO_TRANSFORM, NOSNIFF } from "../src/http/app.ts";
import { FakeGoogle, get, send } from "./support/harness.ts";

const expectSecurityHeaders = (res: Response) => {
  expect(res.headers.get("content-security-policy")).toBe(
    "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe(NO_STORE_NO_TRANSFORM);
};

describe("lib", () => {
  it("health_returns_ok_version_and_security_headers_without_calling_upstream", async () => {
    const google = new FakeGoogle();
    const res = await send(get("/api/health"), { google });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expectSecurityHeaders(res);
    expect(await res.json()).toEqual({ status: "ok", version: "0.1.0" });
    expect(google.calls).toEqual([]);
  });

  it("unknown_api_route_returns_404_error_and_security_headers", async () => {
    const google = new FakeGoogle();
    const res = await send(get("/api/unknown"), { google });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe('{"code":"not_found","message":"Not found"}');
    expect(google.calls).toEqual([]);
  });

  it("static_headers_file_matches_core_security_headers", () => {
    const raw = readFileSync(new URL("../../web/public/_headers", import.meta.url), "utf8");
    expect(raw).toBe(
      `/*\n  Content-Security-Policy: ${CSP}\n  X-Content-Type-Options: ${NOSNIFF}\n`,
    );
  });

  it("misconfigured_is_500_text_with_security_headers", async () => {
    const res = misconfigured("missing COOKIE_KEYS");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe("Server misconfigured: missing COOKIE_KEYS");
  });
});
