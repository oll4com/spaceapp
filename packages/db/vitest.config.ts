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
      "@space/runtime": resolve(__dirname, "../runtime/src/index.ts")
    }
  },
  test: { exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**"] }
});
