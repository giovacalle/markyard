# Markyard

**Your Markdown notes, stored in your Google Drive — fast, offline-first, and self-hosted on a Cloudflare Worker or in a Docker container.**

[Website](https://markyard.giova.dev) · [Docs](https://markyard.giova.dev/docs) · [Features](#features) · [Quick Start](#quick-start-local-development) · [Self-Host with Docker](#self-host-with-docker) · [Self-Host on Cloudflare](#self-hosting-on-cloudflare-workers) · [License](#license)

Your notes stay plain `.md` files in your own Google Drive folder—editable with Google Drive for desktop, Obsidian, or any editor, with zero vendor lock-in. **Markyard** adds a clean web & mobile PWA on top with conflict-safe saves, offline editing, PKM tools (`[[wikilinks]]`, backlinks, tasks, templates), inline image attachments, Drive version history, rich link previews, and optional multi-device state sync.

## Features

- **Google Drive as the single source of truth** — browse, create, rename, move (drag & drop or dialog), and delete Markdown files and folders directly in your configured Drive folder, including Drive folder shortcuts.
- **Conflict-safe saves (Compare-and-Swap)** — saves use Drive v2 `If-Match` ETags ([ADR 0002](docs/adr/0002-save-is-a-drive-v2-if-match-compare-and-swap.md)) so edits from another device, Drive for desktop or Drive's own editor are caught instead of silently overwritten (a writer that preserves the modification time, such as rclone, can still slip through; see the ADR); includes an interactive side-by-side merge view when conflicts occur.
- **Offline-first & Live Drive Sync** — IndexedDB local cache + offline edit queue, optional full-vault offline pinning, and incremental `changes.list` background sync.
- **Markdown Editor & Rich Preview** — warm CodeMirror 6 editor with instant Preview switching, GFM tables & checkboxes, syntax highlighting, KaTeX math, Mermaid diagrams, callouts, frontmatter properties, focus/typewriter/read-only modes, and a mirror right Document Info sidebar (Outline, Backlinks, Attachments, Stats).
- **PKM & Productivity** — `[[Wikilinks]]` with autocomplete & backlinks, global **Tasks** dashboard (with tag/folder/status filters and inline checkbox toggling), slash commands (`/`) & `Templates/`, live declarative `` ```query `` blocks ([Templates & Queries guide](docs/templates-and-queries.md)), and a `Cmd+K` command palette with full-text search.
- **Inline Image Attachments & Drive Version History** — paste, drop, or pick images uploaded to `_attachments/` and served same-origin (Drive thumbnails for previews, kept on the device for offline viewing), manage/delete unused attachments from the **Attachments** view or per-note sidebar, and browse/diff/restore previous Google Drive revisions.
- **SSRF-Safe URL Link Previews** — hover preview cards on external links and inline Notion/Bear-style bookmark cards for standalone URLs in Preview mode, proxied through the BFF to preserve strict CSP.
- **Multi-Account & Vault Picker** — every signed-in Google account picks or creates its own isolated Drive vault folder on first sign-in (set `ALLOWED_EMAILS=*` to allow any Google account), switchable anytime from **Settings**.
- **Configurable Settings, Custom CSS & Optional Multi-Device Cloud Sync** — customize Attachments, Daily notes, Templates, and Styles folders, default open mode, theme, link previews, [vault-based Custom CSS](docs/custom-css.md), and [Templates & Declarative Queries](docs/templates-and-queries.md) in **Settings** (`Cmd+K → Open Settings`). Sync vault selection, settings, last opened note, and expanded folders across devices in SQLite (Cloudflare D1 with `ENABLE_STATE_DB=1`, or a file on the Docker volume with `STATE_DB_FILE`); omit it to stay 100% stateless.
- **Security by Design** — full Backend-for-Frontend (BFF): Google OAuth tokens never leave the server, sessions live in AES-256-GCM sealed `HttpOnly` `__Host-` cookies, and the web app runs under a strict `default-src 'self'` Content Security Policy.

## Architecture

```
Browser (PWA: React 19 + Vite+ + Tailwind v4 + CodeMirror 6 + Dexie)
   │  same-origin cookies (__Host-s), strict CSP (default-src 'self')
   ▼
BFF (TypeScript + Effect v4), on either host:
   ├── Cloudflare Worker, deployed via Alchemy
   └── Node 24 container (host-node/), run with Docker Compose
        ├── Static assets (web/dist)
        ├── /api/* → Google Drive v2/v3 & OAuth 2.0
        └── Optional SQLite (Cloudflare D1, or a file on the Docker volume) → /api/state
```

Architecture Decision Records live in [`docs/adr/`](docs/adr/):

- [ADR 0002](docs/adr/0002-save-is-a-drive-v2-if-match-compare-and-swap.md) — Conflict-safe saves via Drive v2 `If-Match` compare-and-swap
- [ADR 0003](docs/adr/0003-bff-on-cloudflare-workers-with-effect-v4.md) — TypeScript + Effect v4 BFF on Cloudflare Workers
- [ADR 0005](docs/adr/0005-second-host-node-24-in-docker.md) — A second host: Node 24 in Docker

## Prerequisites

- A **Google Cloud OAuth 2.0 Web Application** client with the **Google Drive API** enabled ([setup](#google-oauth-client))
- For Docker: **Docker** with Compose v2 (nothing else)
- For local development or Cloudflare: **Node.js 24+** and **pnpm**, plus a **Cloudflare account** to deploy the Worker and optional D1 database via [Alchemy](https://alchemy.run)

## Quick Start (Local Development)

1. **Install dependencies**

   ```sh
   pnpm install
   ```

2. **Configure environment**

   Copy `.env.example` to `.env` and fill in your values:

   ```sh
   cp .env.example .env
   ```

   Generate a cookie encryption key:

   ```sh
   echo "1:$(openssl rand -hex 32)"
   ```

   In Google Cloud Console, add `http://localhost:5173/api/auth/callback` to your OAuth client's **Authorized redirect URIs**.

3. **Run dev servers** (Worker on `:8787`, Vite+ on `:5173` proxying `/api`)

   ```sh
   pnpm dev
   ```

## Self-Host with Docker

The container runs the same BFF on Node 24 ([ADR 0005](docs/adr/0005-second-host-node-24-in-docker.md)). It is built from source; no image is published.

### Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project and enable the **Google Drive API** (APIs & Services → Library).
2. Configure the **OAuth consent screen**: user type **External**, publishing status **Testing**, and add every Google account that will sign in as a **test user**. Testing mode avoids Google's verification for personal use (see [Privacy & Google API Notice](#privacy--google-api-notice)). Google expires refresh tokens of Testing-mode apps after 7 days, so expect to sign in again about once a week.
3. Under **Credentials**, create an **OAuth client ID** of type **Web application**. Add `${PUBLIC_ORIGIN}/api/auth/callback` to **Authorized redirect URIs**, for example `http://localhost:8080/api/auth/callback` or `https://notes.example.com/api/auth/callback`. Copy the client ID and secret.

### Configure and start

```sh
git clone https://github.com/giovacalle/markyard.git && cd markyard
cp .env.docker.example .env.docker
echo "1:$(openssl rand -hex 32)"   # paste as COOKIE_KEYS
$EDITOR .env.docker
docker compose up -d --build
```

| Variable (`.env.docker`) | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | yes | The origin the browser uses, no trailing slash: `http://localhost:8080`, or your HTTPS origin behind a proxy |
| `ALLOWED_EMAILS` | yes | Comma-separated Google accounts allowed to sign in; `*` allows any |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | The OAuth client above |
| `COOKIE_KEYS` | yes | `<version>:<64 hex>` keys that seal the session cookie; keep them across upgrades or everyone is signed out |
| `STATE_DB_FILE` | no | Set to `/data/markyard.db` to turn on state sync |
| `PORT`, `HOST` | no | Listen address inside the container (default `8080`, `0.0.0.0`); leave them unless you change the image |

`MARKYARD_PORT` (default `8080`) sets the published host port. Compose reads it from your shell or from a `.env` file next to `docker-compose.yml`, not from `.env.docker`. Set it to `127.0.0.1:8080` to publish on the loopback interface only.

`docker compose logs -f` shows one access-log line per request; `docker compose ps` shows the health check.

### Supported setups

Exactly two setups can sign in:

1. **`http://localhost`**: Markyard on the machine you browse from. Set `PUBLIC_ORIGIN=http://localhost:8080` and open that URL.
2. **HTTPS through a reverse proxy**: a VPS or homelab. The proxy terminates TLS and forwards to the container; `PUBLIC_ORIGIN` is the public HTTPS origin. Publish the container on loopback only (`MARKYARD_PORT=127.0.0.1:8080`) so plain HTTP never reaches the network.

   **Caddy** (automatic Let's Encrypt; point a DNS record at the server and open ports 80 and 443), in `/etc/caddy/Caddyfile`:

   ```
   notes.example.com {
   	reverse_proxy 127.0.0.1:8080
   }
   ```

   **Tailscale Serve** (reachable only from your tailnet; enable MagicDNS and HTTPS certificates in the Tailscale admin console):

   ```sh
   tailscale serve --bg 8080
   ```

   It prints `https://<machine>.<tailnet>.ts.net`; use that as `PUBLIC_ORIGIN` and in the OAuth redirect URI.

   After changing `PUBLIC_ORIGIN`, run `docker compose up -d` again.

**A plain-HTTP LAN address such as `http://192.168.1.10:8080` cannot work.** The session cookie is `__Host-s` with the `Secure` attribute, which browsers store only over HTTPS or on `localhost`, and Google refuses OAuth redirect URIs that are plain HTTP or a bare IP unless the host is `localhost`. Use one of the two setups above.

### Optional state sync

Set `STATE_DB_FILE=/data/markyard.db` in `.env.docker` and run `docker compose up -d`. The file lives in the `markyard-data` volume, so it survives restarts and upgrades; **Settings** then shows sync as *Active*. It stores UI preferences only, never note contents. `docker compose down -v` deletes the volume.

### Upgrade

```sh
git pull
docker compose up -d --build
```

Sessions survive as long as `COOKIE_KEYS` stays the same, and the state volume is kept.

## Self-Hosting on Cloudflare Workers

1. Configure your Cloudflare credentials for Alchemy:

   ```sh
   pnpm exec alchemy login
   ```

2. Update `.env` for production:
   - Set `PUBLIC_ORIGIN=https://notes.example.com` (or your `*.workers.dev` URL)
   - Optionally set `CUSTOM_DOMAIN=notes.example.com` to bind a Cloudflare zone custom domain
   - Optionally set `ENABLE_STATE_DB=1` to provision and migrate the Cloudflare D1 SQLite database for multi-device UI state sync
   - Add `${PUBLIC_ORIGIN}/api/auth/callback` to your Google OAuth client's **Authorized redirect URIs**

3. Build and deploy:

   ```sh
   pnpm build
   pnpm exec alchemy deploy --stage prod
   ```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run local Alchemy Worker (`:8787`) and Vite+ dev server (`:5173`) |
| `pnpm preview:mock` | Serve built `web/dist` (`:4173`) with production CSP and a fixture `/api`; `GET /__mock/csp-reports` lists CSP violations |
| `pnpm smoke` | Build, serve `web/dist` with the fixture `/api` on a free port, and run the request and CSP-report smoke matrix |
| `pnpm smoke --target <url>` | Run the host smoke matrix against a running host, such as the Docker container (`http://localhost:8080`) |
| `pnpm test:scripts` | Run local script and Node host tests (`scripts/`, `host-node/`) |
| `pnpm build` | Build production web bundle (`web/dist`) and verify BFF types/lint |
| `pnpm check:web` | Format, lint, and typecheck `web/` |
| `pnpm test:web` | Run Web test suite |
| `pnpm check:bff` | Format, lint, and typecheck `bff/` |
| `pnpm test:bff` | Run BFF test suite |

## Privacy & Google API Notice

Markyard is designed to be **self-hosted**: your Cloudflare Worker or Docker container talks directly to Google Drive using your own Google Cloud OAuth credentials, and no data is sent to the project author or any third-party analytics service. OAuth tokens remain server-side in AES-256-GCM sealed `HttpOnly` cookies, and optional state sync (Cloudflare D1 or SQLite) stores only UI preferences (never note contents).

Markyard requests the `https://www.googleapis.com/auth/drive` scope so it can read and edit existing Markdown files in your chosen vault folder. For personal use, keeping your Google Cloud OAuth consent screen in **Testing** mode (with test users matching `ALLOWED_EMAILS`) avoids public OAuth verification. If you operate a public multi-user instance, you are responsible for completing Google OAuth verification, publishing a Privacy Policy, and complying with the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) (including the Limited Use requirements).

## Disclaimer & Trademarks

Markyard is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Google LLC. Google and Google Drive are trademarks of Google LLC. Cloudflare, Docker, Tailscale, Obsidian, and any other product names mentioned are trademarks of their respective owners.

Markyard is provided "as is" under the [MIT License](LICENSE), without warranty of any kind.

## License

[MIT](LICENSE)
