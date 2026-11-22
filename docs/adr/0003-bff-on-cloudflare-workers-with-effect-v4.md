---
status: accepted
supersedes: 0001
---

# The BFF runs on Cloudflare Workers in TypeScript with Effect v4

Supersedes [ADR 0001](0001-bff-on-cloudflare-workers-with-workers-rs.md). The host stays the same: one Cloudflare Worker serves the web app as static assets and runs first for `/api/*`, deployed with Alchemy. What changes is the language of the BFF: the Rust crates `core/` and `worker/` are replaced by the TypeScript workspace package `bff/`, written with `effect@4.1.4`, following a benchmarked spike on local and production Cloudflare Workers.

## Why

- One language and one toolchain for the whole repo: no `wasm32` target, no `worker-build`, no Cargo. The dev loop drops from a 3 s `worker-build --release` to a ≈600 ms rolldown rebuild.
- The bundle is smaller than the Rust Worker: about 250-360 KB raw (≈75-105 KB gzip) against 427 KB Wasm + 25 KB JS.
- The `HttpApi` contract is TypeScript, so `web/` can share its schemas later.
- The sealed session cookie is byte-identical, so cutover logs out nobody.

## Constraints

These three come from the spike and are not optional.

1. **File bodies are raw Web streams.** `GET /api/files/{id}/content` answers with `HttpServerResponse.raw(driveResponse.body)`. `PUT /api/files/{id}/content` pipes `request.source.body` through a `FixedLengthStream(Content-Length)` into `HttpBody.raw`. File bytes never go through an Effect `Stream` or `bodyStream`: that path drops `Content-Length` (`FetchHttpClient` strips it from uploads) and puts every chunk on the JS heap (workerd RSS 75 → 165-197 MB over 15 round trips, against a flat 64-75 MB on raw streams). This also ends the Rust Worker's buffered uploads.
2. **`HttpApi` for JSON, `HttpRouter` for the rest, one handler.** JSON endpoints are declared in an `effect/http-api` `HttpApi` contract, with domain failures mapped to statuses in the contract ([typed HTTP errors](https://github.com/giovacalle/patterns/tree/main/capabilities/errors/typed-http-errors)), and `HttpServer.layerServices` provides the inert platform services. The two file-content routes and the HTML auth routes (`login`, `callback`) are plain `HttpRouter` routes merged into the same layer. `HttpRouter.toWebHandler(...)` runs once, at module scope.
3. **`env` is a per-request `Context` service.** The Worker entry calls `handler(request, Context.make(WorkerEnv, env))`. Heavy layers (`HttpClient`, ports) are built once at module scope; values derived from `env` (parsed config, imported AES `CryptoKey`s) are cached in a `WeakMap` keyed on the `env` object. Runtime code never imports `@alchemy.run/cloudflare` or `alchemy`: those stay in `alchemy.run.ts`, which avoids `alchemy#3478` (a 5.4 MB bundle). The Worker runs with no compatibility flags (no `nodejs_compat`), and the bundle contains no `node:` import.

## The session cookie

`__Host-s` keeps the wire format of `core/src/session.rs`: `base64url_nopad(kid(1) | nonce(12) | AES-256-GCM(json))`, tag included, `aad = [kid]`, sealed with the highest key version, opened with any configured one. The JSON keeps serde's field order `rt`, `at`, `exp`, `email`, omits absent fields, and drops `at` and `exp` when `__Host-s=<value>` would exceed 4096 bytes. `crypto.subtle` does the AES. A golden-vector test (`bff/test/fixtures/session-golden.json`, produced by the Rust `session::seal` before `core/` was deleted) pins the format.

## Everything else carries over

The HTTP contract of every route, the same-origin check on non-`GET`/`HEAD` requests, the security headers (kept equal to `web/public/_headers` by a test), the 10 MB cap and the Drive v2 `If-Match` save of [ADR 0002](0002-save-is-a-drive-v2-if-match-compare-and-swap.md) are unchanged. The limits table of ADR 0001 still holds. One deliberate improvement: `/api/search` resolves the parent-folder paths of its results with bounded concurrency instead of one at a time.

## Not proved by the spike

CPU time per request on production Workers, behaviour under the 128 MB isolate limit, and whether the `env` object is stable per isolate (if not, the `WeakMap` cache costs one key import per request, ≈0.05 ms). These are checked at cutover.

## As built

- Outbound calls to Google go through one `Upstream` port backed by the Web `fetch` (the Workers global, a fake in tests), not Effect's `HttpClient`. The upload body is `request.body` piped through `FixedLengthStream(Content-Length)` straight into `fetch`, so the bytes never meet an Effect `Stream` and `FetchHttpClient` never gets the chance to strip `Content-Length`. A save without `Content-Length` is buffered up to 10 MB, then sent or refused with `413 too_large`, as the Rust Worker answered.
- Measured on the full 16-route Worker in local workerd (`alchemy dev --stage local`): 407 KB raw, 118 KB gzip, zero `node:` imports.
