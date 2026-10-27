import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAuthenticatedInstallationHandoff } from "../src/installation-handoff.js";

const secret = "installation-specific-session-secret-for-tests";

describe("authenticated installer handoff", () => {
  it("accepts only matching signed sanitized memory and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-handoff-"));
    try {
      await mkdir(root, { recursive: true });
      const memory = "# SpaceApp installation memory\n\nSchema: 1\nPlatform: linux\nHardware profile: small\nVerified free model: opencode/big-pickle\nAssistant status: completed a live account-free tool call before Docker setup.\nNext action: continue the approved SpaceApp installation.\n";
      const payload = {
        schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"),
        modelId: "opencode/big-pickle", completed: true
      };
      const mac = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), memory);
      await writeFile(join(root, "installation-handoff.json"), JSON.stringify({ ...payload, mac }));
      expect(await readAuthenticatedInstallationHandoff(root, secret)).toEqual({ modelId: payload.modelId, completed: true });
      expect(await readAuthenticatedInstallationHandoff(root, "another-installation-secret-with-length")).toBeNull();
      const catalog = JSON.stringify({ schema: 1, benchmarkVersion: "tool-call:v1", checkedAt: new Date().toISOString(), models: [
        { id: "opencode/big-pickle", anonymousAvailable: true, setupPassed: 2, attempts: 2, successes: 2, latencyMs: 50,
          context: 100000, toolcall: true, text: true, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }
      ] });
      const catalogPayload = { ...payload, catalogSha256: createHash("sha256").update(catalog).digest("hex") };
      await writeFile(join(root, "free-model-catalog.json"), catalog);
      await writeFile(join(root, "installation-handoff.json"), JSON.stringify({ ...catalogPayload,
        mac: createHmac("sha256", secret).update(JSON.stringify(catalogPayload)).digest("hex") }));
      expect(await readAuthenticatedInstallationHandoff(root, secret)).toMatchObject({
        catalog: { models: [{ id: "opencode/big-pickle", anonymousAvailable: true }] }
      });
      await writeFile(join(root, "free-model-catalog.json"), `${catalog} `);
      expect(await readAuthenticatedInstallationHandoff(root, secret)).toBeNull();
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), `${memory}API key: injected\n`);
      expect(await readAuthenticatedInstallationHandoff(root, secret)).toBeNull();
      // An OpenCode 1 installer proved only a text answer (operator rule 2026-10-11: working only after a real tool call).
      const textOnly = memory.replace("completed a live account-free tool call", "completed a live account-free text task");
      const textPayload = { ...payload, memorySha256: createHash("sha256").update(textOnly).digest("hex") };
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), textOnly);
      await writeFile(join(root, "installation-handoff.json"), JSON.stringify({ ...textPayload,
        mac: createHmac("sha256", secret).update(JSON.stringify(textPayload)).digest("hex") }));
      expect(await readAuthenticatedInstallationHandoff(root, secret)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Review 2026-10-21 #10: the installer's profiles are small, medium, large, light and standard ("full" never was one), and
  // an upgrade's signed handoff, which completed no assistant check, is never a completed one.
  it("reads every installer hardware profile and never takes an incomplete handoff as completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-handoff-notes-"));
    try {
      const sign = async (memory: string, modelId: string | null, completed: boolean) => {
        const payload = { schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"), modelId, completed };
        await writeFile(join(root, "INSTALLATION_MEMORY.md"), memory);
        await writeFile(join(root, "installation-handoff.json"), JSON.stringify({ ...payload,
          mac: createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex") }));
      };
      await sign("# SpaceApp installation memory\n\nSchema: 1\nPlatform: darwin\nHardware profile: standard\nVerified free model: opencode/big-pickle\nAssistant status: completed a live account-free tool call before Docker setup.\nCompleted installer assistant actions: CHECK_PREREQUISITES, START_DOCKER\n",
        "opencode/big-pickle", true);
      expect(await readAuthenticatedInstallationHandoff(root, secret, true)).toMatchObject({
        notes: { platform: "darwin", hardwareProfile: "standard", completedActions: ["CHECK_PREREQUISITES", "START_DOCKER"] } });
      await sign("# SpaceApp installation memory\n\nSchema: 1\nPlatform: linux\nHardware profile: medium\nAssistant status: unavailable\n", null, false);
      expect(await readAuthenticatedInstallationHandoff(root, secret, true)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
