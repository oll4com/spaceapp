import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRemoteRepository } from "@space/contracts";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";
let root: string, project: string, bare: string, server: Server, remote: GitRemoteRepository, repository: InMemorySourceControlRepository;
let creates: number, requests: number, failFetch: boolean, foreignLookup: boolean, duringCreate: (() => Promise<void>) | undefined;
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = { name: "Fixture", email: "fixture@example.invalid" };
function service() {
  return new SourceControlService({ repository, credentials: new DemoCredentialStore(join(root, "credentials")), credentialRoot: join(root, "credentials"), privateOrigins: [new URL(remote.cloneUrl).origin], providerFactory: () => ({
    identity: async () => ({ login: "fixture", email: null }), repositories: async () => [remote], repository: async () => remote,
    lookup: async () => foreignLookup ? { ...remote, id: "foreign-remote" } : remote,
    create: async () => { creates++; await duringCreate?.(); return remote; }, validateCloneUrl: async url => url,
    targets: async () => ({ data: [{ id: "user:1", provider: "forgejo" as const, kind: "user" as const, name: "fixture", canCreateRepository: true }], nextPage: null, nextCursor: null })
  }) });
}
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures"); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "publish-git-")); project = join(root, "project"); await mkdir(project);
  bare = join(root, "remote.git"); execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" }); execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  creates = 0; requests = 0; failFetch = false; foreignLookup = false; duringCreate = undefined; repository = new InMemorySourceControlRepository();
  server = createServer((request, response) => {
    requests++; if (failFetch) { response.writeHead(503).end(); return; }
    const url = new URL(request.url!, "http://127.0.0.1");
    const child = execFile("git", ["http-backend"], { encoding: "buffer", timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] || "", REMOTE_USER: "fixture" } }, (error, stdout) => {
      if (error) { response.writeHead(500).end(); return; }
      const end = stdout.indexOf("\r\n\r\n"); for (const line of stdout.subarray(0, end).toString().split("\r\n")) { const index = line.indexOf(":"); const key = line.slice(0, index), value = line.slice(index + 1).trim(); if (key.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]); else response.setHeader(key, value); } response.end(stdout.subarray(end + 4));
    }); request.pipe(child.stdin!);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as import("node:net").AddressInfo;
  remote = { id: "known-remote", fullName: "fixture/repo", cloneUrl: `http://127.0.0.1:${address.port}/remote.git`, webUrl: `http://127.0.0.1:${address.port}/repo`, private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } };
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
async function setup() { const svc = service(); await svc.connect("user:a", "gitea", { token: "fixture-token", serverUrl: new URL(remote.cloneUrl).origin }); const binding = await svc.bind("user:a", project, "gitea"); return { svc, binding, input: { bindingId: binding.id, expectedVersion: (await svc.status("user:a", binding.id)).version, name: "repo", private: true, confirmed: true, paths: [], operationId: "fixture-create" } }; }
describe("publish against real owned Git", () => {
  it("creates and binds an empty remote while preserving staged and untracked files", async () => {
    await writeFile(join(project, "selected.txt"), "selected\n"); git("add", "selected.txt"); await writeFile(join(project, "draft.txt"), "draft\n"); const { svc, input } = await setup();
    const result = await svc.operate("user:a", "publish", input, author);
    expect(result).toMatchObject({ ok: true, remoteCreated: true, committed: false, pushed: false }); expect(git("diff", "--cached", "--name-only")).toBe("selected.txt");
    expect(result.snapshot.head).toBeNull(); expect(await readFile(join(project, "draft.txt"), "utf8")).toBe("draft\n"); expect(creates).toBe(1);
  });
  it("requires explicit Push for existing commits, preserves the remote after rejected push, and retries without creating", async () => {
    await writeFile(join(project, "file.txt"), "committed\n"); git("add", "file.txt"); git("commit", "-m", "User commit"); const head = git("rev-parse", "HEAD"); const { svc, input } = await setup();
    const published = await svc.operate("user:a", "publish", input, author); expect(published).toMatchObject({ ok: true, remoteCreated: true, committed: false, pushed: false });
    expect(execFileSync("git", ["-C", bare, "for-each-ref"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()).toBe("");
    await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(svc.operate("user:a", "push", { ...input, expectedVersion: published.snapshot.version }, author)).rejects.toMatchObject({ code: "GIT_FAILED" });
    await rm(join(bare, "hooks", "pre-receive"));
    const pushed = await svc.operate("user:a", "push", { ...input, expectedVersion: (await svc.status("user:a", input.bindingId)).version }, author); expect(pushed.pushed).toBe(true);
    expect(execFileSync("git", ["-C", bare, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(head); expect(creates).toBe(1);
  });
  it("reuses a confirmed remote across restart and concurrent calls after fetch failure", async () => {
    const { svc, input } = await setup(); failFetch = true;
    const first = await svc.operate("user:a", "publish", input, author); expect(first).toMatchObject({ ok: false, remoteCreated: true, committed: false, pushed: false });
    const record = await repository.getPublish("user:a", input.bindingId); expect(record).toMatchObject({ state: "created", remote: { id: "known-remote" } });
    failFetch = false; const restarted = service(); const results = await Promise.all([restarted.operate("user:a", "publish", input, author), restarted.operate("user:a", "publish", input, author)]);
    expect(results.every(r => r.ok && r.remoteCreated)).toBe(true); expect(creates).toBe(1); expect(git("remote", "get-url", "origin")).toBe(remote.cloneUrl);
  });
  it("claims creation once across separate service instances", async () => {
    const { svc, input } = await setup(); const results = await Promise.all([svc.operate("user:a", "publish", input, author), service().operate("user:a", "publish", input, author)]);
    expect(results.some(r => r.remoteCreated)).toBe(true); expect(creates).toBe(1);
  });
  it("does not fetch a different repository when the confirmed stable ID lookup mismatches", async () => {
    const { svc, input } = await setup(); foreignLookup = true;
    expect(await svc.operate("user:a", "publish", input, author)).toMatchObject({ ok: false, remoteCreated: true }); expect(requests).toBe(0); expect(git("remote")).toBe("");
  });
  it("serializes publishes from different provider bindings of one project and creates one remote", async () => {
    const { svc, input } = await setup();
    await svc.connect("user:a", "forgejo", { token: "fixture-token", serverUrl: new URL(remote.cloneUrl).origin });
    await svc.setEnabled("user:a", "forgejo", true);
    const other = await svc.bindRepository("user:a", project, "forgejo");
    const results = await Promise.allSettled([svc.operate("user:a", "publish", input, author), svc.operate("user:a", "publish", { ...input, bindingId: other.id, targetId: "user:1", operationId: "fixture-create-forgejo" }, author)]);
    expect(creates).toBe(1);
    expect(results.filter(r => r.status === "fulfilled" && r.value.ok && r.value.remoteCreated)).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(["REMOTE_EXISTS", "STALE_STATE"]).toContain(rejected?.reason?.code); expect(git("remote", "get-url", "origin")).toBe(remote.cloneUrl);
  });
  it("blocks a second provider publish while another binding's created remote is not attached", async () => {
    const { svc, input } = await setup(); foreignLookup = true;
    expect(await svc.operate("user:a", "publish", input, author)).toMatchObject({ ok: false, remoteCreated: true }); expect(git("remote")).toBe("");
    await svc.connect("user:a", "forgejo", { token: "fixture-token", serverUrl: new URL(remote.cloneUrl).origin });
    await svc.setEnabled("user:a", "forgejo", true);
    const other = await svc.bindRepository("user:a", project, "forgejo");
    const expectedVersion = (await svc.status("user:a", other.id)).version;
    await expect(svc.operate("user:a", "publish", { ...input, bindingId: other.id, expectedVersion, targetId: "user:1", operationId: "fixture-create-forgejo" }, author)).rejects.toMatchObject({ code: "PUBLISH_CONFLICT" });
    expect(creates).toBe(1); expect(git("remote")).toBe("");
  });
  it("preserves local edits made while POST was in flight and requires refreshed local state", async () => {
    const { svc, input } = await setup(); duringCreate = async () => { await writeFile(join(project, "new.txt"), "changed during create\n"); };
    expect(await svc.operate("user:a", "publish", input, author)).toMatchObject({ ok: false, remoteCreated: true }); expect(requests).toBe(0); expect(git("remote")).toBe(""); expect(await readFile(join(project, "new.txt"), "utf8")).toBe("changed during create\n");
  });
});
