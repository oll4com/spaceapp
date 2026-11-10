import { vi } from "vitest";

// The real sandbox check starts a Chrome (src/browser-sandbox.ts); tests that mock child_process or start sessions would
// wait on it. Every test keeps today's --no-sandbox argv; tests/browser-sandbox.test.ts tests the real module.
vi.mock("../../src/browser-sandbox.js", () => ({
  chromeSandboxCheck: () => ({
    args: async () => ["--no-sandbox"],
    state: () => ({ state: "NO_SANDBOX", reason: "test stub", checkedAt: null })
  })
}));
