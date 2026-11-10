import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";

let root: string;
let repository: InMemorySourceControlRepository;
let service: SourceControlService;
const identity = vi.fn(async () => ({ login: "test-account", email: null }));
const options = () => ({ repository, credentials: new DemoCredentialStore(join(root, "credentials")), credentialRoot: join(root, "credentials"),
  providerFactory: () => ({ identity, repositories: async () => [], repository: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); }, validateCloneUrl: async (url: string) => url }) });
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures");
  await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "foundation-"));
  repository = new InMemorySourceControlRepository(); service = new SourceControlService(options()); identity.mockClear();
});
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

describe("repository provider foundation", () => {
  it("exposes all descriptors but keeps the existing connection API limited to implemented providers", async () => {
    const providers = await service.providers("user:a");
    expect(providers.map(p => p.id)).toEqual(["github", "gitea", "forgejo", "gitlab", "bitbucket", "azure-devops"]);
    expect(providers.filter(p => p.enabled).map(p => p.id)).toEqual(["github", "gitea"]);
    expect(providers.find(p => p.id === "gitlab")).toMatchObject({ available: true, enabled: false, connection: { status: "NOT_CONNECTED" } });
    expect((await service.connections("user:a")).map(c => c.provider)).toEqual(["github", "gitea"]);
    expect(identity).not.toHaveBeenCalled();
  });

  it("persists enablement separately from credentials, health, owners and service restarts", async () => {
    await service.connect("user:a", "github", { token: "fixture-token" });
    const before = await repository.getConnection("user:a", "github");
    await service.setEnabled("user:a", "github", false);
    const after = await repository.getConnection("user:a", "github");
    expect(after).toMatchObject({ enabled: false, status: "CONNECTED", credentialRef: before!.credentialRef });
    await expect(service.repositories("user:a", "github", 1)).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    const restarted = new SourceControlService(options());
    expect((await restarted.providers("user:a"))[0]).toMatchObject({ enabled: false, connection: { status: "CONNECTED" } });
    expect((await restarted.providers("user:b"))[0]).toMatchObject({ enabled: true, connection: { status: "NOT_CONNECTED" } });
    expect(JSON.stringify(await restarted.providers("user:a"))).not.toContain("fixture-token");
    expect(JSON.stringify(await restarted.providers("user:a"))).not.toContain(before!.credentialRef!);
    await restarted.setEnabled("user:a", "github", true);
    expect(await restarted.repositories("user:a", "github", 1)).toEqual([]);
  });

  it("preserves disabled state through reconnect, health check and disconnect", async () => {
    await service.setEnabled("user:a", "github", false);
    await service.connect("user:a", "github", { token: "fixture-token" });
    expect((await service.test("user:a", "github")).ok).toBe(true);
    expect((await service.providers("user:a"))[0].enabled).toBe(false);
    await service.disconnect("user:a", "github");
    expect((await service.providers("user:a"))[0]).toMatchObject({ enabled: false, connection: { status: "NOT_CONNECTED" } });
    expect((await repository.getConnection("user:a", "github"))?.credentialRef).toBeNull();
  });

  it("normalizes legacy bindings and keeps local status accessible after disable/disconnect", async () => {
    await service.connect("user:a", "gitea", { token: "fixture-token", serverUrl: "https://forge.example.test" });
    const binding = await service.bind("user:a", root, "gitea");
    await service.setEnabled("user:a", "gitea", false);
    await service.disconnect("user:a", "gitea");
    expect(await service.binding("user:a", binding.id)).toMatchObject({ id: binding.id, kind: "provider", serverUrl: "https://forge.example.test" });
    expect((await service.status("user:a", binding.id)).initialized).toBe(false);
  });

  it("connects newly available providers personally without expanding the legacy connection response", async () => {
    await service.setEnabled("user:a", "gitlab", true);
    await expect(service.connect("user:a", "gitlab", { token: "fixture-token" })).resolves.toMatchObject({ provider: "gitlab", serverUrl: "https://gitlab.com", status: "CONNECTED" });
    expect(identity).toHaveBeenCalledOnce();
    expect((await service.providers("user:a")).find(p => p.id === "gitlab")).toMatchObject({ enabled: true, available: true, connection: { status: "CONNECTED" } });
    expect((await service.connections("user:a")).map(c => c.provider)).toEqual(["github", "gitea"]);
  });
});

describe("local work and queued provider settings", () => {
  it("initializes, stages, diffs and commits after disconnect without accessing provider credentials", async () => {
    await service.connect("user:a", "github", { token: "fixture-token" });
    const binding = await service.bind("user:a", root, "github");
    await service.setEnabled("user:a", "github", false);
    await service.disconnect("user:a", "github");
    identity.mockClear();
    const author = { name: "Fixture", email: "fixture@example.invalid" };
    const operate = async (operation: "initialize" | "stage" | "commit", paths: string[] = []) => service.operate("user:a", operation, {
      bindingId: binding.id, expectedVersion: (await service.status("user:a", binding.id)).version, paths, message: "Local fixture", confirmed: false, private: true
    }, author);
    await operate("initialize");
    await writeFile(join(root, "tracked.txt"), "local work\n");
    await operate("stage", ["tracked.txt"]);
    expect((await service.diff("user:a", binding.id, "tracked.txt", true)).text).toContain("local work");
    expect((await operate("commit")).committed).toBe(true);
    await expect(service.operate("user:a", "push", {
      bindingId: binding.id, expectedVersion: (await service.status("user:a", binding.id)).version, paths: [], confirmed: false, private: true
    }, author)).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(identity).not.toHaveBeenCalled();
  });
  it("serializes enablement with reconnect without losing the credential reference or opt-out", async () => {
    await Promise.all([
      service.connect("user:a", "github", { token: "fixture-token" }),
      service.setEnabled("user:a", "github", false),
      service.connect("user:a", "github", { token: "replacement-fixture" })
    ]);
    expect(await repository.getConnection("user:a", "github")).toMatchObject({ enabled: false, status: "CONNECTED", credentialRef: expect.any(String) });
  });
});
