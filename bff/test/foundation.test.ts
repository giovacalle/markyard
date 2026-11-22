// Foundation checks with no Rust counterpart: exact path matching like the Rust `match`, and the
// Drive client plumbing phase-2 routes build on (error mapping, raw stream pass-through).

import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import { download, getFile, upload } from "../src/infrastructure/drive-client.ts";
import {
  FakeGoogle,
  get,
  json,
  on,
  request,
  runDirect,
  send,
  streamOf,
  text,
} from "./support/harness.ts";

const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error
    : undefined;

describe("routing", () => {
  it("matches paths exactly like the Rust router", async () => {
    for (const path of ["/api/health/", "/API/health", "//api/health", "/api/health/x"]) {
      const res = await send(get(path));
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe('{"code":"not_found","message":"Not found"}');
    }
  });

  it("answers 404 not_found for a known path with another method", async () => {
    const res = await send(request("POST", "/api/health"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found", message: "Not found" });
  });
});

describe("drive client", () => {
  it("maps 429 and rate-limit 403 to rate_limited with Retry-After", async () => {
    for (const [answer, retryAfter] of [
      [text(429, "", { "retry-after": " 17 " }), "17"],
      [json(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }), "5"],
    ] as const) {
      const google = new FakeGoogle([on("GET", "https://fake.test/drive/v3/files/abc", answer)]);
      const { exit, sink } = await runDirect(getFile("tok", "abc"), google);
      expect(failureOf(exit)).toMatchObject({ code: "rate_limited" });
      expect(sink.headers["retry-after"]).toBe(retryAfter);
    }
  });

  it("maps a Drive 401 to session_ended and clears the cookie", async () => {
    const google = new FakeGoogle([
      on("GET", "https://fake.test/drive/v3/files/abc", text(401, "")),
    ]);
    const { exit, sink } = await runDirect(getFile("tok", "abc"), google);
    expect(failureOf(exit)).toMatchObject({ code: "unauthenticated", reason: "session_ended" });
    expect(sink.cookies).toEqual([
      "__Host-s=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    ]);
  });

  it("passes a download body through unread", async () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
    const google = new FakeGoogle([
      on("GET", "https://fake.test/drive/v3/files/abc?alt=media", {
        status: 200,
        body: streamOf(bytes),
      }),
    ]);
    const { exit } = await runDirect(download("tok", "abc"), google);
    if (!Exit.isSuccess(exit)) throw new Error("download failed");
    expect(exit.value.bodyUsed).toBe(false);
    expect(new Uint8Array(await exit.value.arrayBuffer())).toEqual(bytes);
  });

  it("uploads a stream body with If-Match and returns the new etag", async () => {
    const bytes = new TextEncoder().encode("# note\n".repeat(20_000));
    const google = new FakeGoogle([
      on("PUT", "https://fake.test/upload/drive/v2/files/abc", json(200, { etag: '"v2"' })),
    ]);
    const { exit } = await runDirect(
      upload("tok", "abc", '"v1"', { stream: streamOf(bytes), length: bytes.length }),
      google,
    );
    expect(exit).toEqual(Exit.succeed('"v2"'));
    const call = google.calls[0]!;
    expect(call.url).toBe(
      "https://fake.test/upload/drive/v2/files/abc?uploadType=media&fields=etag",
    );
    expect(call.headers.get("if-match")).toBe('"v1"');
    expect(call.headers.get("content-type")).toBe("text/markdown");
    expect(call.body).toEqual(bytes);
  });

  it("maps an upload 412 to conflict", async () => {
    const google = new FakeGoogle([
      on("PUT", "https://fake.test/upload/drive/v2/files/abc", text(412, "")),
    ]);
    const { exit } = await runDirect(
      upload("tok", "abc", '"v1"', new TextEncoder().encode("x")),
      google,
    );
    expect(failureOf(exit)).toMatchObject({ code: "conflict" });
  });
});
