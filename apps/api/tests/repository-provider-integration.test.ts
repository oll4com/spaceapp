import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryProviderId } from "@space/contracts";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";
let root: string, repository: InMemorySourceControlRepository, service: SourceControlService;
let dispatched: Array<{ provider: string; server: string; email?: string }>;
const remote = { id: "91", fullName: "group/nested/repo", cloneUrl: "https://gitlab.com/group/nested/repo.git", webUrl: "https://gitlab.com/group/nested/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: false, admin: false } };
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures"); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "integration-"));
  repository = new InMemorySourceControlRepository(); dispatched = [];
  service = new SourceControlService({ repository, credentials: new DemoCredentialStore(join(root, "credentials")), credentialRoot: join(root, "credentials"), providerFactory: (provider, server, _token, credentials) => {
    dispatched.push({ provider, server, email: credentials?.email });
    return { identity: async () => ({ login: "account", email: null }), repositories: async () => [], repository: async () => remote, create: async () => remote, validateCloneUrl: async url => url,
      lookup: async id => { expect(id).toBe("91"); return remote; }, list: async input => { expect(input.query).toBe("nested"); return { data: [remote], nextPage: null, nextCursor: null }; },
      targets: async input => ({ data: [{ id: "17", provider: input.provider, name: "group/nested", kind: "namespace" as const, canCreateRepository: true }], nextPage: null, nextCursor: null }), createRepository: async () => remote };
  } });
});
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
describe("six personal provider integration", () => {
  it.each(["forgejo", "gitlab", "bitbucket", "azure-devops"] as RepositoryProviderId[])("connects %s only through personal adapter while retaining disabled default", async provider => {
    const credentials = { token: "fixture-token", email: "person@example.invalid", serverUrl: provider === "forgejo" ? "https://forge.example.test" : provider === "azure-devops" ? "https://dev.azure.com/owned" : "https://gitlab.com", organization: "https://dev.azure.com/owned" };
    const result = await service.connect("user:a", provider, credentials);
    expect(result).toMatchObject({ provider, enabled: false, status: "CONNECTED" });
    expect(dispatched[0]?.provider).toBe(provider);
    expect((await service.providers("user:a")).find(p => p.id === provider)).toMatchObject({ available: true, enabled: false });
    expect((await service.connections("user:a")).map(c => c.provider)).toEqual(["github", "gitea"]);
    if (provider === "bitbucket") { expect(dispatched[0]?.email).toBe("person@example.invalid"); await service.test("user:a", provider); expect(dispatched.at(-1)?.email).toBe("person@example.invalid"); }
    const paths = await readdir(join(root, "credentials", "credentials")); for (const path of paths) expect(await readFile(join(root, "credentials", "credentials", path), "utf8")).not.toContain("fixture-token");
    expect((await service.providers("user:b")).find(p => p.id === provider)?.connection.accountLogin).toBeNull();
  });
  it("lists nested namespaces, binds a stable ID, and keeps disabled/disconnected local bindings usable", async () => {
    await service.connect("user:a", "gitlab", { token: "fixture-token" });
    await expect(service.listRepositories("user:a", { provider: "gitlab", query: "nested" })).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    await service.setEnabled("user:a", "gitlab", true);
    expect((await service.listRepositories("user:a", { provider: "gitlab", query: "nested" })).data[0]?.id).toBe("91");
    expect((await service.targets("user:a", { provider: "gitlab" })).data[0]?.name).toBe("group/nested");
    const binding = await service.bindRepository("user:a", root, "gitlab", "91");
    expect(binding.repository?.fullName).toBe("group/nested/repo");
    await service.setEnabled("user:a", "gitlab", false); await service.disconnect("user:a", "gitlab");
    expect((await service.status("user:a", binding.id)).initialized).toBe(false);
    await expect(service.binding("user:b", binding.id)).rejects.toMatchObject({ code: "BINDING_NOT_FOUND" });
  });
  it("validates required Atlassian email and Azure organization before credential persistence", async () => {
    await expect(service.connect("user:a", "bitbucket", { token: "fixture-token" })).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
    await expect(service.connect("user:a", "azure-devops", { token: "fixture-token", organization: "https://evil.invalid/owned" })).rejects.toMatchObject({ code: "INVALID_SERVER" });
    expect(await repository.getConnection("user:a", "bitbucket")).toBeNull(); expect(dispatched).toHaveLength(0);
  });
});
