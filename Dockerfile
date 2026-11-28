# syntax=docker/dockerfile:1
# Markyard on Node 24 (#39): the unchanged BFF plus web/dist behind host-node/server.mjs.
# Stateless; configured by env vars with the Cloudflare binding names (see .env.docker.example).

ARG NODE_IMAGE=node:24-alpine
ARG PNPM_VERSION=11.1.1

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
COPY bff/package.json bff/
COPY host-node/package.json host-node/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --dir web build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter @markyard/bff --filter @markyard/host-node

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/bff/node_modules bff/node_modules
COPY --from=deps /app/host-node/node_modules host-node/node_modules
COPY package.json ./
COPY bff/package.json bff/
COPY bff/src bff/src
COPY host-node/package.json host-node/host.mjs host-node/server.mjs host-node/ssrf-guard.mjs host-node/static-host.mjs host-node/
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "host-node/server.mjs"]
