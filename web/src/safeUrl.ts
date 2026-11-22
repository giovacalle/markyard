/**
 * The image URL the Preview may load, or `null`. Only root-relative same-origin paths pass
 * (attachments are `/api/files/<id>/blob`): the CSP blocks other origins anyway, and schemes such
 * as `javascript:` or `data:` never reach an `<img>`.
 */
export function safeImageSrc(src: unknown): string | null {
  if (typeof src !== "string") {
    return null;
  }
  const trimmed = src.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return null;
  }
  try {
    return new URL(trimmed, window.location.origin).origin === window.location.origin
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

/** Whether `href` is an absolute `http(s)://` URL to another site (not a wikilink or anchor). */
export function isExternalHref(href: unknown): href is string {
  if (typeof href !== "string" || !/^https?:\/\//i.test(href.trim())) {
    return false;
  }
  try {
    new URL(href.trim());
    return true;
  } catch {
    return false;
  }
}
