import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryProviderId } from "@space/contracts";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";
import { ProjectSourceOpener } from "../src/source-control/project-sources.js";

// Real API proof against an OWNED, disposable Gitea/Forgejo instance. Skipped unless pointed at one:
//   SPACE_REAL_FORGE_PROVIDER=gitea|forgejo  SPACE_REAL_FORGE_URL=http://127.0.0.1:PORT
//   SPACE_REAL_FORGE_TOKEN_FILE=<0600 file with a non-admin token>
// Expected seed: user "fixture"; org "team-write" owned by fixture; org "team-read" where fixture is only
// in a read team with repo "readonly-repo"; fixture repos "seeded" (initialized) and page-001..page-052.
// The suite creates uniquely named repositories, so never point it at a shared or production account.
const provider = process.env.SPACE_REAL_FORGE_PROVIDER as RepositoryProviderId | undefined;
const server = process.env.SPACE_REAL_FORGE_URL;
const tokenFile = process.env.SPACE_REAL_FORGE_TOKEN_FILE;
const enabled = Boolean((provider === "gitea" || provider === "forgejo") && server && tokenFile);
const owner = "user:real-forge";
const author = { name: "Fixture", email: "fixture@example.invalid" };
let root: string, token: string, svc: SourceControlService;
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${server}/api/v1${path}`, { method: init.method ?? "GET", headers: { authorization: `token ${token}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: response.status, data: response.status === 204 ? null : await response.json().catch(() => null) };
}
async function project(name: string, commit = false) {
  const path = join(root, name); await mkdir(path);
  if (commit) { run(path, "init", "-b", "main"); run(path, "config", "user.name", "Fixture"); run(path, "config", "user.email", "fixture@example.invalid"); await writeFile(join(path, "README.md"), `# ${name}\n`); run(path, "add", "README.md"); run(path, "commit", "-m", "Initial commit"); }
  return path;
}
async function allRepositories() {
  const seen = []; let cursor: string | undefined; let pages = 0;
  do { const page = await svc.listRepositories(owner, { provider: provider!, ...(cursor ? { cursor } : { page: 1 }) }); seen.push(...page.data); cursor = page.nextCursor ?? undefined; pages++; } while (cursor && pages < 20);
  return { repositories: seen, pages };
}

describe.skipIf(!enabled)(`real ${provider ?? "forge"} provider`, { timeout: 240000 }, () => {
  beforeAll(async () => {
    token = (await readFile(tokenFile!, "utf8")).trim();
    const scratch = "/var/lib/spaceapp-user/agent-workspace/reports/repository-provider-test-fixtures"; await mkdir(scratch, { recursive: true });
    root = await mkdtemp(join(scratch, `real-${provider}-`));
    svc = new SourceControlService({ repository: new InMemorySourceControlRepository(), credentials: new DemoCredentialStore(join(root, "credentials")), credentialRoot: join(root, "credentials"), privateOrigins: [new URL(server!).origin] });
  });
  afterAll(async () => { await svc?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it("rejects an invalid token, then connects the real account and enforces personal enablement", async () => {
    await expect(svc.connect(owner, provider!, { token: "invalid-fixture-token", serverUrl: server! })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    const connection = await svc.connect(owner, provider!, { token, serverUrl: server! });
    expect(connection).toMatchObject({ provider, status: "CONNECTED", accountLogin: "fixture" });
    await svc.setEnabled(owner, provider!, false);
    await expect(svc.targets(owner, { provider: provider! })).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    await svc.setEnabled(owner, provider!, true);
    expect(await svc.test(owner, provider!)).toMatchObject({ ok: true });
    // A failed reconnect must not replace the working credential.
    await expect(svc.connect(owner, provider!, { token: "invalid-fixture-token", serverUrl: server! })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect((await svc.providers(owner)).find(p => p.id === provider)?.connection).toMatchObject({ status: "CONNECTED", accountLogin: "fixture" });
  });

  it("discovers real targets with actual organization create permission", async () => {
    const targets = (await svc.targets(owner, { provider: provider! })).data;
    expect(targets.find(t => t.kind === "user")).toMatchObject({ name: "fixture", canCreateRepository: true });
    expect(targets.find(t => t.name === "team-write")).toMatchObject({ kind: "organization", canCreateRepository: true });
    expect(targets.find(t => t.name === "team-read")).toMatchObject({ kind: "organization", canCreateRepository: false });
  });

  it("paginates every accessible repository with stable numeric IDs and real permissions", async () => {
    const { repositories, pages } = await allRepositories();
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(new Set(repositories.map(r => r.id)).size).toBe(repositories.length);
    expect(repositories.every(r => /^[1-9][0-9]*$/.test(r.id) && r.cloneUrl.startsWith(`${server}/`))).toBe(true);
    for (let i = 1; i <= 52; i++) expect(repositories.some(r => r.fullName === `fixture/page-${String(i).padStart(3, "0")}`)).toBe(true);
    const readonly = repositories.find(r => r.fullName === "team-read/readonly-repo");
    expect(readonly?.permissions).toMatchObject({ pull: true, push: false });
    const scoped = await svc.listRepositories(owner, { provider: provider!, targetId: (await svc.targets(owner, { provider: provider! })).data.find(t => t.name === "team-read")!.id });
    expect(scoped.data.map(r => r.fullName)).toEqual(["team-read/readonly-repo"]);
    if (provider === "gitea") {
      const legacy = await svc.repositories(owner, "gitea", 1);
      expect(legacy).toHaveLength(50);
    }
  });

  it("clones a real repository without persisting credentials and refuses push to a read-only repository", async () => {
    const { repositories } = await allRepositories();
    const seeded = repositories.find(r => r.fullName === "fixture/seeded")!, readonly = repositories.find(r => r.fullName === "team-read/readonly-repo")!;
    const target = await project("clone-seeded"), binding = await svc.bindRepository(owner, target, provider!, seeded.id);
    const cloned = await svc.operate(owner, "clone", { bindingId: binding.id, expectedVersion: (await svc.status(owner, binding.id)).version, paths: [], confirmed: false, private: true }, author);
    expect(cloned.ok).toBe(true);
    expect(await readFile(join(target, "README.md"), "utf8")).toContain("seeded");
    expect(run(target, "config", "--get", "remote.origin.url")).toBe(seeded.cloneUrl);
    expect(await readFile(join(target, ".git", "config"), "utf8")).not.toContain(token);

    const readOnlyPath = await project("clone-readonly"), readOnlyBinding = await svc.bindRepository(owner, readOnlyPath, provider!, readonly.id);
    await svc.operate(owner, "clone", { bindingId: readOnlyBinding.id, expectedVersion: (await svc.status(owner, readOnlyBinding.id)).version, paths: [], confirmed: false, private: true }, author);
    run(readOnlyPath, "config", "user.name", "Fixture"); run(readOnlyPath, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(readOnlyPath, "local.txt"), "local\n"); run(readOnlyPath, "add", "local.txt"); run(readOnlyPath, "commit", "-m", "Local only");
    await expect(svc.operate(owner, "push", { bindingId: readOnlyBinding.id, expectedVersion: (await svc.status(owner, readOnlyBinding.id)).version, paths: [], confirmed: true, private: true }, author)).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
    expect(run(readOnlyPath, "status", "--porcelain")).toBe("");
  });

  it("publishes to an existing organization, pushes only on explicit request, then fetches and fast-forwards", async () => {
    const name = `space-publish-${Date.now().toString(36)}`;
    const path = await project("publish-org", true), head = run(path, "rev-parse", "HEAD");
    await writeFile(join(path, "draft.txt"), "uncommitted draft\n");
    const teamWrite = (await svc.targets(owner, { provider: provider! })).data.find(t => t.name === "team-write")!;
    const binding = await svc.bindRepository(owner, path, provider!);
    const input = { bindingId: binding.id, expectedVersion: (await svc.status(owner, binding.id)).version, paths: [], confirmed: true, private: true, name, targetId: teamWrite.id, operationId: `${name}-op` };
    expect(await svc.previewPublish(owner, input)).toMatchObject({ targetName: "team-write", private: true, hasCommits: true, willCommit: false, willPush: false });
    const published = await svc.operate(owner, "publish", input, author);
    expect(published).toMatchObject({ ok: true, remoteCreated: true, createOutcome: "created", committed: false, pushed: false });
    expect((await api(`/repos/team-write/${name}`)).data).toMatchObject({ private: true, empty: true });
    expect(run(path, "status", "--porcelain")).toBe("?? draft.txt");
    const pushed = await svc.operate(owner, "push", { ...input, expectedVersion: (await svc.status(owner, binding.id)).version }, author);
    expect(pushed.pushed).toBe(true);
    // The forge records pushed branches through its post-receive queue; allow it to settle.
    let branch = await api(`/repos/team-write/${name}/branches/main`);
    for (let i = 0; i < 40 && branch.status !== 200; i++) { await new Promise(resolve => setTimeout(resolve, 250)); branch = await api(`/repos/team-write/${name}/branches/main`); }
    expect(branch, JSON.stringify(branch).slice(0, 300)).toMatchObject({ status: 200, data: { commit: { id: head } } });

    // A remote-side change arrives through Fetch and a fast-forward-only Pull.
    const created = await api(`/repos/team-write/${name}/contents/remote.txt`, { method: "POST", body: { content: Buffer.from("from remote\n").toString("base64"), message: "Remote change", branch: "main" } });
    expect(created.status).toBe(201);
    const fetched = await svc.operate(owner, "fetch", { ...input, expectedVersion: (await svc.status(owner, binding.id)).version }, author);
    expect(fetched.snapshot.behind).toBe(1);
    const pulled = await svc.operate(owner, "pull", { ...input, expectedVersion: fetched.snapshot.version }, author);
    expect(pulled.ok).toBe(true); expect(await readFile(join(path, "remote.txt"), "utf8")).toBe("from remote\n");
    expect(await readFile(join(path, "draft.txt"), "utf8")).toBe("uncommitted draft\n");
  });

  it("opens projects from the provider list and from a private Git URL using only the matching connection", async () => {
    const { repositories } = await allRepositories();
    const readonly = repositories.find(r => r.fullName === "team-read/readonly-repo")!;
    const opener = new ProjectSourceOpener(svc, root), authorize = async (path: string) => path;
    const fromProvider = await opener.open(owner, { source: { kind: "provider", provider: provider!, repositoryId: readonly.id }, destination: join(root, "open-provider") }, authorize);
    expect(fromProvider).toMatchObject({ created: true, binding: { kind: "provider", repository: { id: readonly.id } }, source: { detail: "team-read/readonly-repo" } });
    expect(await readFile(join(root, "open-provider", "README.md"), "utf8")).toContain("readonly-repo");
    const fromUrl = await opener.open(owner, { source: { kind: "git-url", url: readonly.cloneUrl }, destination: join(root, "open-url") }, authorize);
    expect(fromUrl.binding).toMatchObject({ kind: "git-url", provider });
    expect(await readFile(join(root, "open-url", ".git", "config"), "utf8")).not.toContain(token);
    await expect(opener.open(owner, { source: { kind: "git-url", url: readonly.cloneUrl }, destination: join(root, "open-url") }, authorize)).rejects.toMatchObject({ code: "NOT_EMPTY" });
  });

  it("reports a real name collision as a rejected create and refuses a target without create permission", async () => {
    const teamWrite = (await svc.targets(owner, { provider: provider! })).data.find(t => t.name === "team-write")!;
    const teamRead = (await svc.targets(owner, { provider: provider! })).data.find(t => t.name === "team-read")!;
    const name = `space-collision-${Date.now().toString(36)}`;
    expect((await api(`/orgs/team-write/repos`, { method: "POST", body: { name, private: true } })).status).toBe(201);
    const path = await project("publish-collision", true), binding = await svc.bindRepository(owner, path, provider!);
    const input = { bindingId: binding.id, expectedVersion: (await svc.status(owner, binding.id)).version, paths: [], confirmed: true, private: true, name, targetId: teamWrite.id, operationId: `${name}-op` };
    await expect(svc.operate(owner, "publish", input, author)).rejects.toMatchObject({ code: "REPOSITORY_COLLISION" });
    expect(run(path, "remote")).toBe("");
    await expect(svc.operate(owner, "publish", { ...input, targetId: teamRead.id, name: `${name}-denied`, operationId: `${name}-denied-op` }, author)).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
    expect((await api(`/repos/team-read/${name}-denied`)).status).toBe(404);
  });
});
