import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

export default defineConfig({
  resolve: {
    // scripts/space-media-capture.mjs (design-capture-parity) imports runtime's build; test this tree's source, not a missing or stale dist.
    alias: [{ find: /^(?:\.\.\/)+packages\/runtime\/dist\/(.+)\.js$/, replacement: `${root}/packages/runtime/src/$1.ts` }]
  }
});
