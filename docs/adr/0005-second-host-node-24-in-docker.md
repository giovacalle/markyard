---
status: accepted
---

# A second host: Node 24 in Docker, next to Cloudflare Workers

Markyard ran only on Cloudflare Workers ([ADR 0001](0001-bff-on-cloudflare-workers-with-workers-rs.md), [ADR 0003](0003-bff-on-cloudflare-workers-with-effect-v4.md)), which needs a Cloudflare account and, per ADR 0001, the Workers Paid plan. Users asked to run it with Docker on their own VPS, so Markyard now has two supported hosts: the Cloudflare Worker, and a Node 24 container that runs the same BFF (`bff/src`) behind `host-node/server.mjs`. The Cloudflare path does not change. RFC: #39.

## The Node host

- `host-node/` lives outside `bff/src`. It imports `makeFetch` from the BFF, sends `/api/*` to it (as `runWorkerFirst: ["/api/*"]` does on Cloudflare) and everything else to the shared static host.
- HTTP bridge: [srvx](https://srvx.h3.dev/), zero dependencies. It streams request bodies, passes `Content-Length` through, and aborts `Request.signal` when the client disconnects.
- One frozen `env` object for the life of the process, because `makeFetch` caches config and imported keys per `env` in a `WeakMap`. The variables keep the Cloudflare binding names (`PUBLIC_ORIGIN`, `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOKIE_KEYS`); the host adds `PORT`, `HOST`, `DIST_DIR` and `STATE_DB_FILE`.
- The host writes one access-log line per request, since `bff/src` does not log and there is no Cloudflare request log.

## Node, not Bun

Both were tested on this BFF (Node v24.22, Bun 1.3.11). Bun runs it unchanged, but **Bun silently ignores the undici `dispatcher`**: with a `connect.lookup` that always throws, Node's `fetch` is blocked and Bun's returns 200. The SSRF guard below would fail open on Bun while every Node-run test passed. Bun also has no `node:sqlite`, and CI, tests and pnpm all run on Node 24, so a Bun container would run production on a runtime no test exercises. The image size difference is negligible (57.3 MB against 62.5 MB compressed). Revisit if Bun's `fetch` gains a connect-time lookup hook.

## Parity contract

The Docker path is used less than the Cloudflare one, so drift would go unnoticed. Two things hold the hosts together:

1. **One static host module.** `host-node/static-host.mjs` reproduces what Cloudflare's static assets do for Markyard: the security headers of `web/public/_headers` (imported from the BFF, which a test pins to `_headers`), SPA fallback for navigations only, MIME types, ETag / `304`, `Cache-Control`, and never serving `_headers` itself. The Node host and `scripts/mock-api.mjs` both use it.
2. **The smoke matrix runs against the container in CI.** The `docker` job builds the image, starts it and runs `pnpm smoke --target http://localhost:8080`. A change that touches headers, static files or the BFF must keep that job green. The same command can be pointed at a Cloudflare deploy; CI does not do that.

## Egress guard

`/api/link-preview` and the image proxy reject IP literals, private suffixes, odd ports and credentials, and re-check every redirect hop, but they never see the address a name resolves to: `127.0.0.1.nip.io` and `169.254.169.254.nip.io` passed. On a VPS that reaches cloud metadata, the Docker bridge and the LAN. The Node host therefore injects a `fetch` whose undici connector checks the resolved address at connect time (`connect.lookup`) and refuses loopback, RFC 1918, link-local, CGNAT, unspecified, multicast, reserved, ULA and site-local addresses, including their IPv4-mapped and NAT64 forms. The checked IP is the dialled IP, so DNS rebinding between a check and a fetch is impossible; resolving first and fetching after would leave that gap. A refused connect is the BFF's existing `502`. This guard is Node-only; whether the Cloudflare path needs a resolved-IP check is still open.

## Upload `Content-Length`

Drive documents a chunked-encoding exemption for `uploadType=media` but not for multipart, and `FixedLengthStream` exists only in workerd. Without it, `bff/src` now sets `Content-Length` from the known inbound length on the `duplex: "half"` stream body, which Node 24 `fetch` honours and enforces. Bodies stay streamed and the 10 MB cap is unchanged. This is a Web-standard change inside `bff/src`, which ADR 0003 allows.

## State

`STATE_DB_FILE` points the host at a SQLite file through `node:sqlite`. `host-node/sqlite-d1.mjs` adapts it to the BFF's duck-typed D1 interface, so the D1 state store runs unchanged. The store's `CREATE_TABLE` is the one schema; the D1 migration Alchemy applies is pinned to it by a test. Unset, the host is stateless, like a Worker without D1.

## Packaging

A plain multi-stage `Dockerfile` (`node:24-alpine`, non-root, `/data` volume) and `docker-compose.yml`, built from source. Alchemy stays Cloudflare-only: a self-hoster wants `docker compose up`, not Node, pnpm and a beta CLI with telemetry on by default.

## Network topology

The session cookie is `__Host-s` with `Secure`, and Google OAuth accepts only `http://localhost` or HTTPS redirect URIs. So exactly two setups are supported: `http://localhost`, and HTTPS through a reverse proxy with `PUBLIC_ORIGIN` set to the public origin. A plain-HTTP LAN IP cannot sign in.

## Considered options

- **Bun**: rejected, see above.
- **workerd in Docker**: needs glibc (no Alpine), has no file-backed D1, and adds a second config language for no gain over Node.
- **`alchemy.docker.ts`**: rejected for v1, see Packaging. Revisit for a hosted target.
- **A published image (GHCR, multi-arch)**: out of v1; it brings signing and CVE-rebuild duties.
