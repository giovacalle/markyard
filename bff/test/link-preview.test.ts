// Link previews: the SSRF guard (every hop), manual redirects, `<head>` metadata parsing,
// `GET /api/link-preview` (64 KiB head read, non-HTML short answer, `Cache-Control`) and the
// `GET /api/link-preview/image` raster proxy (allowlist, 2 MiB cap, body streamed unread).

import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { readHead, safeFetch } from "../src/application/linkPreview.ts";
import {
  HTML_ACCEPT,
  MAX_HEAD_BYTES,
  MAX_PREVIEW_IMAGE_BYTES,
  PREVIEW_USER_AGENT,
  clampText,
  decodeEntities,
  parseHeadMetadata,
  previewImageMimeOf,
  previewImageUrl,
  validatePublicUrl,
} from "../src/domain/linkPreview.ts";
import { CSP, NO_STORE_NO_TRANSFORM, NOSNIFF } from "../src/http/app.ts";
import {
  FakeGoogle,
  get,
  on,
  runDirect,
  send,
  signedInCookie,
  streamOf,
  text,
  unreachable,
  type Route,
} from "./support/harness.ts";

const PREVIEW_CACHE = "private, max-age=3600, no-transform";
const IMAGE_CACHE = "private, max-age=86400, no-transform";

const html = (body: string, contentType = "text/html; charset=utf-8") =>
  text(200, body, { "content-type": contentType });

const redirect = (status: number, location?: string) =>
  text(status, "", location === undefined ? {} : { location });

/** Prefix routes, longest first, so `https://a.test/` never answers `https://a.test/next`. */
const fake = (routes: ReadonlyArray<readonly [url: string, answer: Route["answer"]]>) =>
  new FakeGoogle(
    [...routes]
      .sort(([a], [b]) => b.length - a.length)
      .map(([url, answer]) => on("GET", url, answer)),
  );

const preview = async (url: string | undefined, google: FakeGoogle): Promise<Response> =>
  send(
    get(
      url === undefined ? "/api/link-preview" : `/api/link-preview?url=${encodeURIComponent(url)}`,
      { cookie: await signedInCookie() },
    ),
    { google },
  );

const image = async (url: string, google: FakeGoogle, cookie?: string | null) =>
  send(
    get(
      `/api/link-preview/image?url=${encodeURIComponent(url)}`,
      cookie === null ? {} : { cookie: cookie ?? (await signedInCookie()) },
    ),
    { google },
  );

const jsonBody = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.clone().json()) as Record<string, unknown>;

const expectSecurityHeaders = (res: Response): void => {
  expect(res.headers.get("content-security-policy")).toBe(CSP);
  expect(res.headers.get("x-content-type-options")).toBe(NOSNIFF);
};

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A stream that records how many bytes were pulled and whether it was cancelled. */
const tracked = (chunks: ReadonlyArray<Uint8Array>, endless = false) => {
  const state = { pulled: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index] ?? (endless ? chunks[chunks.length - 1] : undefined);
      index++;
      if (chunk === undefined) return controller.close();
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
};

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

describe("validatePublicUrl", () => {
  it("accepts_public_http_and_https_urls_on_standard_ports", () => {
    for (const ok of [
      "https://example.com",
      "http://example.com/path?q=1#frag",
      "https://sub.example.co.uk:443/x",
      "http://example.com:80/",
      "https://getsill.app/",
      "https://xn--bcher-kva.example/",
      "  https://example.com/trimmed  ",
    ]) {
      expect(validatePublicUrl(ok), ok).toBeInstanceOf(URL);
    }
  });

  it("rejects_the_ssrf_matrix", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "not a url",
      "example.com",
      "http://localhost",
      "http://localhost.",
      "http://LOCALHOST:80/",
      "http://foo.localhost",
      "http://printer.local",
      "http://svc.internal",
      "http://router.home.arpa",
      "http://intranet",
      "http://intranet./",
      "http://example.com./",
      "http://127.0.0.1",
      "http://127.1",
      "http://2130706433",
      "http://0x7f000001",
      "http://0177.0.0.1",
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0",
      "http://8.8.8.8",
      "http://[::1]",
      "http://[::ffff:127.0.0.1]",
      "http://[2001:4860:4860::8888]/",
      "file:///etc/passwd",
      "ftp://example.com/",
      "javascript:alert(1)",
      "data:text/html,hi",
      "gopher://example.com/",
      "https://user:pass@example.com",
      "https://user@example.com",
      "https://example.com:8443",
      "http://example.com:22/",
      "http://example.com:0/",
    ]) {
      expect(validatePublicUrl(bad), String(bad)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Manual redirects
// ---------------------------------------------------------------------------

describe("safeFetch", () => {
  const run = (url: string, google: FakeGoogle) =>
    runDirect(safeFetch(validatePublicUrl(url)!, HTML_ACCEPT), google);

  it("follows_up_to_three_redirects_resolving_relative_locations", async () => {
    const google = fake([
      ["https://a.example/start", redirect(301, "/two")],
      ["https://a.example/two", redirect(302, "https://b.example/three")],
      ["https://b.example/three", redirect(307, "four?x=1")],
      ["https://b.example/four?x=1", html("<title>ok</title>")],
    ]);
    const { exit } = await run("https://a.example/start", google);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.finalUrl.href).toBe("https://b.example/four?x=1");
    expect(google.calls.map((c) => c.url)).toEqual([
      "https://a.example/start",
      "https://a.example/two",
      "https://b.example/three",
      "https://b.example/four?x=1",
    ]);
    for (const call of google.calls) {
      expect(call.headers.get("accept")).toBe(HTML_ACCEPT);
      expect(call.headers.get("user-agent")).toBe(PREVIEW_USER_AGENT);
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("cookie")).toBeNull();
    }
  });

  it("refuses_a_fourth_redirect_and_a_redirect_without_location", async () => {
    const google = fake([
      ["https://a.example/1", redirect(308, "/2")],
      ["https://a.example/2", redirect(303, "/3")],
      ["https://a.example/3", redirect(301, "/4")],
      ["https://a.example/4", redirect(301, "/5")],
    ]);
    const tooMany = await run("https://a.example/1", google);
    expect(Exit.isFailure(tooMany.exit)).toBe(true);
    expect(JSON.stringify(tooMany.exit)).toContain("upstream_error");
    expect(google.calls.map((c) => c.url)).not.toContain("https://a.example/5");

    const missing = await run(
      "https://a.example/x",
      fake([["https://a.example/x", redirect(302)]]),
    );
    expect(JSON.stringify(missing.exit)).toContain("upstream_error");
  });

  it("revalidates_every_hop_and_never_asks_a_blocked_one", async () => {
    for (const target of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://localhost:8080/",
      "file:///etc/passwd",
      "https://user:pw@example.org/",
    ]) {
      const google = fake([["https://a.example/r", redirect(302, target)]]);
      const { exit } = await run("https://a.example/r", google);
      expect(JSON.stringify(exit), target).toContain("invalid_request");
      expect(google.calls, target).toHaveLength(1);
      expect(google.unexpected, target).toEqual([]);
    }
  });

  it("maps_upstream_404_to_not_found_and_other_failures_to_upstream_error", async () => {
    const cases = [
      [text(404, "nope"), "not_found"],
      [text(410, "gone"), "not_found"],
      [text(500, "boom"), "upstream_error"],
      [text(403, "no"), "upstream_error"],
      [unreachable("timeout"), "upstream_error"],
    ] as const;
    for (const [answer, code] of cases) {
      const { exit } = await run("https://a.example/", fake([["https://a.example/", answer]]));
      expect(JSON.stringify(exit), code).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

describe("decodeEntities and clampText", () => {
  it("decodes_named_and_numeric_entities_and_leaves_unknown_ones", () => {
    expect(
      decodeEntities(
        "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &apos;f&apos; g&nbsp;h &#123; &#x1F4A1; &#X41; &copy; &#0; &#xD800;",
      ),
    ).toBe("a & b <c> \"d\" 'e' 'f' g h { \u{1F4A1} A &copy; � �");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("collapses_whitespace_and_clamps_by_code_points", () => {
    expect(clampText("  a \n\t b  c  ", 100)).toBe("a b c");
    expect(clampText("\u{1F4A1}".repeat(5), 3)).toBe("\u{1F4A1}".repeat(3));
  });
});

describe("parseHeadMetadata", () => {
  const BASE = "https://example.com/blog/post";

  it("prefers_og_then_twitter_then_title_and_meta_description", () => {
    const og = parseHeadMetadata(
      `<title>Plain</title>
       <meta name="twitter:title" content="Tw title">
       <meta property="og:title" content="OG &amp; title">
       <meta name="description" content="Meta desc">
       <meta name="twitter:description" content="Tw desc">
       <meta property="og:description" content="OG desc">
       <meta property="og:site_name" content="Example">`,
      BASE,
    );
    expect(og).toEqual({
      title: "OG & title",
      description: "OG desc",
      siteName: "Example",
    });

    const twitter = parseHeadMetadata(
      `<title>Plain</title><meta name="twitter:title" content="Tw title">
       <meta name="twitter:description" content="Tw desc"><meta name="description" content="M">`,
      BASE,
    );
    expect(twitter).toEqual({ title: "Tw title", description: "Tw desc" });

    const plain = parseHeadMetadata(
      `<TITLE lang="en">  Plain \n  &lt;title&gt;  </TITLE><META NAME="Description" CONTENT="Meta  desc">`,
      BASE,
    );
    expect(plain).toEqual({ title: "Plain <title>", description: "Meta desc" });
  });

  it("handles_attribute_order_quotes_unquoted_values_and_self_closing_tags", () => {
    const meta = parseHeadMetadata(
      `<meta content='Single "quoted"' property='og:title' />
       <meta content=Unquoted property=og:site_name>
       <meta data-x=">" content="Has > inside" name="description"/>`,
      BASE,
    );
    expect(meta).toEqual({
      title: 'Single "quoted"',
      siteName: "Unquoted",
      description: "Has > inside",
    });
  });

  it("ignores_empty_contents_comments_and_scripts", () => {
    const meta = parseHeadMetadata(
      `<meta property="og:title" content="   ">
       <!-- <meta property="og:description" content="commented"> -->
       <script>var s = '<meta property="og:site_name" content="scripted">';</script>
       <title>Fallback</title>`,
      BASE,
    );
    expect(meta).toEqual({ title: "Fallback" });
  });

  it("clamps_title_description_and_site_name", () => {
    const meta = parseHeadMetadata(
      `<meta property="og:title" content="${"t".repeat(300)}">
       <meta property="og:description" content="${"d".repeat(500)}">
       <meta property="og:site_name" content="${"s".repeat(150)}">`,
      BASE,
    );
    expect(meta.title).toHaveLength(200);
    expect(meta.description).toHaveLength(400);
    expect(meta.siteName).toHaveLength(100);
  });

  it("resolves_relative_images_against_the_final_url_and_rewrites_them_to_the_proxy", () => {
    const meta = parseHeadMetadata(
      `<meta property="og:image" content="../img/cover.png?a=1&amp;b=2">`,
      BASE,
    );
    expect(meta.image).toBe(previewImageUrl("https://example.com/img/cover.png?a=1&b=2"));
    expect(meta.image).toBe(
      `/api/link-preview/image?url=${encodeURIComponent("https://example.com/img/cover.png?a=1&b=2")}`,
    );
    const twitter = parseHeadMetadata(
      `<meta name="twitter:image" content="//cdn.example.net/t.jpg">`,
      BASE,
    );
    expect(twitter.image).toBe(previewImageUrl("https://cdn.example.net/t.jpg"));
  });

  it("omits_blocked_or_svg_images_and_falls_back_to_the_next_candidate", () => {
    for (const blocked of [
      "http://127.0.0.1/x.png",
      "http://169.254.169.254/latest",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "https://example.com:8443/x.png",
      "/logo.svg",
      "https://example.com/logo.SVG?v=1",
    ]) {
      expect(
        parseHeadMetadata(`<meta property="og:image" content="${blocked}">`, BASE),
        blocked,
      ).toEqual({});
    }
    const fallback = parseHeadMetadata(
      `<meta property="og:image" content="/logo.svg"><meta name="twitter:image" content="/card.webp">`,
      BASE,
    );
    expect(fallback.image).toBe(previewImageUrl("https://example.com/card.webp"));
  });

  it("parses_getsill_style_html_skipping_the_svg_icon_and_proxying_preview_jpg", () => {
    const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Sill shows windows from your Mac on your iPhone and iPad. Free, with no account and no servers.">
<title>Sill: windows from your Mac on your iPhone and iPad</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sill">
<meta property="og:url" content="https://getsill.app/">
<meta property="og:title" content="Sill: your Mac, on your iPhone and iPad">
<meta property="og:description" content="Any window from your Mac, live on your iPhone or iPad, with touch, a trackpad and keys. Free and open source, no account, no servers.">
<meta property="og:image" content="https://getsill.app/preview.jpg">
<meta property="og:image:alt" content="Sill: the Mac’s Weather window on an iPhone and an iPad">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="style.css?v=2026-11-02">
<link rel="icon" href="icon.svg" type="image/svg+xml">
`;
    expect(parseHeadMetadata(head, "https://getsill.app/")).toEqual({
      title: "Sill: your Mac, on your iPhone and iPad",
      description:
        "Any window from your Mac, live on your iPhone or iPad, with touch, a trackpad and keys. Free and open source, no account, no servers.",
      siteName: "Sill",
      image: "/api/link-preview/image?url=https%3A%2F%2Fgetsill.app%2Fpreview.jpg",
    });
  });

  it("picks_a_raster_favicon_skipping_svg_by_type_or_extension", () => {
    const pick = (links: string) => parseHeadMetadata(links, BASE).favicon;
    expect(
      pick(`<link rel="icon" href="/a.svg">
            <link rel="icon" href="/b" type="image/svg+xml">
            <link rel="apple-touch-icon" href="/touch.png">
            <link rel="shortcut icon" href="/favicon.ico">`),
    ).toBe(previewImageUrl("https://example.com/favicon.ico"));
    expect(pick(`<link href="t.png" rel="apple-touch-icon">`)).toBe(
      previewImageUrl("https://example.com/blog/t.png"),
    );
    expect(
      pick(`<link rel="ICON" href="/i?size=32"><link rel="icon" type="image/png" href="/p">`),
    ).toBe(previewImageUrl("https://example.com/p"));
    expect(
      pick(`<link rel="icon" href="/only.svg"><link rel="stylesheet" href="/x.png">`),
    ).toBeUndefined();
    expect(pick(`<link rel="icon" href="http://10.0.0.1/favicon.ico">`)).toBeUndefined();
    expect(pick(`<link rel="icon" href="/icon?v=2" type="image/svg+xml">`)).toBeUndefined();
  });
});

describe("readHead", () => {
  it("stops_at_the_end_of_head_and_cancels_the_body", async () => {
    const { stream, state } = tracked(
      [bytes("<head><title>x</title></HEAD >"), bytes("<body>" + "b".repeat(1000))],
      true,
    );
    const head = await runDirect(readHead(stream));
    expect(Exit.isSuccess(head.exit) && head.exit.value).toBe("<head><title>x</title>");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10_000);
  });

  it("does_not_stop_at_header_and_finds_head_end_split_across_chunks", async () => {
    const { stream } = tracked([bytes("<head><header>a</header></he"), bytes("ad><body>")]);
    const head = await runDirect(readHead(stream));
    expect(Exit.isSuccess(head.exit) && head.exit.value).toBe("<head><header>a</header>");
  });

  it("reads_at_most_64_kib_then_cancels", async () => {
    const { stream, state } = tracked([bytes("x".repeat(10_000))], true);
    const head = await runDirect(readHead(stream));
    expect(Exit.isSuccess(head.exit) && head.exit.value.length).toBe(MAX_HEAD_BYTES);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(MAX_HEAD_BYTES + 10_000);
  });
});

// ---------------------------------------------------------------------------
// GET /api/link-preview
// ---------------------------------------------------------------------------

describe("GET /api/link-preview", () => {
  it("answers_the_parsed_preview_with_private_caching", async () => {
    const google = fake([
      ["https://getsill.app/", redirect(301, "https://getsill.app/index.html")],
      [
        "https://getsill.app/index.html",
        html(
          `<head><meta property="og:title" content="Sill &amp; co"><link rel="icon" href="icon.svg" type="image/svg+xml"><link rel="icon" href="favicon.png"><meta property="og:image" content="preview.jpg"></head><body>`,
        ),
      ],
    ]);
    const res = await preview("https://getsill.app/", google);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe(PREVIEW_CACHE);
    expect(await res.json()).toEqual({
      url: "https://getsill.app/",
      finalUrl: "https://getsill.app/index.html",
      hostname: "getsill.app",
      title: "Sill & co",
      image: "/api/link-preview/image?url=https%3A%2F%2Fgetsill.app%2Fpreview.jpg",
      favicon: "/api/link-preview/image?url=https%3A%2F%2Fgetsill.app%2Ffavicon.png",
    });
  });

  it("answers_url_and_host_only_for_a_non_html_page_without_reading_it", async () => {
    const { stream, state } = tracked([bytes("%PDF-1.7 ...")], true);
    const google = fake([
      [
        "https://example.com/doc.pdf",
        { status: 200, headers: { "content-type": "application/pdf" }, body: stream },
      ],
    ]);
    const res = await preview("https://example.com/doc.pdf", google);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PREVIEW_CACHE);
    expect(await res.json()).toEqual({
      url: "https://example.com/doc.pdf",
      finalUrl: "https://example.com/doc.pdf",
      hostname: "example.com",
    });
    expect(state.pulled).toBeLessThan(MAX_HEAD_BYTES);
  });

  it("accepts_xhtml_and_ignores_metadata_after_the_first_64_kib", async () => {
    const xhtml = await preview(
      "https://example.com/x",
      fake([["https://example.com/x", html("<title>XHTML</title>", "application/xhtml+xml")]]),
    );
    expect((await jsonBody(xhtml))["title"]).toBe("XHTML");

    const late = await preview(
      "https://example.com/late",
      fake([
        [
          "https://example.com/late",
          html(`<head>${" ".repeat(MAX_HEAD_BYTES)}<title>Too late</title></head>`),
        ],
      ]),
    );
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({
      url: "https://example.com/late",
      finalUrl: "https://example.com/late",
      hostname: "example.com",
    });
  });

  it("rejects_missing_and_blocked_urls_with_400_and_no_fetch", async () => {
    for (const url of [
      undefined,
      "",
      "http://localhost",
      "http://foo.localhost",
      "http://printer.local",
      "http://svc.internal",
      "http://intranet",
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]",
      "http://[::ffff:127.0.0.1]",
      "file:///etc/passwd",
      "https://user:pass@example.com",
      "https://example.com:8443",
    ]) {
      const google = fake([]);
      const res = await preview(url, google);
      expect(res.status, String(url)).toBe(400);
      expect((await jsonBody(res))["code"], String(url)).toBe("invalid_request");
      expect(res.headers.get("cache-control"), String(url)).toBe(NO_STORE_NO_TRANSFORM);
      expect(google.calls, String(url)).toHaveLength(0);
    }
  });

  it("rejects_a_redirect_to_a_private_address_and_too_many_redirects", async () => {
    const google = fake([["https://evil.example/", redirect(302, "http://127.0.0.1/")]]);
    const blocked = await preview("https://evil.example/", google);
    expect(blocked.status).toBe(400);
    expect((await jsonBody(blocked))["code"]).toBe("invalid_request");
    expect(google.calls).toHaveLength(1);

    const loop = await preview(
      "https://loop.example/0",
      fake(
        [0, 1, 2, 3].map((i) => [`https://loop.example/${i}`, redirect(302, `/${i + 1}`)] as const),
      ),
    );
    expect(loop.status).toBe(502);
    expect((await jsonBody(loop))["code"]).toBe("upstream_error");
  });

  it("rejects_public_origin_directly_on_redirect_and_in_metadata", async () => {
    const directGoogle = fake([]);
    const direct = await preview("https://notes.test/api/health", directGoogle);
    expect(direct.status).toBe(400);
    expect((await jsonBody(direct))["code"]).toBe("invalid_request");
    expect(directGoogle.calls).toHaveLength(0);

    const hopGoogle = fake([
      ["https://evil.example/self", redirect(302, "https://notes.test/api/session")],
    ]);
    const hop = await preview("https://evil.example/self", hopGoogle);
    expect(hop.status).toBe(400);
    expect((await jsonBody(hop))["code"]).toBe("invalid_request");
    expect(hopGoogle.calls).toHaveLength(1);

    const meta = parseHeadMetadata(
      `<meta property="og:image" content="https://notes.test/icons/icon-192.png">
       <link rel="icon" href="https://notes.test/icons/icon-192.png">`,
      "https://example.com/",
      "https://notes.test",
    );
    expect(meta).toEqual({});
  });

  it("maps_upstream_failures", async () => {
    const cases = [
      [text(404, ""), 404, "not_found"],
      [text(503, ""), 502, "upstream_error"],
      [unreachable(), 502, "upstream_error"],
    ] as const;
    for (const [answer, status, code] of cases) {
      const res = await preview("https://example.com/", fake([["https://example.com/", answer]]));
      expect(res.status, code).toBe(status);
      expect((await jsonBody(res))["code"]).toBe(code);
      expect(res.headers.get("cache-control")).toBe(NO_STORE_NO_TRANSFORM);
    }
  });

  it("needs_a_session", async () => {
    const google = fake([["https://example.com/", html("<title>x</title>")]]);
    const res = await send(get("/api/link-preview?url=https%3A%2F%2Fexample.com%2F"), { google });
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/link-preview/image
// ---------------------------------------------------------------------------

describe("GET /api/link-preview/image", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const imageAnswer = (
    contentType: string,
    body: Uint8Array | ReadableStream<Uint8Array> = PNG,
    headers: Record<string, string> = {},
  ) => ({ status: 200, headers: { "content-type": contentType, ...headers }, body });

  it("streams_an_allowlisted_raster_image_inline_with_day_long_private_caching", async () => {
    const google = fake([
      ["https://getsill.app/preview.jpg", redirect(302, "https://cdn.example.net/p.jpg")],
      ["https://cdn.example.net/p.jpg", imageAnswer("image/JPEG; foo=bar")],
    ]);
    const res = await image("https://getsill.app/preview.jpg", google);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toBe(IMAGE_CACHE);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(google.calls[1]!.headers.get("accept")).toBe(
      "image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=0.1",
    );
  });

  it("accepts_every_allowlisted_type_and_only_those", () => {
    for (const ok of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/x-icon",
      "image/vnd.microsoft.icon",
    ])
      expect(previewImageMimeOf(ok)).toBe(ok);
    for (const bad of [
      "image/svg+xml",
      "text/html",
      "image/avif",
      "",
      null,
      "application/octet-stream",
    ])
      expect(previewImageMimeOf(bad), String(bad)).toBeUndefined();
  });

  it("answers_before_the_upstream_body_is_read", async () => {
    const { stream, state } = tracked([PNG], true);
    const res = await image(
      "https://example.com/i.png",
      fake([["https://example.com/i.png", imageAnswer("image/png", stream)]]),
    );
    expect(res.status).toBe(200);
    expect(state.pulled).toBeLessThan(MAX_PREVIEW_IMAGE_BYTES);
    await res.body?.cancel();
  });

  it("rejects_svg_html_and_other_types_with_400", async () => {
    for (const type of ["image/svg+xml", "text/html; charset=utf-8", "application/octet-stream"]) {
      const res = await image(
        "https://example.com/i",
        fake([["https://example.com/i", imageAnswer(type)]]),
      );
      expect(res.status, type).toBe(400);
      expect((await jsonBody(res))["code"], type).toBe("invalid_request");
      expect(res.headers.get("cache-control"), type).toBe(NO_STORE_NO_TRANSFORM);
    }
    const missing = await image(
      "https://example.com/i",
      fake([["https://example.com/i", { status: 200, body: PNG }]]),
    );
    expect(missing.status).toBe(400);
  });

  it("allows_exactly_2_mib_and_refuses_more_with_413", async () => {
    const exact = new Uint8Array(MAX_PREVIEW_IMAGE_BYTES);
    const ok = await image(
      "https://example.com/i.png",
      fake([
        [
          "https://example.com/i.png",
          imageAnswer("image/png", streamOf(exact), { "content-length": String(exact.length) }),
        ],
      ]),
    );
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(MAX_PREVIEW_IMAGE_BYTES);

    const big = await image(
      "https://example.com/i.png",
      fake([
        [
          "https://example.com/i.png",
          imageAnswer("image/png", PNG, { "content-length": String(MAX_PREVIEW_IMAGE_BYTES + 1) }),
        ],
      ]),
    );
    expect(big.status).toBe(413);
    expect((await jsonBody(big))["code"]).toBe("too_large");
  });

  it("errors_the_stream_of_an_unannounced_body_past_2_mib", async () => {
    const res = await image(
      "https://example.com/i.png",
      fake([
        [
          "https://example.com/i.png",
          imageAnswer("image/png", streamOf(new Uint8Array(MAX_PREVIEW_IMAGE_BYTES + 1))),
        ],
      ]),
    );
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("rejects_blocked_urls_and_blocked_redirects_with_400", async () => {
    for (const url of ["http://127.0.0.1/a.png", "http://[::1]/a.png", "file:///etc/passwd"]) {
      const google = fake([]);
      const res = await image(url, google);
      expect(res.status, url).toBe(400);
      expect(google.calls, url).toHaveLength(0);
    }
    const google = fake([
      ["https://example.com/i.png", redirect(301, "http://169.254.169.254/latest/meta-data")],
    ]);
    const res = await image("https://example.com/i.png", google);
    expect(res.status).toBe(400);
    expect(google.calls).toHaveLength(1);

    const selfDirect = fake([]);
    expect((await image("https://notes.test/icons/icon-192.png", selfDirect)).status).toBe(400);
    expect(selfDirect.calls).toHaveLength(0);

    const selfHop = fake([
      ["https://example.com/self.png", redirect(302, "https://notes.test/api/files/f1/blob")],
    ]);
    expect((await image("https://example.com/self.png", selfHop)).status).toBe(400);
    expect(selfHop.calls).toHaveLength(1);
  });

  it("needs_a_session", async () => {
    const google = fake([["https://example.com/i.png", imageAnswer("image/png")]]);
    const res = await image("https://example.com/i.png", google, null);
    expect(res.status).toBe(401);
    expect(google.calls).toHaveLength(0);
  });
});
