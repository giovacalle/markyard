import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// `alchemy dev` bundles `bff/src/worker.ts` and hot-reloads it; Vite+ serves `web/` and proxies `/api`.
const rootDir = resolve(import.meta.dirname, "..");

mkdirSync(resolve(rootDir, "web/dist"), { recursive: true });

const children = [
  spawn("pnpm", ["exec", "alchemy", "dev"], { cwd: rootDir, stdio: "inherit", detached: true }),
  spawn("pnpm", ["--dir", "web", "dev"], { cwd: rootDir, stdio: "inherit", detached: true }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

for (const child of children) {
  child.on("exit", (code) => shutdown(code ?? 1));
}
