import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Golden vectors are captured from Rust byte-for-byte; keep them as written.
    ignorePatterns: ["test/fixtures/**"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
