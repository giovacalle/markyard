// Sealed cookie primitive on WebCrypto, byte-identical to Rust `core/src/session.rs`:
// base64url_nopad(key_version(1) | nonce(12) | AES-256-GCM(plaintext) incl. 16-byte tag), aad = [version].

import * as Effect from "effect/Effect";

import type { CookieKey } from "../application/config.ts";
import { CookieSealer } from "../application/ports.ts";
import { base64UrlNoPad, concatBytes, decodeBase64UrlNoPad, utf8 } from "../domain/encoding.ts";

export interface Keyring {
  /** Ascending by version; the last one seals. */
  readonly keys: ReadonlyArray<{ readonly version: number; readonly key: CryptoKey }>;
}

const bytes = (b: Uint8Array): BufferSource => b as BufferSource;

export const importKeyring = async (keys: ReadonlyArray<CookieKey>): Promise<Keyring> => ({
  keys: await Promise.all(
    [...keys]
      .sort((a, b) => a.version - b.version)
      .map(async ({ version, key }) => ({
        version,
        key: await crypto.subtle.importKey("raw", bytes(key), "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
      })),
  ),
});

export const seal = async (
  keyring: Keyring,
  plaintext: string,
  nonce: Uint8Array,
): Promise<string> => {
  const newest = keyring.keys[keyring.keys.length - 1];
  if (newest === undefined) throw new Error("at least one cookie key");
  const kid = Uint8Array.of(newest.version);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytes(nonce), additionalData: bytes(kid) },
    newest.key,
    bytes(utf8(plaintext)),
  );
  return base64UrlNoPad(concatBytes([kid, nonce, new Uint8Array(ct)]));
};

export const unseal = async (keyring: Keyring, cookie: string): Promise<string | undefined> => {
  const raw = decodeBase64UrlNoPad(cookie);
  if (raw === undefined || raw.length < 13 + 16) return undefined;
  const kid = raw[0]!;
  const entry = keyring.keys.find((k) => k.version === kid);
  if (entry === undefined) return undefined;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(raw.slice(1, 13)), additionalData: bytes(Uint8Array.of(kid)) },
      entry.key,
      bytes(raw.slice(13)),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(pt);
  } catch {
    return undefined;
  }
};

/** The `CookieSealer` port over an imported keyring. */
export const makeCookieSealer = (keyring: Keyring): CookieSealer["Service"] => ({
  seal: (plaintext, nonce) => Effect.promise(() => seal(keyring, plaintext, nonce)),
  unseal: (cookie) => Effect.promise(() => unseal(keyring, cookie)),
});
