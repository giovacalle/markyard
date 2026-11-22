// Wire parity with Rust: the golden cookies in `fixtures/session-golden.json` were sealed by
// `bff_core::session::seal` / `seal_session`. TS must produce the same strings and open them.

import { readFileSync } from "node:fs";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { sealSession } from "../src/application/auth.ts";
import type { CookieKey } from "../src/application/config.ts";
import { CookieSealer } from "../src/application/ports.ts";
import { decodeSession } from "../src/domain/session.ts";
import {
  importKeyring,
  makeCookieSealer,
  seal,
  unseal,
} from "../src/infrastructure/cookie-seal.ts";

interface Vector {
  readonly name: string;
  readonly fn: "seal" | "seal_session";
  readonly keys: ReadonlyArray<readonly [number, string]>;
  readonly nonceByte: number;
  readonly value: Record<string, unknown>;
  readonly cookie: string;
}

const { vectors } = JSON.parse(
  readFileSync(new URL("fixtures/session-golden.json", import.meta.url), "utf8"),
) as {
  vectors: ReadonlyArray<Vector>;
};

const keysOf = (v: Vector): Array<CookieKey> =>
  v.keys.map(([version, hex]) => ({
    version,
    key: Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16)),
  }));

describe("session golden vectors", () => {
  it("has vectors", () => expect(vectors.length).toBeGreaterThanOrEqual(5));

  for (const v of vectors) {
    it(`${v.name}: TS seals the identical cookie`, async () => {
      const keyring = await importKeyring(keysOf(v));
      const nonce = new Uint8Array(12).fill(v.nonceByte);
      const sealed =
        v.fn === "seal"
          ? await seal(keyring, JSON.stringify(v.value), nonce)
          : await Effect.runPromise(
              sealSession(decodeSession(v.value)!, nonce).pipe(
                Effect.provideService(CookieSealer, makeCookieSealer(keyring)),
              ),
            );
      expect(sealed).toBe(v.cookie);
    });

    it(`${v.name}: TS opens the Rust cookie`, async () => {
      const plaintext = await unseal(await importKeyring(keysOf(v)), v.cookie);
      expect(plaintext).toBeDefined();
      const opened = JSON.parse(plaintext!) as Record<string, unknown>;
      if (v.fn === "seal") expect(opened).toEqual(v.value);
      else expect(opened).toEqual({ rt: v.value["rt"], email: v.value["email"] });
    });
  }
});
