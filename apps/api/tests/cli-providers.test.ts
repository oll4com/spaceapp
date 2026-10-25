import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCliProviderSettings,
  updateCliProviderSetting,
  updateAllCliProviders,
  type OpenCodeConfigFile
} from "../src/cli-providers.js";

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
    await writeFile(configPath, JSON.stringify(fixture, null, 2), "utf8");

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
    await writeFile(configPath, JSON.stringify(fixture, null, 2), "utf8");

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
    await writeFile(configPath, JSON.stringify(fixture, null, 2), "utf8");

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
});
