import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setupClientRuntimeBuildId } from "../src/setup-client-runtime-verification.js";

vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), readFile: vi.fn()
}));
afterEach(() => vi.resetAllMocks());

it("invalidates development identity when the running client checker changes despite an older web build", async () => {
  let client = "checker-before";
  vi.mocked(readFile).mockImplementation(async path => Buffer.from(
    String(path).endsWith("setup-client-runtime-check.ts") ? client : "unchanged-existing-build"
  ));
  const before = await setupClientRuntimeBuildId();
  client = "checker-after";
  expect(await setupClientRuntimeBuildId()).not.toBe(before);
});
