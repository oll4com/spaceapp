import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sourceControlProviderSchema, type GitRemoteRepository, type SourceControlProvider } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";
import { PluginsService } from "../src/plugins-service.js";
import { SourceControlPublishingManager, type SourceControlBroker } from "../src/source-control-publishing.js";

let root: string;
let project: string;
let repository: InMemorySourceControlRepository;
let credentials: DemoCredentialStore;
let service: SourceControlService;
let valid: boolean;
const remote = (server: string): GitRemoteRepository => ({
  id: "stable-42", fullName: "fixture/repository", cloneUrl: `${server}/fixture/repository.git`, webUrl: `${server}/fixture/repository`,
  private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true }
});
const makeService = () => new SourceControlService({
  repository, credentials, credentialRoot: join(root, "credentials"),
  providerFactory: (_provider, server) => ({
    identity: async () => { if (!valid) throw new Error("expired fixture"); return { login: "fixture-account", email: null }; },
    repositories: async () => [remote(server)], repository: async () => remote(server),
    create: async () => remote(server), validateCloneUrl: async url => url
  })
});
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures");
  await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "regressions-"));
  project = join(root, "project"); await mkdir(project);
  repository = new InMemorySourceControlRepository(); credentials = new DemoCredentialStore(join(root, "credentials"));
  valid = true; service = makeService();
});
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

describe("phase two repository state regressions", () => {
  it.each(["github", "gitea"] as const)("retains %s binding identity, default and credentials through the account lifecycle", async provider => {
    const input = { token: "initial-fixture", serverUrl: "https://custom-forge.example.test" };
    await service.connect("user:a", provider, input);
    await service.setProjectDefault("user:a", project, provider, "fixture/repository");
    const binding = await service.bind("user:a", project, provider);
    const initial = (await repository.getConnection("user:a", provider))!;
    const encryptedFiles = await readdir(join(root, "credentials", "credentials"));
    expect(encryptedFiles).toHaveLength(1);
    expect(await readFile(join(root, "credentials", "credentials", encryptedFiles[0]!), "utf8")).not.toContain(input.token);

    await service.setEnabled("user:a", provider, false);
    expect(await repository.getConnection("user:a", provider)).toEqual({ ...initial, enabled: false });
    expect(await service.binding("user:a", binding.id)).toEqual(binding);
    expect((await service.getProjectDefaults("user:a", project)).defaults[provider]).toMatchObject({ active: false, isDefault: true, fullName: binding.repository!.fullName });
    await expect(service.repositories("user:a", provider, 1)).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(await credentials.read(initial.credentialRef!)).toEqual({ token: input.token });

    service = makeService(); // Same persistence and encrypted store after a service restart.
    await service.setEnabled("user:a", provider, true);
    expect((await repository.getConnection("user:a", provider))?.credentialRef).toBe(initial.credentialRef);
    expect((await service.bind("user:a", project, provider)).id).toBe(binding.id);
    expect((await service.getProjectDefaults("user:a", project)).defaults[provider].active).toBe(true);

    valid = false;
    expect((await service.test("user:a", provider)).ok).toBe(false);
    expect(await repository.getConnection("user:a", provider)).toMatchObject({ enabled: true, status: "ERROR", credentialRef: initial.credentialRef });
    expect(await service.binding("user:a", binding.id)).toEqual(binding);
    await expect(service.repositories("user:a", provider, 1)).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await expect(service.connect("user:a", provider, input)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect((await repository.getConnection("user:a", provider))?.credentialRef).toBe(initial.credentialRef);

    valid = true;
    await service.connect("user:a", provider, { ...input, token: "replacement-fixture" });
    const replacement = (await repository.getConnection("user:a", provider))!;
    expect(replacement.credentialRef).not.toBe(initial.credentialRef);
    expect(await credentials.read(replacement.credentialRef!)).toEqual({ token: "replacement-fixture" });
    await expect(credentials.read(initial.credentialRef!)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.bind("user:a", project, provider)).id).toBe(binding.id);

    await service.disconnect("user:a", provider);
    expect(await repository.getConnection("user:a", provider)).toMatchObject({ enabled: true, status: "NOT_CONNECTED", credentialRef: null, serverUrl: initial.serverUrl });
    await expect(credentials.read(replacement.credentialRef!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.binding("user:a", binding.id)).toEqual(binding);
    expect((await service.getProjectDefaults("user:a", project)).defaults[provider]).toMatchObject({ active: false, isDefault: true });
    expect(await service.bindings("user:b")).toEqual([]);

    await service.connect("user:a", provider, input);
    expect(await service.bind("user:a", project, provider)).toEqual(binding);
    expect((await service.getProjectDefaults("user:a", project)).defaults[provider]).toMatchObject({ active: true, isDefault: true });
  });

  it("reads a pre-migration personal connection and binding without replacing credentials or IDs", async () => {
    await credentials.initialize();
    const credentialRef = "personal_git_legacy_fixture";
    await credentials.write(credentialRef, { token: "legacy-fixture" });
    const legacy = { ownerUserId: "user:a", provider: "github" as const, serverUrl: "https://github.com", credentialRef,
      status: "CONNECTED" as const, accountLogin: "legacy-account", connectedAt: "2026-10-01T00:00:00.000Z", checkedAt: null, error: null };
    await repository.saveConnection(legacy);
    const binding = { id: "binding:legacy-default", ownerUserId: "user:a", projectPath: project, provider: "github" as const,
      serverUrl: legacy.serverUrl, repository: remote(legacy.serverUrl), isDefault: true };
    await repository.saveBinding(binding);
    expect((await service.connections("user:a"))[0]).toMatchObject({ provider: "github", enabled: true, status: "CONNECTED", accountLogin: "legacy-account" });
    expect(await service.binding("user:a", binding.id)).toEqual({ ...binding, kind: "provider" });
    expect((await service.bind("user:a", project, "github")).id).toBe(binding.id);
    expect(await service.repositories("user:a", "github", 1)).toEqual([remote(legacy.serverUrl)]);
    expect(await repository.getConnection("user:a", "github")).toEqual(legacy);
    expect(await credentials.read(credentialRef)).toEqual({ token: "legacy-fixture" });
  });

  it("keeps personal enablement independent of persisted pane MCP overrides in both directions", async () => {
    const plugins = new PluginsService(join(root, "plugins"), false);
    const config = { paneId: "pane:owned-fixture", enabledPluginIds: ["gitlab"], disabledPluginIds: ["github", "gitea"] };
    await plugins.setAgentConfig(config);
    expect((await service.providers("user:a")).filter(p => p.enabled).map(p => p.id)).toEqual(["github", "gitea"]);
    await service.setEnabled("user:a", "github", false);
    await service.setEnabled("user:a", "forgejo", true);
    expect(await plugins.getAgentConfig(config.paneId)).toEqual(config);
    const reloadedPlugins = new PluginsService(join(root, "plugins"), false);
    expect(await reloadedPlugins.getAgentConfig(config.paneId)).toEqual(config);
    expect((await makeService().providers("user:a")).filter(p => p.enabled).map(p => p.id)).toEqual(["gitea", "forgejo"]);
  });

  it("never modifies installation publishing credentials when changing personal providers", async () => {
    const store = new InMemorySpaceStore();
    await store.upsertSourceControlConnection({ provider: "github", accountLogin: "admin-fixture", connectionStatus: "CONNECTED",
      secretRef: "source_control_github_fixture_12345678", lastVerifiedAt: "2026-10-01T00:00:00.000Z", lastVerificationCode: "VERIFIED" });
    const before = await store.getSourceControlConnection("github");
    const broker: SourceControlBroker = { replace: vi.fn(), verify: vi.fn(), remove: vi.fn(), importExisting: vi.fn() };
    const publishing = new SourceControlPublishingManager({ store, broker });
    await service.connect("user:a", "github", { token: "personal-fixture" });
    await service.setEnabled("user:a", "github", false);
    await service.setEnabled("user:a", "gitlab", true);
    await service.disconnect("user:a", "github");
    expect(await store.getSourceControlConnection("github")).toEqual(before);
    expect(sourceControlProviderSchema.options).toEqual(["gitea", "github"]);
    for (const provider of ["forgejo", "gitlab", "bitbucket", "azure-devops"] as const) {
      await expect(publishing.replace(provider as SourceControlProvider, "fixture-token-123456789012345678901234567890")).rejects.toThrow();
    }
    expect(broker.replace).not.toHaveBeenCalled();
    expect(broker.remove).not.toHaveBeenCalled();
  });
});
