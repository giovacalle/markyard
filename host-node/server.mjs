// Entry point of the Node 24 host: `node host-node/server.mjs`. Config comes from environment
// variables with the Cloudflare binding names (see `.env.example`), plus PORT, HOST and DIST_DIR.

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "srvx";

import { bffEnvFrom, createHost, withAccessLog } from "./host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = resolve(here, "../web/dist");
const DEFAULT_PORT = 8080;
const SHUTDOWN_GRACE_MS = 10_000;

const parsePort = (raw) => {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error(`Invalid PORT "${raw}"`);
  return Number(raw);
};

/**
 * Starts the host and resolves once it listens.
 * @param {{ source?: Record<string, string | undefined>, log?: (line: string) => void } & Record<string, unknown>} options
 */
export const startServer = async ({ source = process.env, log = console.log, ...deps } = {}) => {
  const distDir = resolve(source.DIST_DIR || DEFAULT_DIST_DIR);
  if (!statSync(resolve(distDir, "index.html"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${distDir}/index.html is missing; run "pnpm build" first`);
  }
  const handler = createHost({ distDir, env: bffEnvFrom(source), ...deps });
  const server = serve({
    fetch: withAccessLog(handler, log),
    port: parsePort(source.PORT),
    hostname: source.HOST || "0.0.0.0",
    silent: true,
    gracefulShutdown: false,
  });
  await server.ready();
  return server;
};

const main = async () => {
  let server;
  try {
    server = await startServer();
  } catch (error) {
    console.error(`markyard: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`markyard listening on ${server.url}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`markyard: ${signal}, closing`);
    const force = setTimeout(() => void server.close(true), SHUTDOWN_GRACE_MS);
    force.unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
