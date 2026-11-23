// Link preview rules that need no I/O: the SSRF guard every outbound preview URL passes (the
// first one and every redirect hop), the limits of a fetch, the raster image allowlist of the
// image proxy, and the `<head>` metadata parser (OpenGraph, Twitter, `<title>`, icons).

import { asciiLower } from "./drive.ts";

/** Redirect hops followed after the first request; one more redirect is a failure. */
export const MAX_REDIRECTS = 3;

/** Deadline of one preview fetch, every hop and the body read included. */
export const FETCH_TIMEOUT_MS = 4_500;

/** Bytes of an HTML page read at most while looking for `</head>`. */
export const MAX_HEAD_BYTES = 65_536;

/** Size cap of an image passed through the preview image proxy: 2 MiB. */
export const MAX_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;

export const PREVIEW_USER_AGENT = "Mozilla/5.0 (compatible; markyard-link-preview/1.0)";
export const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
export const IMAGE_ACCEPT = "image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=0.1";

/** Where the web app loads a previewed image or icon from (same origin, so CSP allows it). */
export const PREVIEW_IMAGE_PATH = "/api/link-preview/image";

export const previewImageUrl = (url: string): string =>
  `${PREVIEW_IMAGE_PATH}?url=${encodeURIComponent(url)}`;

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const STANDARD_PORTS = new Set(["", "80", "443"]);

/** Names that only ever resolve inside a private network, matched as the name or a suffix. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "home.arpa", "localdomain"];

/** A label the WHATWG URL parser would read as an IPv4 number (decimal, octal or hex). */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/i;

/**
 * The URL when it is a public `http:`/`https:` URL a preview may fetch, else `undefined`.
 * Rejected: anything unparseable, other schemes, embedded credentials, ports other than the
 * standard ones, IP literals of any form, single-label and trailing-dot names, and private names
 * (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`).
 */
export const validatePublicUrl = (
  raw: string | null | undefined,
  disallowedOrigin?: string,
): URL | undefined => {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (!STANDARD_PORTS.has(url.port)) return undefined;
  if (disallowedOrigin !== undefined && url.origin === disallowedOrigin) return undefined;
  const host = asciiLower(url.hostname);
  // IPv6 literals are bracketed; the parser turns every IPv4 form into a dotted quad.
  if (host === "" || host.includes("[") || host.includes(":")) return undefined;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) return undefined;
  if (NUMERIC_LABEL.test(labels[labels.length - 1] ?? "")) return undefined;
  if (PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
    return undefined;
  return url;
};

/** The statuses whose `Location` a preview fetch follows. */
export const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/** The essence of a `Content-Type` value: trimmed, lower-cased, parameters dropped. */
export const mimeEssence = (contentType: string | null | undefined): string =>
  asciiLower(((contentType ?? "").split(";")[0] ?? "").trim());

export const isHtml = (contentType: string | null | undefined): boolean => {
  const essence = mimeEssence(contentType);
  return essence === "text/html" || essence === "application/xhtml+xml";
};

/** The `charset` parameter of a `Content-Type` value, lower-cased, if any. */
export const charsetOf = (contentType: string | null | undefined): string | undefined => {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return match?.[1] === undefined ? undefined : asciiLower(match[1]);
};

/** The raster types the image proxy passes through. SVG can carry scripts and is never served. */
export const PREVIEW_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

export type PreviewImageMime = (typeof PREVIEW_IMAGE_MIMES)[number];

export const previewImageMimeOf = (
  contentType: string | null | undefined,
): PreviewImageMime | undefined => {
  const essence = mimeEssence(contentType);
  return PREVIEW_IMAGE_MIMES.find((mime) => mime === essence);
};

// ---------------------------------------------------------------------------
// HTML entities and text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

const codePointText = (code: number): string =>
  code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? "\uFFFD"
    : String.fromCodePoint(code);

/** Decodes `&amp;`-style named entities and decimal/hex numeric references; others stay as is. */
export const decodeEntities = (text: string): string =>
  text.replace(/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X"))
      return codePointText(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return codePointText(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[asciiLower(body)] ?? whole;
  });

/** Whitespace runs collapsed to one space, trimmed, cut at `max` code points. */
export const clampText = (text: string, max: number): string =>
  Array.from(text.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();

// ---------------------------------------------------------------------------
// `<head>` metadata
// ---------------------------------------------------------------------------

export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 400;
export const MAX_SITE_NAME_CHARS = 100;

/** What a page's `<head>` says about it; image URLs are already proxy URLs. */
export interface HeadMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly siteName?: string;
  readonly image?: string;
  readonly favicon?: string;
}

type Attributes = ReadonlyMap<string, string>;

/** Comments, scripts and styles hide markup that is not part of the document head. */
const stripOpaque = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");

const TAG = /<(meta|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The attributes of a tag, names lower-cased, values decoded; the first of a name wins. */
const parseAttributes = (source: string): Attributes => {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = asciiLower(match[1] ?? "");
    if (name === "" || attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
};

const tagsOf = (html: string, tag: "meta" | "link"): Array<Attributes> =>
  Array.from(html.matchAll(TAG))
    .filter((match) => asciiLower(match[1] ?? "") === tag)
    .map((match) => parseAttributes(match[2] ?? ""));

/** `property`/`name` key (lower-cased) to the first non-empty `content` given for it. */
const metaContents = (html: string): Map<string, string> => {
  const contents = new Map<string, string>();
  for (const attributes of tagsOf(html, "meta")) {
    const content = attributes.get("content");
    if (content === undefined || content.trim() === "") continue;
    for (const keyAttribute of ["property", "name"]) {
      const key = attributes.get(keyAttribute);
      if (key === undefined) continue;
      const normalized = asciiLower(key.trim());
      if (!contents.has(normalized)) contents.set(normalized, content);
    }
  }
  return contents;
};

const titleElement = (html: string): string | undefined => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
};

const firstText = (
  candidates: ReadonlyArray<string | undefined>,
  max: number,
): string | undefined => {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const text = clampText(candidate, max);
    if (text !== "") return text;
  }
  return undefined;
};

const isSvgPath = (url: URL): boolean => /\.svgz?$/i.test(url.pathname);

/** A reference resolved against the page and passed through the SSRF guard; never SVG. */
const resolvePublic = (
  reference: string,
  base: string,
  disallowedOrigin?: string,
): URL | undefined => {
  let resolved: URL;
  try {
    resolved = new URL(reference.trim(), base);
  } catch {
    return undefined;
  }
  const url = validatePublicUrl(resolved.href, disallowedOrigin);
  return url === undefined || isSvgPath(url) ? undefined : url;
};

const IMAGE_KEYS = [
  "og:image",
  "og:image:secure_url",
  "og:image:url",
  "twitter:image",
  "twitter:image:src",
];

const RASTER_ICON_TYPE = /^image\/(?:png|x-icon|vnd\.microsoft\.icon|webp|jpeg|jpg|gif)$/;
const RASTER_ICON_PATH = /\.(?:png|ico|webp|jpe?g|gif)$/i;

/**
 * The best raster icon of the page: `<link rel="icon">` / `"shortcut icon"` first, then
 * `apple-touch-icon`, an icon known to be raster (by `type` or extension) before an unknown one,
 * document order otherwise. A `type` mentioning SVG or a `.svg` path is skipped.
 */
const favicon = (html: string, base: string, disallowedOrigin?: string): URL | undefined => {
  const candidates: Array<{ url: URL; rank: number; index: number }> = [];
  tagsOf(html, "link").forEach((attributes, index) => {
    const rel = asciiLower(attributes.get("rel") ?? "").split(/\s+/);
    const isIcon = rel.includes("icon");
    const isTouch =
      rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!isIcon && !isTouch) return;
    const type = asciiLower((attributes.get("type") ?? "").trim());
    if (type.includes("svg")) return;
    const href = attributes.get("href");
    if (href === undefined || href.trim() === "") return;
    const url = resolvePublic(href, base, disallowedOrigin);
    if (url === undefined) return;
    const raster = RASTER_ICON_TYPE.test(type) || RASTER_ICON_PATH.test(url.pathname);
    candidates.push({ url, rank: (isIcon ? 0 : 2) + (raster ? 0 : 1), index });
  });
  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return candidates[0]?.url;
};

/** The preview fields of a page's `<head>` HTML, fetched from `finalUrl`. */
export const parseHeadMetadata = (
  html: string,
  finalUrl: string,
  disallowedOrigin?: string,
): HeadMetadata => {
  const head = stripOpaque(html);
  const meta = metaContents(head);
  const title = firstText(
    [meta.get("og:title"), meta.get("twitter:title"), titleElement(head)],
    MAX_TITLE_CHARS,
  );
  const description = firstText(
    [meta.get("og:description"), meta.get("twitter:description"), meta.get("description")],
    MAX_DESCRIPTION_CHARS,
  );
  const siteName = firstText([meta.get("og:site_name")], MAX_SITE_NAME_CHARS);
  let image: URL | undefined;
  for (const key of IMAGE_KEYS) {
    const reference = meta.get(key);
    image =
      reference === undefined ? undefined : resolvePublic(reference, finalUrl, disallowedOrigin);
    if (image !== undefined) break;
  }
  const icon = favicon(head, finalUrl, disallowedOrigin);
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(image === undefined ? {} : { image: previewImageUrl(image.href) }),
    ...(icon === undefined ? {} : { favicon: previewImageUrl(icon.href) }),
  };
};

/** The `</head>` end tag (any case, optional whitespace); `</header>` does not match. */
export const HEAD_END = /<\/head\s*>/i;
