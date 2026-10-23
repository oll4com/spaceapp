import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@space/db": resolve(__dirname, "../../packages/db/src/index.ts"),
      "@space/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@space/opencode-control": resolve(__dirname, "../../packages/opencode-control/src/index.ts"),
      "@space/runtime": resolve(__dirname, "../../packages/runtime/src/index.ts"),
      "@space/streaming": resolve(__dirname, "../../packages/streaming/src/index.ts"),
      "@space/memory-graph": resolve(__dirname, "../../packages/memory-graph/src/index.ts"),
      "@space/codex-app-server": resolve(__dirname, "../../packages/codex-app-server/src/index.ts"),
      "@space/opencode-control": resolve(__dirname, "../../packages/opencode-control/src/index.ts")
    }
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**"
    ],
    maxWorkers: 2,
    minWorkers: 1
  }
});
