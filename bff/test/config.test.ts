// Port of the Rust `core/src/config.rs` tests.

import { describe, expect, it } from "vite-plus/test";

import { parseConfig, productionGoogleUrls } from "../src/application/config.ts";
import { testEnv } from "./support/harness.ts";
import { get, send } from "./support/harness.ts";

const validBinding = (name: string): string | undefined =>
  ({
    PUBLIC_ORIGIN: "https://notes.example.com",
    ALLOWED_EMAILS: "  Owner@Example.COM , SECOND@Example.COM ",
    GOOGLE_CLIENT_ID: "cid-123",
    GOOGLE_CLIENT_SECRET: "super-secret-value-xyz",
    COOKIE_KEYS: `2:${"ab".repeat(32)}, 1:${"01".repeat(32)}`,
    ROOT_FOLDER_ID: " root-id-1 ",
  })[name];

const errorOf = (get: (name: string) => string | undefined): string => {
  const result = parseConfig(get);
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

describe("config", () => {
  it("from_bindings_parses_keys_sorted_and_lowercases_emails", () => {
    const result = parseConfig(validBinding);
    if (!result.ok) throw new Error(result.error);
    const cfg = result.config;
    expect(cfg.publicOrigin).toBe("https://notes.example.com");
    expect(cfg.clientId).toBe("cid-123");
    expect(cfg.clientSecret).toBe("super-secret-value-xyz");
    expect(cfg.rootFolderId).toBe("root-id-1");
    expect(cfg.allowedEmails).toEqual(["owner@example.com", "second@example.com"]);
    expect(cfg.allowAllEmails).toBe(false);
    expect(cfg.keys).toEqual([
      { version: 1, key: new Uint8Array(32).fill(0x01) },
      { version: 2, key: new Uint8Array(32).fill(0xab) },
    ]);
    expect(cfg.google).toEqual(productionGoogleUrls);
  });

  it("missing_or_invalid_binding_is_error_naming_it_without_value", () => {
    for (const missing of [
      "PUBLIC_ORIGIN",
      "ALLOWED_EMAILS",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "COOKIE_KEYS",
    ]) {
      const err = errorOf((name) => (name === missing ? undefined : validBinding(name)));
      expect(err, missing).toContain(missing);
      expect(err).not.toContain("super-secret-value-xyz");
    }

    expect(errorOf((name) => (name === "ALLOWED_EMAILS" ? " ,  " : validBinding(name)))).toContain(
      "ALLOWED_EMAILS",
    );

    const badKeySecret = "not-valid-hex-secret-material";
    const badKeyErr = errorOf((name) =>
      name === "COOKIE_KEYS" ? `1:${badKeySecret}` : validBinding(name),
    );
    expect(badKeyErr).toContain("COOKIE_KEYS");
    expect(badKeyErr).not.toContain(badKeySecret);
  });

  it("root_folder_id_is_optional", () => {
    for (const raw of [undefined, "", "   "]) {
      const result = parseConfig((name) => (name === "ROOT_FOLDER_ID" ? raw : validBinding(name)));
      if (!result.ok) throw new Error(result.error);
      expect(result.config.rootFolderId, String(raw)).toBeUndefined();
    }
  });

  it("allowed_emails_wildcard_allows_any_account", () => {
    const parse = (raw: string) => {
      const result = parseConfig((name) => (name === "ALLOWED_EMAILS" ? raw : validBinding(name)));
      if (!result.ok) throw new Error(result.error);
      return result.config;
    };
    expect(parse("*")).toMatchObject({ allowAllEmails: true, allowedEmails: [] });
    expect(parse(" Owner@Example.COM , * ")).toMatchObject({
      allowAllEmails: true,
      allowedEmails: ["owner@example.com"],
    });
    expect(parse("a@example.com,b@example.com")).toMatchObject({
      allowAllEmails: false,
      allowedEmails: ["a@example.com", "b@example.com"],
    });
  });

  // Not in Rust (it tested `misconfigured` alone): the Worker answers it for a bad binding.
  it("worker_with_missing_binding_answers_misconfigured", async () => {
    const res = await send(get("/api/health"), { env: testEnv({ COOKIE_KEYS: undefined }) });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Server misconfigured: missing COOKIE_KEYS");
  });
});
