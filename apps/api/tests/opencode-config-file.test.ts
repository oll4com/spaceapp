import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 28/10 22:00:49 UTC an in-place write of the shared OpenCode config hit ENOSPC and left it empty. A full disk is
// simulated for the API's writer (the provider toggles): the temp file's write fails after a partial chunk.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (path: string, flags: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      if (!disk.full || flags !== "wx") return handle;
      return Object.assign(Object.create(handle), {
        writeFile: async () => {
          await handle.writeFile("{\n  \"$sch");
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        },
        sync: () => handle.sync(),
        close: () => handle.close()
      });
    }) as typeof actual.open
  };
});

const { updateCliProviderSetting, updateAllCliProviders } = await import("../src/cli-providers.js");

const config = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", instructions: ["/etc/AGENTS.md"], provider: { "space-gateway-claude": { name: "Space Gateway Claude (API credits)", models: { "claude-sonnet-5-5": {} } } }, disabled_providers: ["openai"] }, null, 2)}\n`;

describe("the API's OpenCode config writer on a full disk", () => {
  afterEach(() => {
    disk.full = false;
  });

  it("leaves the config intact, removes its temp file and does not restart the server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-enospc-"));
    const configPath = join(dir, "opencode.json");
    await writeFile(configPath, config, "utf8");
    let restarted = false;
    const restartServer = async () => {
      restarted = true;
    };
    try {
      disk.full = true;
      await expect(updateCliProviderSetting("openai", true, { configPath, restartServer })).rejects.toThrow("ENOSPC");
      await expect(updateAllCliProviders(false, { configPath, restartServer })).rejects.toThrow("ENOSPC");
      expect(await readFile(configPath, "utf8")).toBe(config);
      expect(restarted).toBe(false);
      const names = await readdir(dir);
      expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
      // Each attempt kept a full copy first.
      for (const name of names.filter((entry) => entry.startsWith("opencode.json.bak-space-cli-providers-"))) {
        expect(await readFile(join(dir, name), "utf8")).toBe(config);
      }
      disk.full = false;
      const after = await updateCliProviderSetting("openai", true, { configPath, restartServer });
      expect(after.disabledProviders).toEqual([]);
      expect(JSON.parse(await readFile(configPath, "utf8")).provider["space-gateway-claude"].name).toBe("Space Gateway Claude (API credits)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
