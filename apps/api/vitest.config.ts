import { defineConfig } from "vitest/config";

export default defineConfig({
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
