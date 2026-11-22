// Port of the Rust `core/src/session.rs` tests.

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { sealSession } from "../src/application/auth.ts";
import type { CookieKey } from "../src/application/config.ts";
import { CookieSealer } from "../src/application/ports.ts";
import {
  decodeSession,
  encodeSession,
  parseJson,
  SESSION_COOKIE,
  type Session,
} from "../src/domain/session.ts";
import {
  importKeyring,
  makeCookieSealer,
  seal,
  unseal,
} from "../src/infrastructure/cookie-seal.ts";
import { tamper } from "./support/harness.ts";

const K1 = new Uint8Array(32).fill(3);
const K2 = new Uint8Array(32).fill(9);

const makeSession = (rtLen: number, atLen?: number): Session =>
  atLen === undefined
    ? { rt: "r".repeat(rtLen), email: "owner@example.com" }
    : {
        rt: "r".repeat(rtLen),
        at: "a".repeat(atLen),
        exp: 1_800_000_000,
        email: "owner@example.com",
      };

const sealWith = async (session: Session, keys: ReadonlyArray<CookieKey>, nonceByte: number) =>
  seal(await importKeyring(keys), encodeSession(session), new Uint8Array(12).fill(nonceByte));

const unsealSession = async (
  cookie: string,
  keys: ReadonlyArray<CookieKey>,
): Promise<Session | undefined> => {
  const plaintext = await unseal(await importKeyring(keys), cookie);
  return plaintext === undefined ? undefined : decodeSession(parseJson(plaintext));
};

describe("session", () => {
  it("round_trip_tamper_unknown_version_wrong_key_and_empty", async () => {
    const keys = [{ version: 1, key: K1 }];
    const original = makeSession(103, 250);
    const cookie = await sealWith(original, keys, 1);

    expect(await unsealSession(cookie, keys)).toEqual(original);
    expect(await unsealSession(tamper(cookie), keys), "tampered byte should fail").toBeUndefined();
    expect(
      await unsealSession(cookie, [{ version: 2, key: K1 }]),
      "unknown key version",
    ).toBeUndefined();
    expect(
      await unsealSession(cookie, [{ version: 1, key: new Uint8Array(32).fill(4) }]),
      "wrong key",
    ).toBeUndefined();
    expect(await unsealSession("", keys), "empty string should fail").toBeUndefined();
  });

  it("seal_uses_highest_key_version_and_unseal_accepts_older_version", async () => {
    const original = makeSession(103, 250);
    const v1Cookie = await sealWith(original, [{ version: 1, key: K1 }], 2);
    const rotatedKeys = [
      { version: 1, key: K1 },
      { version: 2, key: K2 },
    ];
    const rotatedCookie = await sealWith(original, rotatedKeys, 2);

    expect(await unsealSession(rotatedCookie, [{ version: 2, key: K2 }])).toEqual(original);
    expect(await unsealSession(rotatedCookie, [{ version: 1, key: K1 }])).toBeUndefined();
    expect(await unsealSession(v1Cookie, rotatedKeys)).toEqual(original);
  });

  it("seal_session_drops_access_token_when_cookie_would_exceed_4096_bytes", async () => {
    const keys = [{ version: 1, key: K1 }];
    const oversized = makeSession(512, 4000);
    const sealer = makeCookieSealer(await importKeyring(keys));
    const value = await Effect.runPromise(
      sealSession(oversized, new Uint8Array(12).fill(5)).pipe(
        Effect.provideService(CookieSealer, sealer),
      ),
    );

    expect(`${SESSION_COOKIE}=${value}`.length).toBeLessThanOrEqual(4096);
    const unsealed = await unsealSession(value, keys);
    expect(unsealed).toEqual({ rt: oversized.rt, email: oversized.email });
  });
});
