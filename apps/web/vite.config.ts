import { defineConfig } from "vitest/config";
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
  plugins: [react(), demoBundleBoundaryPlugin()],
  build: {
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: manualChunkForModule
      }
    }
  },
  server: {
    host: process.env.SPACE_WEB_HOST ?? "0.0.0.0",
    port: Number.parseInt(process.env.SPACE_WEB_PORT ?? "4911", 10),
    proxy: {
      "/api": "http://127.0.0.1:4910",
      "/healthz": "http://127.0.0.1:4910",
      "/readyz": "http://127.0.0.1:4910",
      "/version": "http://127.0.0.1:4910"
    }
  },
  test: {
    environment: "jsdom",
    globals: true
  }
});
