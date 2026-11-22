---
status: superseded by 0003
---

# The BFF runs on Cloudflare Workers with `workers-rs`, deployed with Alchemy

The BFF needs a host that serves the web app and `/api/` on one origin and keeps no session storage. Spike B (#3, 2026-11-16) built a throwaway Rust Worker, deployed it to the user's Cloudflare account (Workers Paid plan), measured it and deleted it. Nothing blocked, so the host is Cloudflare Workers with the `worker` crate, and every deploy goes through Alchemy. The VM fallback was not needed.

## Worker layout

Two crates in one Cargo workspace:

- **Core**: target-independent, compiles natively and to `wasm32-unknown-unknown`. It holds routing, the session cookie, and every decision about what to ask Google. It reaches Google only through one trait (`Upstream`: request in, response out) and takes the nonce and the clock as arguments, so it needs no randomness source and no Workers API.
- **Worker**: a thin adapter, the only crate that depends on `worker`. It turns the Workers request into the core's request type, implements `Upstream` with the Workers fetch API, and supplies randomness.

`worker` is `0.9.0`: a `0.x` crate whose minor releases change the toolchain and some APIs. The thin adapter is what keeps those changes out of the core. `worker`, `worker-build` and `wasm-bindgen` are pinned together through `Cargo.lock` and an exact `worker-build` version; `worker` and `worker-build` refuse to run on mismatched major versions.

File content passes through the Worker as a stream in both directions. Streaming costs about 1 ms of CPU at any size up to 10 MB; buffering a 10 MB download in Wasm cost 100-360 ms. The spike's core used buffered bodies only, so the core's request and response types must gain a way to say "pass this body through" before the read and save routes are built.

## Static assets

The built web app is uploaded as Workers static assets on the same Worker, with not-found handling set to single-page-application and the Worker run first for `/api/*` only. The Rust code never touches the assets binding.

## Limits that shaped this

On the Workers Paid plan, from Cloudflare's limits page (updated 2026-11-13) and the spike's measurements:

| Limit | Value | Measured |
| --- | --- | --- |
| CPU per request | 30 s default, waiting on Google excluded | 1-6 ms for a session route; 9-15 ms on a cold start |
| Subrequests per request | 10,000 | |
| Request body | 100 MB (set by the zone's plan) | 10 MB uploaded |
| Response body | not limited | 10 MB downloaded |
| Memory per isolate | 128 MB, shared by concurrent requests | |
| Worker size | 64 MiB uncompressed | 427 KB Wasm + 25 KB JS |

The file size cap is **10 MB**, the largest size measured. The BFF refuses larger files with `too_large`, from Drive's `size` on read and from `Content-Length` on save.

The Free plan allows 10 ms of CPU per request. Cold starts measured 9-15 ms, so the design assumes the Paid plan.

## Session cookie

- `__Host-s`, `HttpOnly`, `Secure`, `Path=/`, **`SameSite=Strict`**. Value: base64url of a key version byte, a 12-byte nonce, and the AES-256-GCM ciphertext of a small JSON object (refresh token, access token, its expiry, email). The key version is also the associated data.
- AES-256-GCM comes from the `aes-gcm` crate with default features off (the defaults pull a `getrandom` that does not build for Wasm). The nonce comes from `getrandom` 0.3 with the `wasm_js` backend, which is `crypto.getRandomValues`. Sealing plus unsealing costs about 0.05 ms.
- Size: 615 bytes with typical tokens, 3,557 bytes with tokens at Google's documented maximums (refresh 512 bytes, access 2,048 bytes). Chromium stores a cookie of that size and silently drops one over 4,096 bytes. A session that would not fit is written without the access token.
- Rotation: add the new key under the next version, seal with the newest, keep the old key for unsealing until every cookie sealed with it has expired.
- The sign-in state cookie is `__Host-state` with `SameSite=Lax`, because it must come back on the redirect from Google. `Strict` works for the session cookie because the app shell is static: no navigation needs the cookie, only same-origin `fetch` calls, and those carry it. On the navigation that returns from Google a `Strict` cookie is not sent; the web app must learn the signed-in state from an API call, never from the page load.

## Tests

BFF tests are native `cargo test` runs against the core: a test builds a request, hands the core a fake `Upstream`, and asserts on the response and on what the fake was asked. No Workers runtime is involved. The adapter is not covered this way; it is exercised by running the Worker locally.

## Development loop

`alchemy dev` serves the prebuilt Worker in `workerd` on a local port and reloads it within 100 ms when the build output changes. The web dev server proxies `/api` to it, so the browser sees one origin. The Worker is rebuilt with `worker-build` (3 s incremental for a release build); `alchemy dev` does not run that build itself.

## Deploy tool

Alchemy, pinned exactly: `alchemy` and `@alchemy.run/cloudflare` at `2.0.0-beta.87`, `effect` at `4.1.4`. No `wrangler` configuration is kept. Alchemy has no Rust support, so the Worker is built first with `worker-build --release` and uploaded as-is (`bundle: false`); a deploy that skips the build uploads the previous build.

- **State** is stored in Cloudflare (`Cloudflare.state()`): Alchemy provisions an `alchemy-state-store` Worker and Secrets Store in the Cloudflare account, holding state encrypted so deploys are not tied to one machine. (Originally local under `.alchemy/state/`, switched to Cloudflare before deploying.)
- **Secrets** are read from the environment or `.env` at deploy time and bound as Worker secrets. A literal string in the stack file is bound as a plain variable.
- **Credentials** are the Alchemy profile in `~/.alchemy`, outside the repo. Its OAuth grant had expired after a month and needed the user to re-authorize in a browser.
- The production Worker is reachable only on its custom domain: `workersDev: false` in the stack file (not exercised by the spike).

## Considered options

- **The personal-apps VM**: the fallback if Workers had a blocker. Not needed.
- **`wrangler`**: the documented path for `workers-rs`. Rejected because Alchemy passed its gate and the user prefers one declarative file for Worker, assets, domain and secrets. It remains the way back if the Alchemy beta breaks: the build output is the same.
- **WebCrypto for AES-GCM** instead of a Rust crate: rejected because it would put the cookie code behind the Workers API and out of reach of native tests.
