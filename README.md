# Markyard

A fast, self-hosted, offline-capable Markdown notes PWA backed directly by a Google Drive folder, running on a single Cloudflare Worker.

Your notes stay plain `.md` files in Google Drive—editable with Drive for Desktop, Obsidian, or any editor—while **Markyard** gives you a clean web & mobile app with conflict-safe saves, PKM features, inline image attachments, Drive version history, rich link previews, and optional Cloudflare D1 multi-device state sync.

## Features

- **Google Drive as the single source of truth** — browse, create, rename, move (drag & drop or dialog), and delete Markdown files and folders directly in your configured Drive folder, including Drive folder shortcuts.
- **Conflict-safe saves (Compare-and-Swap)** — saves use Drive v2 `If-Match` ETags ([ADR 0002](docs/adr/0002-save-is-a-drive-v2-if-match-compare-and-swap.md)) so edits made on another device are never silently overwritten; includes an interactive side-by-side merge view when conflicts occur.
- **Offline-first & Live Drive Sync** — IndexedDB local cache + offline edit queue, optional full-vault offline pinning, and incremental `changes.list` background sync.
- **Markdown Editor & Rich Preview** — warm CodeMirror 6 editor with instant Preview switching, GFM tables & checkboxes, syntax highlighting, KaTeX math, Mermaid diagrams, callouts, frontmatter properties, focus/typewriter/read-only modes, and a mirror right Document Info sidebar (Outline, Backlinks, Attachments, Stats).
- **PKM & Productivity** — `[[Wikilinks]]` with autocomplete & backlinks, global **Tasks** dashboard (with tag/folder/status filters and inline checkbox toggling), slash commands (`/`) & `Templates/`, and a `Cmd+K` command palette with full-text search.
- **Inline Image Attachments & Drive Version History** — paste, drop, or pick images uploaded to `_attachments/` and served same-origin, manage/delete unused attachments from the **Attachments** view or per-note sidebar, and browse/diff/restore previous Google Drive revisions.
- **SSRF-Safe URL Link Previews** — hover preview cards on external links and inline Notion/Bear-style bookmark cards for standalone URLs in Preview mode, proxied through the BFF to preserve strict CSP.
- **Multi-Account & Vault Picker** — omit `ROOT_FOLDER_ID` (and optionally set `ALLOWED_EMAILS=*`) so every signed-in Google account picks or creates its own isolated Drive vault folder, switchable anytime from **Settings**.
- **Configurable Settings & Optional Multi-Device Cloud Sync (Cloudflare D1)** — customize Attachments, Daily notes, and Templates folders, default open mode, theme, and link previews in **Settings** (`Cmd+K → Open Settings`). Set `ENABLE_STATE_DB=1` to sync vault selection, settings, last opened note, and expanded folders across devices in SQLite; omit it to stay 100% stateless.
- **Security by Design** — full Backend-for-Frontend (BFF) on Cloudflare Workers: Google OAuth tokens never leave the server, sessions live in AES-256-GCM sealed `HttpOnly` `__Host-` cookies, and the web app runs under a strict `default-src 'self'` Content Security Policy.

## Architecture

```
Browser (PWA: React 19 + Vite+ + Tailwind v4 + CodeMirror 6 + Dexie)
   │  same-origin cookies (__Host-s), strict CSP (default-src 'self')
   ▼
Cloudflare Worker BFF (TypeScript + Effect v4, deployed via Alchemy)
   ├── Static assets (web/dist)
   ├── /api/* → Google Drive v2/v3 & OAuth 2.0
   └── Optional Cloudflare D1 (SQLite) → /api/state
```

Architecture Decision Records live in [`docs/adr/`](docs/adr/):

- [ADR 0002](docs/adr/0002-save-is-a-drive-v2-if-match-compare-and-swap.md) — Conflict-safe saves via Drive v2 `If-Match` compare-and-swap
- [ADR 0003](docs/adr/0003-bff-on-cloudflare-workers-with-effect-v4.md) — TypeScript + Effect v4 BFF on Cloudflare Workers

## Prerequisites

- **Node.js 24+** and **pnpm**
- A **Google Cloud OAuth 2.0 Web Application** client with the **Google Drive API** enabled
- A **Cloudflare account** (for deploying the Worker and optional D1 database via [Alchemy](https://alchemy.run))

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
| `pnpm build` | Build production web bundle (`web/dist`) and verify BFF types/lint |
| `pnpm check:web` | Format, lint, and typecheck `web/` |
| `pnpm test:web` | Run Web test suite |
| `pnpm check:bff` | Format, lint, and typecheck `bff/` |
| `pnpm test:bff` | Run BFF test suite |

## License

[MIT](LICENSE)
