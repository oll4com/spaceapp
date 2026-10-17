import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { retainOpenTabAssets } from "./vite.asset-retention.js";
import react from "@vitejs/plugin-react";
import { demoBundleBoundaryPlugin } from "./vite.demo-boundary.js";

export function manualChunkForModule(moduleId: string): string | undefined {
  const normalizedId = moduleId.replaceAll("\\", "/");
  if (
    normalizedId.includes("/node_modules/react/") ||
    normalizedId.includes("/node_modules/react-dom/") ||
    normalizedId.includes("/node_modules/scheduler/")
  ) return "vendor-react";
  if (normalizedId.includes("/node_modules/@xterm/")) return "vendor-xterm";
  if (normalizedId.includes("/node_modules/lucide-react/")) return "vendor-icons";
  if (normalizedId.includes("/node_modules/zod/")) return "vendor-validation";
  return undefined;
}

export default defineConfig({
  plugins: [react(), demoBundleBoundaryPlugin(), retainOpenTabAssets()],
  // The icon package ships as source; the alias keeps worktrees (which share live node_modules) resolving this checkout.
  resolve: { alias: [{ find: /^@space\/icons$/, replacement: fileURLToPath(new URL("../../packages/icons/src/app-icons.tsx", import.meta.url)) }] },
  build: {
    emptyOutDir: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: manualChunkForModule
      }
    }
  },
  server: (() => {
    const apiOrigin =
      process.env.SPACE_API_ORIGIN ??
      `http://127.0.0.1:${Number.parseInt(process.env.SPACE_API_PORT ?? "4910", 10)}`;
    return {
      host: process.env.SPACE_WEB_HOST ?? "0.0.0.0",
      port: Number.parseInt(process.env.SPACE_WEB_PORT ?? "4911", 10),
      proxy: {
        "/api": {
          target: apiOrigin,
          ws: true
        },
        "/plugins": apiOrigin,
        "/healthz": apiOrigin,
        "/readyz": apiOrigin,
        "/version": apiOrigin
      }
    };
  })(),
  test: {
    environment: "jsdom",
    globals: true,
    // public-host runs many agents at once. With the default one worker per core, a full web run
    // loaded the host so far that about 400 rendering tests passed the 5 s limit (2026-10-12);
    // with 4 workers and 20 s the same files had no timeouts.
    maxWorkers: 4,
    testTimeout: 20_000,
    // Shared CI runners (GitHub) occasionally miss a 1 s waitFor in the long jsdom UI tests; locally a failure stays a failure.
    retry: process.env.CI ? 2 : 0,
    hookTimeout: 20_000,
    setupFiles: ["./tests/setup-testing-library.ts"],
    // Worktrees share node_modules with the live checkout, so tests pin the contracts package to
    // this checkout's source (the API suite does the same); builds keep resolving the built package.
    alias: [{ find: /^@space\/contracts$/, replacement: fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)) }]
  }
});
