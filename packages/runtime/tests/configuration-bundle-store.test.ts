import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "../src/store.js";
import { ConfigSecretsError, sealConfigBundle } from "../src/configuration-secrets.js";
import { configBundleVersion, parseConfigBundleLeniently, spaceConfigBundleSchema, type SpaceConfigBundle } from "@space/contracts";

describe("Configuration Bundle Export & Import", () => {
  it("exports configuration bundle from store and imports into a clean store", async () => {
    const sourceStore = new InMemorySpaceStore();
    const userId = "user:operator";

    // 1. Seed user settings
    await sourceStore.updateUserSettings(userId, {
      uiTheme: "motion",
      roomTheme: "steel",
      modernAppearance: "light",
      dateTime: {
        timeZone: "Asia/Bangkok",
        dateFormat: "DD/MM/YYYY",
        timeFormat: "24h"
      }
    });

    // 2. Seed a room and panes
    const room = await sourceStore.createRoom(
      {
        name: "Test Room Alpha",
        description: "A room for testing",
        initialPaneCount: 2
      },
      "trace-seed",
      userId
    );

    // 3. Seed user link
    await sourceStore.createUserLink({
      ownerUserId: userId,
      title: "Test Link",
      url: "https://example.com/test",
      openMode: "NEW_TAB",
      category: "GENERAL",
      isQuick: true
    });

    // 4. Seed clipboard item
    await sourceStore.upsertClipboardItem({
      ownerUserId: userId,
      text: "Test plan clipboard item content",
      source: "PLAN",
      title: "Seed Plan",
      minimumModel: "gpt-5.6-sol"
    });

    // Export bundle
    const bundle = await sourceStore.exportConfigurationBundle({ userId });
    expect(bundle.format).toBe("spaceapp-configuration-bundle");
    expect(bundle.version).toBe(configBundleVersion);
    expect(bundle.metadata.roomsCount).toBe(1);
    expect(bundle.metadata.panesCount).toBe(2);
    expect(bundle.metadata.userLinksCount).toBeGreaterThanOrEqual(1);
    expect(bundle.metadata.clipboardItemsCount).toBe(1);
    expect(bundle.data.userSettings?.uiTheme).toBe("motion");

    // Validate bundle schema
    const validated = spaceConfigBundleSchema.parse(bundle);
    expect(validated.data.rooms[0]?.name).toBe("Test Room Alpha");

    // Import into target store
    const targetStore = new InMemorySpaceStore();
    const targetUserId = "user:local-operator";

    const importResult = await targetStore.importConfigurationBundle(bundle, {
      mode: "replace", confirmReplace: true,
      targetUserId
    });

    expect(importResult.success).toBe(true);
    expect(importResult.targetUserId).toBe(targetUserId);
    expect(importResult.stats.roomsImported).toBe(1);
    expect(importResult.stats.panesImported).toBe(2);
    expect(importResult.stats.settingsUpdated).toBe(true);

    // Verify target store state
    const targetRooms = await targetStore.listRooms(targetUserId);
    expect(targetRooms.length).toBe(1);
    expect(targetRooms[0]?.name).toBe("Test Room Alpha");

    const targetPanes = await targetStore.listPanes(targetRooms[0]!.id);
    expect(targetPanes.length).toBe(2);

    const targetSettings = await targetStore.getUserSettings(targetUserId);
    expect(targetSettings.uiTheme).toBe("motion");
    expect(targetSettings.roomTheme).toBe("steel");

    const targetLinks = await targetStore.listUserLinks(targetUserId, { isQuick: undefined, page: 1, pageSize: 10 });
    expect(targetLinks.items.some((l) => l.title === "Test Link")).toBe(true);

    const targetClips = await targetStore.listClipboardItems(targetUserId, { page: 1, pageSize: 10 });
    expect(targetClips.items.some((c) => c.title === "Seed Plan")).toBe(true);
  });

  it("supports exporting and importing bundles with granular API keys and credentials", async () => {
    const sourceStore = new InMemorySpaceStore();
    const userId = "user:operator";

    // Create a bundle directly with mock apiKeys and credentials
    const baseBundle = await sourceStore.exportConfigurationBundle({ userId });
    const bundleWithSecrets = {
      ...baseBundle,
      metadata: {
        ...baseBundle.metadata,
        apiKeysCount: 2,
        credentialsCount: 1
      },
      data: {
        ...baseBundle.data,
        apiKeys: {
          deepseek: "sk-test-deepseek-12345",
          codex: "sk-proj-test-openai-67890"
        },
        credentials: {
          codex: JSON.stringify({ token: "test-oauth-token" })
        }
      }
    };

    // Validate schema accepts it
    const validated = spaceConfigBundleSchema.parse(bundleWithSecrets);
    expect(validated.data.apiKeys?.deepseek).toBe("sk-test-deepseek-12345");
    expect(validated.data.credentials?.codex).toBeDefined();

    // Import into a target store with temporary dirs
    const targetStore = new InMemorySpaceStore();
    const testSecretsDir = `/tmp/test-spaceapp-secrets-${Date.now()}`;
    const testCredsDir = `/tmp/test-spaceapp-creds-${Date.now()}`;

    const res = await targetStore.importConfigurationBundle(bundleWithSecrets, {
      mode: "replace", confirmReplace: true,
      targetUserId: "user:target",
      secretsDir: testSecretsDir,
      credentialsDir: testCredsDir
    });

    expect(res.success).toBe(true);
    expect(res.stats.apiKeysImported).toBe(2);
    // Older backups' plaintext login files went to a folder no CLI reads; they are reported, not written.
    expect(res.stats.credentialsImported).toBe(0);
    expect(res.warnings.some((w) => w.includes("Imported 2 provider API key(s)"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("older backups are not restored"))).toBe(true);
  });

  const passphrase = "correct horse battery staple";
  const codexLogin = JSON.stringify({ tokens: { refresh_token: "rt-synthetic-codex-login" } });
  async function sealBackup(): Promise<SpaceConfigBundle> {
    const store = new InMemorySpaceStore();
    await store.createRoom({ name: "Sealed", initialPaneCount: 1 }, "trace-sealed", "user:operator");
    const bundle = await store.exportConfigurationBundle({ userId: "user:operator" });
    return sealConfigBundle(bundle, {
      apiKeys: { deepseek: "sk-synthetic-deepseek-key" },
      cliAuth: { "cli:codex": { files: { "auth.json": Buffer.from(codexLogin).toString("base64") }, capturedAt: "2026-10-14T00:00:00.000Z", sourcePlatform: "linux" } }
    }, passphrase);
  }

  // Sealing and opening each run one 128 MiB scrypt (N=2^17), seconds on a busy host: seal once, and bound each opening case by that work.
  const scryptCaseTimeout = 30_000;
  let sealedText = "";
  beforeAll(async () => { sealedText = JSON.stringify(await sealBackup()); }, scryptCaseTimeout);
  const sealedBundle = async (): Promise<SpaceConfigBundle> => spaceConfigBundleSchema.parse(JSON.parse(sealedText));

  it("keeps every secret inside the encrypted blob and restores it with the passphrase", async () => {
    const bundle = await sealedBundle();
    const text = JSON.stringify(bundle);
    expect(text.replace(bundle.encrypted!.ciphertext, "")).not.toMatch(/sk-synthetic|rt-synthetic|cnQtc3ludGhldGlj/);
    expect(bundle.sections).toEqual({
      apiKeys: { included: true, encrypted: true, names: ["deepseek"] },
      cliAuth: { included: true, encrypted: true, runtimes: ["cli:codex"] }
    });
    expect(bundle.data.apiKeys).toBeUndefined();

    const secretsDir = await mkdtemp(join(tmpdir(), "space-sealed-keys-"));
    const applyCliAuth = vi.fn(async () => [{ runtimeId: "cli:codex", result: "imported" as const, detect: "logged-in" as const }]);
    const result = await new InMemorySpaceStore().importConfigurationBundle(spaceConfigBundleSchema.parse(JSON.parse(text)), {
      mode: "replace", confirmReplace: true, targetUserId: "user:target", passphrase, secretsDir
    }, { applyCliAuth });
    expect(result.stats.apiKeysImported).toBe(1);
    expect(await readFile(join(secretsDir, "deepseek.key"), "utf8")).toBe("sk-synthetic-deepseek-key\n");
    expect(applyCliAuth).toHaveBeenCalledWith({ "cli:codex": expect.objectContaining({ files: { "auth.json": Buffer.from(codexLogin).toString("base64") } }) });
    expect(result.cliAuth).toEqual([{ runtimeId: "cli:codex", result: "imported", detect: "logged-in" }]);
    expect(result.stats.credentialsImported).toBe(1);
  }, scryptCaseTimeout);

  it.each([
    ["a wrong passphrase", (bundle: SpaceConfigBundle) => bundle, "not the right passphrase"],
    ["a changed ciphertext", (bundle: SpaceConfigBundle) => {
      const sealed = Buffer.from(bundle.encrypted!.ciphertext, "base64");
      sealed[0] = sealed[0]! ^ 1;
      return { ...bundle, encrypted: { ...bundle.encrypted!, ciphertext: sealed.toString("base64") } };
    }, passphrase],
    ["a changed nonce", (bundle: SpaceConfigBundle) => ({ ...bundle, encrypted: { ...bundle.encrypted!, nonce: Buffer.alloc(12, 7).toString("base64") } }), passphrase],
    ["a changed AAD", (bundle: SpaceConfigBundle) => ({ ...bundle, encrypted: { ...bundle.encrypted!, aad: "spaceapp-configuration-bundle/1.0.0" } }), passphrase],
    ["a bundle version moved to another format", (bundle: SpaceConfigBundle) => ({ ...bundle, version: "1.0.0" as const }), passphrase]
  ])("refuses %s before writing anything", async (_label, change, attempt) => {
    const bundle = change(await sealedBundle());
    const target = new InMemorySpaceStore();
    const secretsDir = await mkdtemp(join(tmpdir(), "space-sealed-refused-"));
    const applyCliAuth = vi.fn();
    await expect(target.importConfigurationBundle(bundle, { mode: "replace", confirmReplace: true, targetUserId: "user:target", passphrase: attempt, secretsDir }, { applyCliAuth }))
      .rejects.toBeInstanceOf(ConfigSecretsError);
    expect(target.listRooms("user:target")).toEqual([]);
    expect(await readdir(secretsDir)).toEqual([]);
    expect(applyCliAuth).not.toHaveBeenCalled();
  }, scryptCaseTimeout);

  it("imports the rest of an encrypted backup without its secrets when no passphrase is given", async () => {
    const result = await new InMemorySpaceStore().importConfigurationBundle(await sealedBundle(), { mode: "replace", confirmReplace: true, targetUserId: "user:target" });
    expect(result.stats.roomsImported).toBe(1);
    expect(result.stats.apiKeysImported).toBe(0);
    expect(result.warnings).toContain("This backup's API keys and CLI logins are encrypted; enter its passphrase to restore them.");
  });

  it("drops host state and dangling references and fits paths to this host", async () => {
    const source = new InMemorySpaceStore();
    const userId = "user:operator";
    const room = await source.createRoom({ name: "Host Bound", initialPaneCount: 1 }, "trace-host", userId);
    const exported = await source.exportConfigurationBundle({ userId });
    const project = await mkdtemp(join(tmpdir(), "space-import-project-"));
    const [exportedRoom] = exported.data.rooms;
    const bundle = spaceConfigBundleSchema.parse({
      ...exported,
      data: {
        ...exported.data,
        rooms: [{ ...exportedRoom!, projectPath: "/missing-project-root", panes: exportedRoom!.panes.map((pane) => ({
          ...pane, status: "RUNNING", cwd: "/missing-project-root/var/worktrees/space/wt-gone"
        })) }],
        userSettings: {
          ...exported.data.userSettings,
          roomExtraEmptySlots: { [room.id]: 1, "room:gone": 2 },
          projectPresets: [{ label: "space1", path: "/missing-project-root/projects/space1" }],
          desktopWidgets: { "config:countdown-timer": { durationSeconds: 300, remainingSeconds: 12, isRunning: true, isCompleted: false } },
          mailCopilot: { runtimeId: "cli:claude", accountProfileId: "space-gateway", askOnLaunch: false }
        },
        clipboardItems: [{
          ...(await source.upsertClipboardItem({ ownerUserId: userId, text: "Running plan", source: "PLAN", title: "Plan", minimumModel: "gpt-5.6-sol" })),
          paneId: "pane:gone", roomId: "room:gone", executionStatus: "IN_PROGRESS", activeAgent: "codex@vm207"
        }],
        providers: [
          ...exported.data.providers,
          { id: "codex-lb", displayName: "Codex LB", type: "CODEX_LB", status: "VERIFIED", statusReason: null, healthCheckedAt: "2026-10-14T00:00:00.000Z",
            maskedKeyPrefix: "sk-…", baseUrl: "http://127.0.0.1:4920/v1", routeProfile: "custom", backingProviderId: null, credentialRef: null, isBuiltIn: false },
          { id: "proof-provider-x", displayName: "Proof", type: "CUSTOM", status: "VERIFIED", statusReason: null, healthCheckedAt: null,
            maskedKeyPrefix: null, baseUrl: "https://example.invalid/v1", routeProfile: "custom", backingProviderId: null, credentialRef: "/opt/spaceapp/secrets/missing-proof.key", isBuiltIn: false }
        ],
        providerSettings: { ...exported.data.providerSettings!, defaultProviderId: "codex-lb" }
      }
    });

    const target = new InMemorySpaceStore();
    const defaultBefore = target.getProviderSettings().defaultProviderId;
    const result = await target.importConfigurationBundle(bundle, { mode: "merge", targetUserId: userId });
    const [imported] = target.listRooms(userId);
    // No project folder here: the room reads as the house default, which public installs map to the room's own folder.
    expect(imported!.projectPath).toBe("/opt/spaceapp");
    expect(target.listPanes(imported!.id).map((pane) => [pane.status, pane.cwd, pane.taskMetadata ?? null])).toEqual([["IDLE", null, null]]);
    const settings = target.getUserSettings(userId);
    expect(settings.roomExtraEmptySlots).toEqual({ [imported!.id]: 1 });
    expect(settings.desktopWidgets?.["config:countdown-timer"]).toMatchObject({ isRunning: false, remainingSeconds: 300 });
    expect(settings.mailCopilot?.accountProfileId).toBeNull();
    const [plan] = target.listClipboardItems(userId, { page: 1, pageSize: 10 }).items;
    expect(plan).toMatchObject({ executionStatus: "PLANNED", activeAgent: null, paneId: null, roomId: null });
    expect(target.listProviders().find((provider) => provider.id === "proof-provider-x")).toBeUndefined();
    expect(target.listProviders().find((provider) => provider.id === "codex-lb")).toMatchObject({ status: "DISABLED", healthCheckedAt: null });
    expect(target.getProviderSettings().defaultProviderId).toBe(defaultBefore);
    expect(result.warnings.join("\n")).toMatch(/\/missing-project-root does not exist/);
    expect(result.warnings.join("\n")).toMatch(/Codex LB points to http:\/\/127\.0\.0\.1:4920/);
    expect(result.warnings.join("\n")).toMatch(/Mail Copilot used account profile space-gateway/);

    const mapped = new InMemorySpaceStore();
    await mapped.importConfigurationBundle(bundle, { mode: "replace", confirmReplace: true, targetUserId: userId, pathRewrite: { from: "/missing-project-root", to: project } });
    expect(mapped.listRooms(userId)[0]!.projectPath).toBe(project);
    expect(mapped.getUserSettings(userId).projectPresets).toEqual([{ label: "space1", path: `${project}/projects/space1` }]);
  });

  it("imports a backup from a newer SpaceApp, skipping only the settings and entries this version does not know", async () => {
    const source = new InMemorySpaceStore();
    const userId = "user:operator";
    await source.updateUserSettings(userId, { uiTheme: "motion", roomTheme: "steel" });
    await source.createRoom({ name: "Newer", initialPaneCount: 2 }, "trace-newer", userId);
    const exported = JSON.parse(JSON.stringify(await source.exportConfigurationBundle({ userId })));
    // What a newer version could write: a theme, a pane type and a plan status this version has never heard of.
    exported.data.userSettings.uiTheme = "theme-from-a-future-version";
    exported.data.rooms[0].panes[1].mode = "FUTURE_COPILOT";
    exported.data.clipboardItems = [{ ...JSON.parse(JSON.stringify(await source.upsertClipboardItem({
      ownerUserId: userId, text: "A plan", source: "PLAN", title: "Plan", minimumModel: "gpt-5.6-sol"
    }))), executionStatus: "SOMETHING_NEW" }];
    expect(spaceConfigBundleSchema.safeParse(exported).success).toBe(false);

    const parsed = parseConfigBundleLeniently(exported);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.skipped).toEqual(expect.arrayContaining(["setting uiTheme", "1 pane entry", "1 clipboardItems entry"]));
    expect(parsed.bundle.data.userSettings?.roomTheme).toBe("steel");
    expect(parsed.bundle.data.rooms[0]!.panes).toHaveLength(1);
    expect(exported.data.rooms[0].panes).toHaveLength(2);

    const target = new InMemorySpaceStore();
    const result = await target.importConfigurationBundle(parsed.bundle, { mode: "replace", confirmReplace: true, targetUserId: userId });
    expect(result.stats).toMatchObject({ roomsImported: 1, panesImported: 1, settingsUpdated: true });

    // A file whose structure is wrong still fails.
    expect(parseConfigBundleLeniently({ ...exported, format: "something-else" }).success).toBe(false);
    expect(parseConfigBundleLeniently({ ...exported, data: { ...exported.data, rooms: "not a list" } }).success).toBe(false);
  });

  it("merges by default, honours sections, and replaces only on a confirmed Replace of the imported sections (Record Retention Invariant)", async () => {
    const userId = "user:operator";
    const source = new InMemorySpaceStore();
    await source.createRoom({ name: "From backup", initialPaneCount: 1 }, "trace-src", userId);
    await source.createUserLink({ ownerUserId: userId, title: "Backup link", url: "https://example.com/b", openMode: "NEW_TAB", category: "GENERAL", isQuick: true });
    const bundle = await source.exportConfigurationBundle({ userId });

    const target = new InMemorySpaceStore();
    await target.createRoom({ name: "Mine", initialPaneCount: 1 }, "trace-tgt", userId);
    await target.upsertClipboardItem({ ownerUserId: userId, text: "My plan", source: "PLAN", title: "My plan", minimumModel: "gpt-5.6-sol" });
    await target.updateUserSettings(userId, { uiTheme: "classic", designColorPresets: [{ name: "Mine", background: "#000000", primary: "#111111", accent: "#222222", text: "#FFFFFF" }] });
    const names = () => target.listRooms(userId).map((room) => room.name).sort();
    const plans = () => target.listClipboardItems(userId, { page: 1, pageSize: 10 }).items.map((item) => item.text);

    // No mode: an additive merge keeps every room, plan and setting the bundle does not name.
    await target.importConfigurationBundle(bundle, { targetUserId: userId });
    expect(names()).toEqual(["From backup", "Mine"]);
    expect(plans()).toContain("My plan");
    expect(target.getUserSettings(userId).designColorPresets).toHaveLength(1);

    // Replace needs the confirmation, and then clears only the sections it imports.
    await expect(target.importConfigurationBundle(bundle, { mode: "replace", targetUserId: userId })).rejects.toThrow(/confirm Replace/);
    await target.importConfigurationBundle(bundle, { mode: "replace", confirmReplace: true, targetUserId: userId, sections: ["userLinks"] });
    expect(names()).toEqual(["From backup", "Mine"]);
    expect(plans()).toContain("My plan");
    expect(target.listUserLinks(userId, { isQuick: undefined, page: 1, pageSize: 50 }).items.map((link) => link.title)).toContain("Backup link");
  });
});
