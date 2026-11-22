import { createHash } from "node:crypto";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";
import { buildServiceWorkerSource, collectPrecacheUrls, SHELL_CACHE_PREFIX } from "./src/sw-source";

function pwaServiceWorker(): Plugin {
  return {
    name: "markyard-pwa-sw",
    apply: "build",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      for (const fileName of Object.keys(bundle).sort()) {
        if (fileName === "_headers" || fileName === "sw.js" || fileName.endsWith(".map")) {
          continue;
        }
        const item = bundle[fileName];
        hash.update(fileName);
        if (item.type === "chunk") {
          hash.update(item.code);
        } else {
          hash.update(item.source);
        }
      }

      const version = hash.digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: buildServiceWorkerSource(
          `${SHELL_CACHE_PREFIX}${version}`,
          collectPrecacheUrls(bundle),
        ),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaServiceWorker()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
