import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareTemporalTestServer, temporalTestServerPath } from "../scripts/temporal-test-server.mjs";

afterEach(() => vi.unstubAllEnvs());

it("reuses an explicit offline executable without starting or downloading a server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "space-temporal-setup-"));
  const executable = join(directory, "provided-server");
  try {
    // Deliberately not a runnable server: setup must only validate this override.
    await writeFile(executable, "offline provisioned fixture", { mode: 0o755 });
    vi.stubEnv("SPACE_TEMPORAL_TEST_SERVER_PATH", executable);
    expect(await prepareTemporalTestServer()).toBe(executable);
    expect(await temporalTestServerPath()).toBe(executable);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reports an invalid offline override without falling back to a network download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "space-temporal-missing-"));
  try {
    vi.stubEnv("SPACE_TEMPORAL_TEST_SERVER_PATH", join(directory, "missing-server"));
    await expect(prepareTemporalTestServer()).rejects.toThrow("npm run test:setup -w @space/worker");
    vi.stubEnv("SPACE_TEMPORAL_TEST_SERVER_PATH", directory);
    await expect(temporalTestServerPath()).rejects.toThrow("SPACE_TEMPORAL_TEST_SERVER_PATH");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
