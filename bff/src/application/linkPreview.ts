// Link preview use cases: `GET /api/link-preview` reads a public page's `<head>` metadata and
// `GET /api/link-preview/image` proxies a public raster image, so the web app renders both under
// its strict same-origin CSP. Every URL fetched (the first and each redirect hop) passes the
// SSRF guard of `domain/linkPreview.ts`; redirects are followed by hand, at most three.

import * as Effect from "effect/Effect";

import {
  invalidRequest,
  linkUnreachable,
  notFound,
  previewImageTooLarge,
  type InvalidRequest,
  type NotFound,
  type TooLarge,
  type UpstreamError,
} from "../domain/errors.ts";
import {
  FETCH_TIMEOUT_MS,
  HEAD_END,
  HTML_ACCEPT,
  IMAGE_ACCEPT,
  MAX_HEAD_BYTES,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_REDIRECTS,
  PREVIEW_USER_AGENT,
  charsetOf,
  isHtml,
  isRedirect,
  parseHeadMetadata,
  previewImageMimeOf,
  validatePublicUrl,
  type HeadMetadata,
  type PreviewImageMime,
} from "../domain/linkPreview.ts";
import { parseContentLength } from "../domain/files.ts";
import { byteCapped } from "../infrastructure/streams.ts";
import { AppConfig, ResponseSink, Upstream } from "./ports.ts";

export const BLOCKED_URL = "The link must be a public http or https URL.";
export const NOT_A_PREVIEW_IMAGE = "Only PNG, JPEG, WebP, GIF and ICO images can be previewed.";

/** A previewed page may be cached by the browser for an hour. */
export const PREVIEW_CACHE_CONTROL = "private, max-age=3600, no-transform";
/** A proxied preview image may be cached by the browser for a day. */
export const PREVIEW_IMAGE_CACHE_CONTROL = "private, max-age=86400, no-transform";

type FetchFailure = InvalidRequest | NotFound | UpstreamError;

/** Drops an unread body without waiting for it. */
const discard = (response: Response): void => {
  if (response.body !== null && !response.body.locked)
    response.body.cancel().catch(() => undefined);
};

/** The normalized origin of `PUBLIC_ORIGIN`, never fetched by the previewer to avoid self-loops. */
const ownOrigin: Effect.Effect<string, never, AppConfig> = Effect.map(AppConfig, (config) => {
  try {
    return new URL(config.publicOrigin).origin;
  } catch {
    return config.publicOrigin;
  }
});

const guarded = (
  raw: string | null,
  disallowedOrigin: string,
): Effect.Effect<URL, InvalidRequest> => {
  const url = validatePublicUrl(raw, disallowedOrigin);
  return url === undefined ? Effect.fail(invalidRequest(BLOCKED_URL)) : Effect.succeed(url);
};

/** The 2xx answer of a public URL and the URL it finally came from. */
export interface Fetched {
  readonly response: Response;
  readonly finalUrl: URL;
}

/**
 * GETs a guarded URL with `redirect: "manual"`, following up to `MAX_REDIRECTS` hops and
 * guarding each `Location` before it is asked. One deadline covers every hop and the body. A
 * blocked hop is 400, an upstream 404/410 is 404, anything else that is not 2xx is 502.
 */
export const safeFetch = (
  start: URL,
  accept: string,
): Effect.Effect<Fetched, FetchFailure, AppConfig | Upstream> =>
  Effect.gen(function* () {
    const upstream = yield* Upstream;
    const selfOrigin = yield* ownOrigin;
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let current = yield* guarded(start.href, selfOrigin);
    for (let hop = 0; ; hop++) {
      const response = yield* upstream
        .send(
          new Request(current.href, {
            method: "GET",
            redirect: "manual",
            signal,
            headers: { accept, "user-agent": PREVIEW_USER_AGENT },
          }),
        )
        .pipe(Effect.mapError(linkUnreachable));
      if (isRedirect(response.status)) {
        discard(response);
        const location = response.headers.get("location");
        if (location === null || location.trim() === "" || hop >= MAX_REDIRECTS)
          return yield* Effect.fail(linkUnreachable());
        let next: string;
        try {
          next = new URL(location.trim(), current).href;
        } catch {
          return yield* Effect.fail(invalidRequest(BLOCKED_URL));
        }
        current = yield* guarded(next, selfOrigin);
        continue;
      }
      if (response.status >= 200 && response.status < 300) return { response, finalUrl: current };
      discard(response);
      return yield* Effect.fail(
        response.status === 404 || response.status === 410 ? notFound() : linkUnreachable(),
      );
    }
  });

const decoderFor = (contentType: string | null): TextDecoder => {
  const charset = charsetOf(contentType);
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset);
    } catch {
      // An unknown label falls back to UTF-8.
    }
  }
  return new TextDecoder();
};

/**
 * The page's text up to `</head>`, reading at most `MAX_HEAD_BYTES`; the body is cancelled as
 * soon as either is reached. A read that fails midway keeps what arrived before it.
 */
export const readHead = (
  body: ReadableStream<Uint8Array>,
  decoder: TextDecoder = new TextDecoder(),
): Effect.Effect<string> =>
  Effect.promise(async () => {
    const reader = body.getReader();
    let text = "";
    let bytes = 0;
    try {
      while (bytes < MAX_HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = MAX_HEAD_BYTES - bytes;
        const chunk = value.byteLength > room ? value.subarray(0, room) : value;
        bytes += chunk.byteLength;
        const searchFrom = Math.max(0, text.length - 16);
        text += decoder.decode(chunk, { stream: true });
        const end = HEAD_END.exec(text.slice(searchFrom));
        if (end !== null) return text.slice(0, searchFrom + end.index);
      }
      return text + decoder.decode();
    } catch {
      return text;
    } finally {
      reader.cancel().catch(() => undefined);
    }
  });

/** The answer of `GET /api/link-preview`. Key order is the wire order. */
export interface LinkPreview extends HeadMetadata {
  readonly url: string;
  readonly finalUrl: string;
  readonly hostname: string;
}

/**
 * `GET /api/link-preview?url=`: the page's title, description, site name, image and icon. A
 * non-HTML answer is not read and previews as its URL and host only.
 */
export const linkPreview = (
  rawUrl: string | null,
): Effect.Effect<LinkPreview, FetchFailure, AppConfig | Upstream | ResponseSink> =>
  Effect.gen(function* () {
    const selfOrigin = yield* ownOrigin;
    const url = yield* guarded(rawUrl, selfOrigin);
    const { response, finalUrl } = yield* safeFetch(url, HTML_ACCEPT);
    const base = { url: url.href, finalUrl: finalUrl.href, hostname: finalUrl.hostname };
    const contentType = response.headers.get("content-type");
    let preview: LinkPreview = base;
    if (!isHtml(contentType) || response.body === null) {
      discard(response);
    } else {
      const head = yield* readHead(response.body, decoderFor(contentType));
      preview = { ...base, ...parseHeadMetadata(head, finalUrl.href, selfOrigin) };
    }
    (yield* ResponseSink).setHeader("cache-control", PREVIEW_CACHE_CONTROL);
    return preview;
  });

/** What `GET /api/link-preview/image` answers: the checked raster type and the capped body. */
export interface PreviewImage {
  readonly mimeType: PreviewImageMime;
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * `GET /api/link-preview/image?url=`: a public raster image (400 for any other type, SVG
 * included), refused with 413 when its `Content-Length` is over 2 MiB, else streamed through a
 * byte counter that errors the stream past 2 MiB (the image is never buffered).
 */
export const previewImage = (
  rawUrl: string | null,
): Effect.Effect<PreviewImage, FetchFailure | TooLarge, AppConfig | Upstream> =>
  Effect.gen(function* () {
    const selfOrigin = yield* ownOrigin;
    const url = yield* guarded(rawUrl, selfOrigin);
    const { response } = yield* safeFetch(url, IMAGE_ACCEPT);
    const mimeType = previewImageMimeOf(response.headers.get("content-type"));
    if (mimeType === undefined) {
      discard(response);
      return yield* Effect.fail(invalidRequest(NOT_A_PREVIEW_IMAGE));
    }
    const length = parseContentLength(response.headers.get("content-length"));
    if (length !== undefined && length > MAX_PREVIEW_IMAGE_BYTES) {
      discard(response);
      return yield* Effect.fail(previewImageTooLarge());
    }
    return {
      mimeType,
      body: response.body === null ? null : byteCapped(response.body, MAX_PREVIEW_IMAGE_BYTES),
    };
  });
