// Byte encodings shared by the cookie format and the PKCE sign-in.

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const base64UrlNoPad = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Strict URL-safe base64 without padding, as Rust `URL_SAFE_NO_PAD.decode` accepts it. */
export const decodeBase64UrlNoPad = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Rust rejects trailing bits that are not zero; re-encoding must give back the same text.
  return base64UrlNoPad(out) === text ? out : undefined;
};

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
