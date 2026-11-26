import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Worktrees share the live checkout's node_modules, so without these aliases the tests would read stable's packages.
export default defineConfig({
  resolve: {
    alias: {
      "@space/contracts": resolve(__dirname, "../contracts/src/index.ts"),
      "@space/memory-graph": resolve(__dirname, "../memory-graph/src/index.ts"),
      "@space/runtime": resolve(__dirname, "../runtime/src/index.ts")
    }
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    // Half the files start their own Docker Postgres: one worker per core timed out docker run on the shared host (as web, cb5f677f17).
    maxWorkers: 4,
    // afterAll stops a disposable Postgres: docker exec (30 s) + docker rm (60 s) in tests/support/disposable-postgres.ts; the 10 s default timed out under load.
    hookTimeout: 90_000
  }
});
