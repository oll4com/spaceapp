import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instanceStorageDirectory } from "../src/instance-storage.js";
import { PluginsService } from "../src/plugins-service.js";

const temporaryRoots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-instance-storage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(root));
    if (!inside.startsWith("space-instance-storage-") || inside.includes(sep)) {
      throw new Error("Refusing cleanup outside this test's temporary root.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("instance-local service storage", () => {
  it("preserves installed defaults and the stable personal Git override", () => {
    expect(instanceStorageDirectory("plugins", undefined, {})).toBe("/opt/spaceapp/var/plugins");
    expect(instanceStorageDirectory("personal-source-control", undefined, {})).toBe("/opt/spaceapp/var/personal-source-control");
    expect(instanceStorageDirectory("personal-source-control", "/operator/chosen", { SPACE_INSTANCE: "stable" })).toBe("/operator/chosen");
  });

  it("fails closed without a private absolute dev install root", async () => {
    for (const SPACE_INSTALL_ROOT of [undefined, "relative", "/opt/spaceapp", "/opt/spaceapp/"]) {
      expect(() => instanceStorageDirectory("plugins", undefined, { SPACE_INSTANCE: "dev", SPACE_INSTALL_ROOT })).toThrow(/private absolute/);
    }
    const root = await fixture();
    const env = { SPACE_INSTANCE: "dev", SPACE_INSTALL_ROOT: join(root, "install") };
    expect(() => instanceStorageDirectory("personal-source-control", "relative", env)).toThrow(/absolute/);
    expect(() => instanceStorageDirectory("personal-source-control", join(root, "operator"), env)).toThrow(/escape/);
    expect(() => instanceStorageDirectory("personal-source-control", `${env.SPACE_INSTALL_ROOT}-sibling`, env)).toThrow(/escape/);
  });

  it("keeps two dev instances and an explicit credential override in their own roots", async () => {
    const root = await fixture();
    const first = { SPACE_INSTANCE: "dev", SPACE_INSTALL_ROOT: join(root, "first") };
    const second = { SPACE_INSTANCE: "dev", SPACE_INSTALL_ROOT: join(root, "second") };
    for (const name of ["plugins", "personal-source-control"] as const) {
      expect(instanceStorageDirectory(name, undefined, first)).toBe(join(first.SPACE_INSTALL_ROOT, "var", name));
      expect(instanceStorageDirectory(name, undefined, second)).toBe(join(second.SPACE_INSTALL_ROOT, "var", name));
      expect(instanceStorageDirectory(name, undefined, first)).not.toBe(instanceStorageDirectory(name, undefined, second));
    }
    const credentials = join(first.SPACE_INSTALL_ROOT, "private-credentials");
    expect(instanceStorageDirectory("personal-source-control", credentials, first)).toBe(credentials);
  });

  it("persists real dev plugin changes privately without syncing operator skill links", async () => {
    const root = await fixture();
    const install = join(root, "install"), operator = join(root, "operator-skills");
    await mkdir(operator);
    await writeFile(join(operator, "owner-sentinel"), "unchanged operator data");
    vi.stubEnv("SPACE_INSTANCE", "dev");
    vi.stubEnv("SPACE_INSTALL_ROOT", install);
    vi.stubEnv("SPACE_INSTANCE_ENABLED_JOBS", "");
    const service = new PluginsService(undefined, undefined, [operator]);
    const synced = vi.fn(async () => undefined);
    service.onSkillsSynced = synced;
    expect((await service.getPlugins()).length).toBeGreaterThan(0);
    const config = { paneId: "dev-pane", enabledPluginIds: ["superpowers"], disabledPluginIds: [] };
    await service.setAgentConfig(config);
    expect(await service.getAgentConfig(config.paneId)).toEqual(config);
    expect((await service.connectPlugin({ pluginId: "superpowers", credentials: {} })).status).toBe("CONNECTED");
    expect((await service.disconnectPlugin("superpowers")).status).toBe("NOT_CONNECTED");
    await service.syncSkillSymlinks();
    expect(synced).not.toHaveBeenCalled();
    expect(await readdir(operator)).toEqual(["owner-sentinel"]);
    expect(await readFile(join(operator, "owner-sentinel"), "utf8")).toBe("unchanged operator data");
    const storage = join(install, "var", "plugins");
    expect(JSON.parse(await readFile(join(storage, "connections.json"), "utf8"))[0]).toMatchObject({ pluginId: "superpowers", status: "NOT_CONNECTED" });
    expect(JSON.parse(await readFile(join(storage, "agent-configs.json"), "utf8"))).toEqual([config]);
  });

  it("retains stable synchronization and honors the existing explicit dev opt-in", async () => {
    const root = await fixture();
    for (const instance of ["stable", "dev"] as const) {
      vi.stubEnv("SPACE_INSTANCE", instance);
      vi.stubEnv("SPACE_INSTANCE_ENABLED_JOBS", instance === "dev" ? "plugin-skill-links" : "");
      // No installed skill directory is ever used, even by this active-sync control.
      const service = new PluginsService(join(root, instance), undefined, []);
      const synced = vi.fn(async () => undefined);
      service.onSkillsSynced = synced;
      await service.connectPlugin({ pluginId: "superpowers", credentials: {} });
      await service.disconnectPlugin("superpowers");
      expect(synced).toHaveBeenCalledTimes(2);
    }
  });
});
