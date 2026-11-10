import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:http";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";
import { ApiGitProvider, ProviderUrlPolicy, type GitProviderClient } from "../src/source-control/providers.js";

let root: string;
let repository: InMemorySourceControlRepository;
let service: SourceControlService;
let valid = true;
const scratch = join(tmpdir(), "20261003-personal-source-control");
beforeEach(async () => {
  await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "service-"));
  repository = new InMemorySourceControlRepository(); valid = true;
  const fake = (_provider: string, _url: string, token: string): GitProviderClient => ({
    identity: async () => { if (token !== "test-token" || !valid) throw new Error("Token is invalid or expired."); return { login: "proof-account", email: null }; },
    repositories: async () => [], repository: async () => { throw new Error("unavailable"); }, create: async () => { throw new Error("unavailable"); }, validateCloneUrl: async url => url
  });
  service = new SourceControlService({ repository, credentials: new DemoCredentialStore(join(root, "secrets")), providerFactory: fake, credentialRoot: join(root, "secrets") });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("personal source control connections", () => {
  it("requires verified identity, isolates users and encrypts credentials", async () => {
    await expect(service.connect("user:a", "github", { token: "bad" })).rejects.toThrow();
    expect((await service.connections("user:a"))[0]?.status).toBe("NOT_CONNECTED");
    const result = await service.connect("user:a", "github", { token: "test-token" });
    expect(result.accountLogin).toBe("proof-account");
    expect(JSON.stringify(result)).not.toContain("test-token");
    expect((await service.connections("user:b"))[0]?.status).toBe("NOT_CONNECTED");
    const paths = await readdir(join(root, "secrets", "credentials"));
    expect(await readFile(join(root, "secrets", "credentials", paths[0]!), "utf8")).not.toContain("test-token");
    await service.disconnect("user:b", "github");
    expect((await service.connections("user:a"))[0]?.status).toBe("CONNECTED");
  });
  it("detects expiry on a real provider probe and reconnects", async () => {
    await service.connect("user:a", "github", { token: "test-token" }); valid = false;
    expect((await service.test("user:a", "github")).ok).toBe(false);
    expect((await service.connections("user:a"))[0]?.status).toBe("ERROR");
    valid = true; await service.connect("user:a", "github", { token: "test-token" });
    await service.disconnect("user:a", "github");
    expect((await service.connections("user:a"))[0]?.status).toBe("NOT_CONNECTED");
  });
  it("never returns another user's binding", async () => {
    await repository.saveBinding({ id: "binding:proof", ownerUserId: "user:a", projectPath: root, provider: "github", serverUrl: "https://github.com", repository: null });
    await expect(service.binding("user:b", "binding:proof")).rejects.toThrow(/not found/i);
  });
  it.each(["http.https://github.com/.proxy", "http.https://github.com/.followRedirects", "filter.private.clean"])("refuses credential-bearing Git with unsafe repository config %s", async key => {
    const project = join(root, "project"); await mkdir(project);
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", key, "unsafe-test-value"], { cwd: project });
    const remote = { id: "1", fullName: "proof/repo", name: "repo", owner: "proof", cloneUrl: "https://github.com/proof/repo.git", webUrl: "https://github.com/proof/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } };
    const guarded = new SourceControlService({ repository, credentials: new DemoCredentialStore(join(root, "guarded-secrets")), credentialRoot: join(root, "guarded-secrets"),
      providerFactory: () => ({ identity: async () => ({ login: "proof", email: null }), repositories: async () => [remote], repository: async () => remote, create: async () => remote, validateCloneUrl: async url => url }) });
    await guarded.connect("user:a", "github", { token: "proof-token" });
    const binding = await guarded.bind("user:a", project, "github", remote.fullName);
    const status = await guarded.status("user:a", binding.id);
    await expect(guarded.operate("user:a", "fetch", { bindingId: binding.id, expectedVersion: status.version, paths: [], confirmed: false, private: true }, { name: "Proof", email: "proof@example.invalid" })).rejects.toThrow(/configuration/i);
    expect(execFileSync("git", ["remote"], { cwd: project, encoding: "utf8" }).trim()).toBe("");
  });
  it("supports optional default repositories per project and provider with manual fallback", async () => {
    const project = join(root, "project-defaults"); await mkdir(project);
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    const repo1 = { id: "101", fullName: "spaceapp.example/spaceapp", name: "space", owner: "oll4com", cloneUrl: "https://github.com/spaceapp.example/spaceapp.git", webUrl: "https://github.com/spaceapp.example/spaceapp", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } };
    const repo2 = { id: "102", fullName: "oll4com/spaceapp", name: "spaceapp", owner: "oll4com", cloneUrl: "https://github.com/oll4com/spaceapp.git", webUrl: "https://github.com/oll4com/spaceapp", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } };
    const svc = new SourceControlService({
      repository,
      credentials: new DemoCredentialStore(join(root, "def-secrets")),
      credentialRoot: join(root, "def-secrets"),
      providerFactory: () => ({
        identity: async () => ({ login: "oll4com", email: null }),
        repositories: async () => [repo1, repo2],
        repository: async name => name === "spaceapp.example/spaceapp" ? repo1 : repo2,
        create: async () => repo1,
        validateCloneUrl: async url => url
      })
    });
    await svc.connect("user:a", "github", { token: "proof-token" });

    // Step 1: Initial bind without fullName and without default -> returns null repository (manual mode)
    const initialBinding = await svc.bind("user:a", project, "github");
    expect(initialBinding.repository).toBeNull();

    // Step 2: Defaults query reports active plugin but no default configured
    const defs1 = await svc.getProjectDefaults("user:a", project);
    expect(defs1.defaults.github.active).toBe(true);
    expect(defs1.defaults.github.isDefault).toBe(false);
    expect(defs1.defaults.github.fullName).toBeNull();
    expect(defs1.defaults.gitea.active).toBe(false);

    // Step 3: Set default repository for github
    const setRes = await svc.setProjectDefault("user:a", project, "github", "oll4com/spaceapp");
    expect(setRes.ok).toBe(true);
    expect(setRes.isDefault).toBe(true);
    expect(setRes.repository?.fullName).toBe("oll4com/spaceapp");

    // Step 4: Now bind without fullName -> auto-selects default repo!
    const autoBinding = await svc.bind("user:a", project, "github");
    expect(autoBinding.repository?.fullName).toBe("oll4com/spaceapp");
    expect(autoBinding.isDefault).toBe(true);

    // Step 5: Defaults query reflects default repo
    const defs2 = await svc.getProjectDefaults("user:a", project);
    expect(defs2.defaults.github.isDefault).toBe(true);
    expect(defs2.defaults.github.fullName).toBe("oll4com/spaceapp");

    // Step 6: Clear default repo (switch back to manual mode)
    const clearRes = await svc.setProjectDefault("user:a", project, "github", null);
    expect(clearRes.ok).toBe(true);
    expect(clearRes.isDefault).toBe(false);

    const clearedBinding = await svc.bind("user:a", project, "github");
    expect(clearedBinding.repository).toBeNull();
  });
});
describe("provider destination policy", () => {
  it("uses the validated pinned address when Node enables automatic address family selection", async () => {
    const previous = getDefaultAutoSelectFamily();
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer proof-token");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ login: "proof-account" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned provider fixture did not start.");
    class PinnedProofPolicy extends ProviderUrlPolicy {
      override async address() { return { address: "127.0.0.1", family: 4 }; }
    }
    try {
      setDefaultAutoSelectFamily(true);
      const policy = new PinnedProofPolicy();
      await expect(policy.request(new URL(`http://provider-proof.invalid:${address.port}/user`), "proof-token", "GET"))
        .resolves.toEqual({ login: "proof-account" });
    } finally {
      setDefaultAutoSelectFamily(previous);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it("blocks private providers and HTTP unless installation explicitly allows their origin", async () => {
    const policy = new ProviderUrlPolicy();
    expect(() => policy.normalize("http://127.0.0.1")).toThrow();
    await expect(policy.address(new URL("https://127.0.0.1"))).rejects.toThrow(/allowlist/i);
    expect(() => policy.normalize("https://secret@example.com")).toThrow();
    const allowed = new ProviderUrlPolicy(["http://127.0.0.1:3000"]);
    expect(allowed.normalize("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    await expect(allowed.address(new URL("http://127.0.0.1:3000"))).resolves.toMatchObject({ address: "127.0.0.1" });
  });
  it("maps actual capabilities and uses provider pagination", async () => {
    const urls: string[] = [];
    const client = new ApiGitProvider("github", "https://github.com", "token", new ProviderUrlPolicy(), async url => {
      urls.push(url.toString()); return [{ id: 1, full_name: "user/repo", clone_url: "https://github.com/user/repo.git", permissions: { pull: true, push: false } }];
    });
    expect((await client.repositories(2))[0]?.permissions).toEqual({ pull: true, push: false, admin: false });
    expect(urls[0]).toContain("page=2&per_page=50");
    await expect(client.validateCloneUrl("https://other.example/repo.git")).rejects.toThrow(/match/i);
  });
});
