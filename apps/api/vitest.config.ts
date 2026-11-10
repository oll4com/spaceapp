import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@space/cli-host": resolve(__dirname, "../../packages/cli-host/src/index.ts"),
      "@space/db": resolve(__dirname, "../../packages/db/src/index.ts"),
      "@space/gateway": resolve(__dirname, "../../packages/gateway/src/index.ts"),
      "@space/contracts/sentry-node": resolve(__dirname, "../../packages/contracts/src/sentry-node.ts"),
      "@space/contracts/sentry": resolve(__dirname, "../../packages/contracts/src/sentry.ts"),
      "@space/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@space/opencode-control": resolve(__dirname, "../../packages/opencode-control/src/index.ts"),
      "@space/runtime": resolve(__dirname, "../../packages/runtime/src/index.ts"),
      "@space/streaming": resolve(__dirname, "../../packages/streaming/src/index.ts")
    }
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**"
    ],
    // Each test's own plugins folder instead of stable's /opt/spaceapp/var/plugins.
    setupFiles: ["./tests/support/isolate-plugins.ts", "./tests/support/isolate-programs.ts", "./tests/support/chrome-sandbox.ts"],
    maxWorkers: 2,
    minWorkers: 1,
    // Most API tests build the whole app; on the shared public-host that alone can pass 5 s under load
    // (two cli-runtimes tests in the full npm test of 2026-10-12).
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
