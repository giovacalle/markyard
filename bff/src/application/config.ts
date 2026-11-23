// Worker bindings parsed into the BFF configuration (port of Rust `Config::from_bindings`).
// Error messages name the binding and never echo its value.

export interface GoogleUrls {
  readonly auth: string;
  readonly token: string;
  readonly revoke: string;
  readonly drive: string;
}

export const productionGoogleUrls: GoogleUrls = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  drive: "https://www.googleapis.com",
};

/** One AES-256 cookie key and its version byte. */
export interface CookieKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface Config {
  readonly publicOrigin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Lowercased (ASCII) addresses, without the `*` wildcard. */
  readonly allowedEmails: ReadonlyArray<string>;
  /** `ALLOWED_EMAILS` lists `*`: any Google account may sign in. */
  readonly allowAllEmails: boolean;
  /** Sorted by ascending version; the last one seals. */
  readonly keys: ReadonlyArray<CookieKey>;
  readonly google: GoogleUrls;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly error: string };

class BindingError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const requireNonEmpty = (get: (name: string) => string | undefined, name: string): string => {
  const trimmed = get(name)?.trim();
  if (trimmed === undefined || trimmed === "") throw new BindingError(`missing ${name}`);
  return trimmed;
};

const parseHex32 = (hex: string): Uint8Array | undefined => {
  if (hex.length !== 64) return undefined;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    // Rust `u8::from_str_radix` also accepts a leading `+`.
    if (!/^(\+[0-9a-fA-F]|[0-9a-fA-F]{2})$/.test(pair)) return undefined;
    out[i] = Number.parseInt(pair, 16);
  }
  return out;
};

const parseCookieKeys = (raw: string): Array<CookieKey> => {
  const invalid = () => new BindingError("invalid COOKIE_KEYS");
  const keys: Array<CookieKey> = [];
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const colon = entry.indexOf(":");
    if (colon === -1) throw invalid();
    const versionText = entry.slice(0, colon).trim();
    if (!/^\+?[0-9]+$/.test(versionText)) throw invalid();
    const version = Number.parseInt(versionText, 10);
    if (version > 255) throw invalid();
    const key = parseHex32(entry.slice(colon + 1).trim());
    if (key === undefined || keys.some((k) => k.version === version)) throw invalid();
    keys.push({ version, key });
  }
  if (keys.length === 0) throw invalid();
  return keys.sort((a, b) => a.version - b.version);
};

export const parseConfig = (
  get: (name: string) => string | undefined,
  google: GoogleUrls = productionGoogleUrls,
): ConfigResult => {
  try {
    const publicOrigin = requireNonEmpty(get, "PUBLIC_ORIGIN");
    const entries = requireNonEmpty(get, "ALLOWED_EMAILS")
      .split(",")
      .map((e) => e.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()))
      .filter((e) => e !== "");
    if (entries.length === 0) throw new BindingError("invalid ALLOWED_EMAILS");
    const allowAllEmails = entries.includes("*");
    const allowedEmails = entries.filter((e) => e !== "*");
    const clientId = requireNonEmpty(get, "GOOGLE_CLIENT_ID");
    const clientSecret = requireNonEmpty(get, "GOOGLE_CLIENT_SECRET");
    const keys = parseCookieKeys(requireNonEmpty(get, "COOKIE_KEYS"));
    return {
      ok: true,
      config: {
        publicOrigin,
        clientId,
        clientSecret,
        allowedEmails,
        allowAllEmails,
        keys,
        google,
      },
    };
  } catch (e) {
    if (e instanceof BindingError) return { ok: false, error: e.message };
    throw e;
  }
};
