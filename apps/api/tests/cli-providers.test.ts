import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCliProviderSettings,
  updateCliProviderSetting,
  updateAllCliProviders,
  type OpenCodeConfigFile
} from "../src/cli-providers.js";

// A real shared config is kilobytes; writers refuse one under 100 bytes as a stub (28/10 ENOSPC incident).
const realistic = (config: OpenCodeConfigFile): OpenCodeConfigFile => ({
  $schema: "https://opencode.ai/config.json",
  instructions: ["/etc/AGENTS.md", "/opt/spaceapp/docs/space.md"],
  mcp: { space_dispatcher: { type: "local", command: ["/usr/bin/node", "/opt/spaceapp/bin/space-mcp-dispatcher.mjs"], enabled: true } },
  ...config
});

describe("CLI Providers Settings", () => {
  it("reads default config and identifies enabled and disabled providers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
    const configPath = join(tempDir, "opencode.json");

    const fixture: OpenCodeConfigFile = {
      disabled_providers: ["opencode-go", "openai"],
      provider: {
        "custom-ai": {
          name: "Custom AI Provider",
          models: { "m1": {} }
        }
      }
    };
    await writeFile(configPath, JSON.stringify(realistic(fixture), null, 2), "utf8");

    try {
      const result = await getCliProviderSettings(configPath);
      expect(result.disabledProviders).toContain("opencode-go");
      expect(result.disabledProviders).toContain("openai");
      expect(result.providers.length).toBeGreaterThan(8);

      const opencodeGo = result.providers.find((p) => p.id === "opencode-go");
      expect(opencodeGo?.enabled).toBe(false);

      const opencodeZen = result.providers.find((p) => p.id === "opencode");
      expect(opencodeZen?.enabled).toBe(true);

      const customAi = result.providers.find((p) => p.id === "custom-ai");
      expect(customAi?.enabled).toBe(true);
      expect(customAi?.isCustom).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates individual provider setting and triggers restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
    const configPath = join(tempDir, "opencode.json");

    const fixture: OpenCodeConfigFile = {
      disabled_providers: ["opencode-go"]
    };
    await writeFile(configPath, JSON.stringify(realistic(fixture), null, 2), "utf8");

    let restarted = false;
    const restartServer = async () => {
      restarted = true;
    };

    try {
      // Enable opencode-go
      const afterEnable = await updateCliProviderSetting("opencode-go", true, { configPath, restartServer });
      expect(restarted).toBe(true);
      expect(afterEnable.disabledProviders).not.toContain("opencode-go");
      expect(afterEnable.providers.find((p) => p.id === "opencode-go")?.enabled).toBe(true);

      // Disable opencode
      restarted = false;
      const afterDisable = await updateCliProviderSetting("opencode", false, { configPath, restartServer });
      expect(restarted).toBe(true);
      expect(afterDisable.disabledProviders).toContain("opencode");
      expect(afterDisable.providers.find((p) => p.id === "opencode")?.enabled).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("updates all providers at once (enable all / disable all)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
    const configPath = join(tempDir, "opencode.json");

    const fixture: OpenCodeConfigFile = {
      disabled_providers: ["opencode-go", "openai"]
    };
    await writeFile(configPath, JSON.stringify(realistic(fixture), null, 2), "utf8");

    let restarted = false;
    const restartServer = async () => {
      restarted = true;
    };

    try {
      // Enable all
      const allEnabled = await updateAllCliProviders(true, { configPath, restartServer });
      expect(restarted).toBe(true);
      expect(allEnabled.disabledProviders).toEqual([]);
      expect(allEnabled.providers.every((p) => p.enabled)).toBe(true);

      // Disable all
      restarted = false;
      const allDisabled = await updateAllCliProviders(false, { configPath, restartServer });
      expect(restarted).toBe(true);
      expect(allDisabled.providers.every((p) => !p.enabled)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // 28/10 22:00:49 UTC an ENOSPC write emptied the shared config and a toggle then wrote a 31-byte stub over it.
  it("refuses to write an empty, stub, broken or missing config and names the newest backup", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-test-"));
    const configPath = join(tempDir, "opencode.json");
    const backup = JSON.stringify(realistic({ disabled_providers: [] }), null, 2);
    await writeFile(`${configPath}.bak-space-gateway-2026-10-17T07-37-41-227Z`, backup, "utf8");
    let restarted = false;
    const restartServer = async () => {
      restarted = true;
    };
    try {
      for (const [text, reason] of [["", "holds only 0 bytes"], ["{\n  \"disabled_providers\": []\n}\n", "holds only 31 bytes"], [`${backup.slice(0, 120)}`, "is not valid JSON"]] as const) {
        await writeFile(configPath, text, "utf8");
        for (const update of [() => updateCliProviderSetting("space-gateway-claude", true, { configPath, restartServer }), () => updateAllCliProviders(true, { configPath, restartServer })]) {
          await expect(update()).rejects.toThrow(`${configPath} ${reason}; refusing to write it. Restore it from ${configPath}.bak-space-gateway-2026-10-17T07-37-41-227Z first.`);
        }
        expect(await readFile(configPath, "utf8")).toBe(text);
      }
      await rm(configPath);
      await expect(updateCliProviderSetting("opencode", false, { configPath, restartServer })).rejects.toThrow("cannot be read (ENOENT)");
      expect(restarted).toBe(false);
      expect((await readdir(tempDir)).filter((name) => name !== `opencode.json.bak-space-gateway-2026-10-17T07-37-41-227Z`)).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
