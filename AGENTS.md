# markyard

Self-hosted Markdown notes PWA backed by Google Drive, served by a TypeScript + Effect v4 BFF on Cloudflare Workers (deployed with Alchemy). See `README.md` and `docs/adr/` for architecture and constraints.

## Architecture invariants

- **BFF (`bff/`, ADR 0003)**:
  - Keep `bff/src/` free of `node:` imports and free of `alchemy` / `@alchemy.run/cloudflare` runtime imports (`alchemy.run.ts` is the only file that imports Alchemy).
  - File downloads/uploads and binary proxies stream unread Web `ReadableStream` bodies without buffering on the JS heap.
  - Saves use Google Drive v2 `If-Match` ETags (ADR 0002).
  - Optional Cloudflare D1 (`STATE_DB`) is duck-typed and gracefully disabled when unbound.
- **Web (`web/`)**:
  - Strict Content Security Policy (`web/public/_headers`): `default-src 'self'`. Zero JSX `style={...}`, zero `setAttribute("style", ...)`, zero inline `<style>` tags (use CSSOM `element.style.setProperty(...)` or `adoptedStyleSheets` when dynamic positioning/styles are required).
  - Keep `skipHtml` enabled in `Preview.tsx` and keep `web/public/sw.js` precaching lean.

## Commands

Prerequisites: Node 24, `pnpm`.

- Dev (Worker on `:8787`, Vite+ on `:5173` proxying `/api`): `pnpm dev`
  - Reads a root `.env` (git-ignored; see `.env.example`).
- Production build (web bundle + BFF check): `pnpm build`
- Web check / test: `pnpm check:web`, `pnpm test:web`
- BFF check / test: `pnpm check:bff`, `pnpm test:bff`
- Local-only Worker run (no Cloudflare state writes, port 8788):
  `ALCHEMY_LOCAL_STATE=1 BFF_DEV_PORT=8788 pnpm exec alchemy dev --stage local`

## Deploy

Once changes are tested, committed, and pushed to `origin/main`:

```sh
pnpm install --frozen-lockfile && pnpm build && NODE_OPTIONS="--dns-result-order=ipv4first" pnpm exec alchemy deploy --stage prod --yes
```

## Agent skills

- Issue tracker conventions: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain docs (`docs/adr/`): `docs/agents/domain.md`
