import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRemoteRepository, OpenProjectInput } from "@space/contracts";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { SourceControlService } from "../src/source-control/service.js";
import { ProjectSourceOpener } from "../src/source-control/project-sources.js";

let root: string, parent: string, server: Server, origin: string, requireAuth: boolean, unavailable: boolean, authorizations: string[];
let svc: SourceControlService, opener: ProjectSourceOpener, repository: InMemorySourceControlRepository;
const author = { name: "Fixture", email: "fixture@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const authorize = async (path: string) => realpath(path);
const remoteRepository = (): GitRemoteRepository => ({ id: "77", fullName: "fixture/upstream", cloneUrl: `${origin}/upstream.git`, webUrl: `${origin}/fixture/upstream`, private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: false } });
function service() {
  return new SourceControlService({ repository, credentials: new DemoCredentialStore(join(root, "credentials")), credentialRoot: join(root, "credentials"), privateOrigins: [origin], providerFactory: () => ({
    identity: async () => ({ login: "fixture", email: null }), repositories: async () => [remoteRepository()], repository: async () => remoteRepository(), lookup: async () => remoteRepository(),
    list: async () => ({ data: [remoteRepository()], nextPage: null, nextCursor: null }), targets: async () => ({ data: [], nextPage: null, nextCursor: null }),
    create: async () => remoteRepository(), createRepository: async () => remoteRepository(),
    validateCloneUrl: async url => { if (!url.startsWith(`${origin}/`)) throw Object.assign(new Error("mismatch"), { code: "REMOTE_MISMATCH" }); return url; }
  }) });
}
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures"); await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "project-sources-")); parent = join(root, "projects"); await mkdir(parent);
  const bare = join(root, "upstream.git"); execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" }); execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
  const seed = join(root, "seed"); await mkdir(seed); git(seed, "init", "-b", "main"); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(seed, "README.md"), "upstream\n"); await symlink("/etc/hostname", join(seed, "host-link"));
  git(seed, "add", "README.md", "host-link"); git(seed, "commit", "-m", "Upstream"); git(seed, "push", bare, "main");
  requireAuth = false; unavailable = false; authorizations = [];
  server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    if (unavailable) { response.writeHead(503).end(); return; }
    if (requireAuth && request.headers.authorization !== `Basic ${Buffer.from("fixture:fixture-token").toString("base64")}`) { response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }).end(); return; }
    const url = new URL(request.url!, "http://127.0.0.1");
    const child = execFile("git", ["http-backend"], { encoding: "buffer", timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] || "", REMOTE_USER: "fixture" } }, (error, stdout) => {
      if (error) { response.writeHead(500).end(); return; }
      const end = stdout.indexOf("\r\n\r\n"); for (const line of stdout.subarray(0, end).toString().split("\r\n")) { const index = line.indexOf(":"); const key = line.slice(0, index), value = line.slice(index + 1).trim(); if (key.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]); else response.setHeader(key, value); } response.end(stdout.subarray(end + 4));
    }); request.pipe(child.stdin!);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  repository = new InMemorySourceControlRepository(); svc = service(); opener = new ProjectSourceOpener(svc, parent);
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
const open = (input: OpenProjectInput) => opener.open("user:a", input, authorize);
const gitUrl = (destination: string) => ({ source: { kind: "git-url" as const, url: `${origin}/upstream.git` }, destination });

describe("project sources", { timeout: 60000 }, () => {
  it("creates a new initialized project with a local binding that works without any provider", async () => {
    const result = await open({ source: { kind: "new", name: "fresh" }, destination: join(parent, "fresh") });
    expect(result).toMatchObject({ projectPath: join(parent, "fresh"), created: true, source: { kind: "new" }, binding: { kind: "local" } });
    expect((await stat(join(parent, "fresh", ".git"))).isDirectory()).toBe(true);
    await writeFile(join(parent, "fresh", "a.txt"), "a\n");
    let snapshot = await svc.status("user:a", result.binding!.id);
    snapshot = (await svc.operate("user:a", "stage", { bindingId: result.binding!.id, expectedVersion: snapshot.version, paths: ["a.txt"], confirmed: false, private: true }, author)).snapshot;
    const committed = await svc.operate("user:a", "commit", { bindingId: result.binding!.id, expectedVersion: snapshot.version, paths: [], confirmed: false, private: true, message: "Local commit" }, author);
    expect(committed.committed).toBe(true);
    await expect(svc.operate("user:a", "push", { bindingId: result.binding!.id, expectedVersion: committed.snapshot.version, paths: [], confirmed: true, private: true }, author)).rejects.toMatchObject({ code: "PROVIDER_REQUIRED" });
  });

  it("opens an existing local folder without initializing or changing it", async () => {
    const plain = join(parent, "plain"); await mkdir(plain); await writeFile(join(plain, "notes.txt"), "keep\n");
    const before = await readdir(plain);
    const result = await open({ source: { kind: "local", path: plain } });
    expect(result).toMatchObject({ projectPath: plain, created: false, repositoryRoot: null, binding: { kind: "local" } });
    expect(await readdir(plain)).toEqual(before);
    const status = await svc.status("user:a", result.binding!.id);
    expect(status.initialized).toBe(false);
  });

  it("returns the enclosing repository instead of binding a subfolder", async () => {
    const repo = join(parent, "repo"); await mkdir(join(repo, "packages", "web"), { recursive: true }); git(repo, "init", "-b", "main");
    const result = await open({ source: { kind: "local", path: join(repo, "packages", "web") } });
    expect(result).toMatchObject({ projectPath: join(repo, "packages", "web"), binding: null, repositoryRoot: repo });
  });

  it("still opens a linked worktree folder for a room when Source Control cannot review it", async () => {
    const repo = join(parent, "main-repo"); await mkdir(repo); git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "a.txt"), "a\n"); git(repo, "add", "a.txt"); git(repo, "commit", "-m", "a"); git(repo, "worktree", "add", "-q", join(parent, "linked-wt"));
    const result = await open({ source: { kind: "local", path: join(parent, "linked-wt") } });
    expect(result).toMatchObject({ projectPath: join(parent, "linked-wt"), binding: null, created: false });
    expect(result.source.detail).toMatch(/^Source Control unavailable/);
  });

  it("keeps users without ADMIN/OPERATOR inside the projects root and checks out symlinks as plain files for them", async () => {
    const restricted = (input: OpenProjectInput) => opener.open("user:a", input, { authorize, restricted: true });
    const outside = join(root, "elsewhere"); await mkdir(outside);
    await expect(restricted({ source: { kind: "new", name: "x" }, destination: join(outside, "x") })).rejects.toMatchObject({ code: "PROJECT_FORBIDDEN" });
    await expect(lstat(join(outside, "x"))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await restricted(gitUrl(join(parent, "user-clone")));
    expect(result.projectPath).toBe(join(parent, "user-clone"));
    expect((await lstat(join(parent, "user-clone", "host-link"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(parent, "user-clone", "host-link"), "utf8")).toBe("/etc/hostname");
    const admin = await open(gitUrl(join(parent, "admin-clone")));
    expect((await lstat(join(admin.projectPath, "host-link"))).isSymbolicLink()).toBe(true);
  });

  it("creates and clones inside a folder that is itself part of another Git work tree", async () => {
    const outer = join(root, "outer"); await mkdir(join(outer, "projects"), { recursive: true }); git(outer, "init", "-b", "main");
    const nested = new ProjectSourceOpener(svc, join(outer, "projects"));
    const created = await nested.open("user:a", { source: { kind: "new", name: "fresh" }, destination: join(outer, "projects", "fresh") }, authorize);
    expect(created.binding).toMatchObject({ kind: "local", projectPath: join(outer, "projects", "fresh") });
    const cloned = await nested.open("user:a", gitUrl(join(outer, "projects", "cloned")), authorize);
    expect(await readFile(join(cloned.projectPath, "README.md"), "utf8")).toBe("upstream\n");
    expect(git(outer, "status", "--porcelain")).toBe("?? projects/");
  });

  it("refuses non-empty, symlinked and malformed destinations without touching them", async () => {
    const busy = join(parent, "busy"); await mkdir(busy); await writeFile(join(busy, "keep.txt"), "keep\n");
    await expect(open({ source: { kind: "new", name: "busy" }, destination: busy })).rejects.toMatchObject({ code: "NOT_EMPTY" });
    await expect(open(gitUrl(busy))).rejects.toMatchObject({ code: "NOT_EMPTY" });
    expect(await readFile(join(busy, "keep.txt"), "utf8")).toBe("keep\n");
    const outside = join(root, "outside"); await mkdir(outside); await symlink(outside, join(parent, "linked"));
    await expect(open({ source: { kind: "new", name: "linked" }, destination: join(parent, "linked") })).rejects.toMatchObject({ code: "INVALID_DESTINATION" });
    expect(await readdir(outside)).toEqual([]);
    for (const destination of [`${parent}/../escape`, "relative/path", `${parent}/bad name`, `${parent}/repo.git`, `${parent}/`]) {
      await expect(open({ source: { kind: "new", name: "x" }, destination })).rejects.toMatchObject({ code: "INVALID_DESTINATION" });
    }
    await expect(open({ source: { kind: "new", name: "other" }, destination: join(parent, "mismatch") })).rejects.toMatchObject({ code: "INVALID_DESTINATION" });
    await expect(lstat(join(parent, "mismatch"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clones a public Git URL anonymously, then fetches and fast-forwards but requires a provider to push", async () => {
    const destination = join(parent, "public");
    const result = await open(gitUrl(destination));
    expect(result).toMatchObject({ created: true, binding: { kind: "git-url", url: `${origin}/upstream.git`, provider: null }, source: { kind: "git-url", label: "Git URL" } });
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("upstream\n");
    expect(authorizations.every(value => value === "")).toBe(true);
    const seed = join(root, "seed"); await writeFile(join(seed, "next.txt"), "next\n"); git(seed, "add", "next.txt"); git(seed, "commit", "-m", "Next"); git(seed, "push", join(root, "upstream.git"), "main");
    const bindingId = result.binding!.id;
    const fetched = await svc.operate("user:a", "fetch", { bindingId, expectedVersion: (await svc.status("user:a", bindingId)).version, paths: [], confirmed: false, private: true }, author);
    expect(fetched.snapshot.behind).toBe(1);
    const pulled = await svc.operate("user:a", "pull", { bindingId, expectedVersion: fetched.snapshot.version, paths: [], confirmed: false, private: true }, author);
    expect(pulled.ok).toBe(true); expect(await readFile(join(destination, "next.txt"), "utf8")).toBe("next\n");
    await expect(svc.operate("user:a", "push", { bindingId, expectedVersion: pulled.snapshot.version, paths: [], confirmed: true, private: true }, author)).rejects.toMatchObject({ code: "PROVIDER_REQUIRED" });
    expect((await svc.bindLocal("user:a", destination)).id).toBe(bindingId);
  });

  it("removes only the folder it created when a clone fails and keeps a pre-existing empty folder", async () => {
    unavailable = true;
    await expect(open(gitUrl(join(parent, "failed")))).rejects.toMatchObject({ code: "GIT_FAILED" });
    await expect(lstat(join(parent, "failed"))).rejects.toMatchObject({ code: "ENOENT" });
    const empty = join(parent, "empty"); await mkdir(empty);
    await expect(open(gitUrl(empty))).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect((await lstat(empty)).isDirectory()).toBe(true); expect(await readdir(empty)).toEqual([]);
  });

  it("asks to connect a provider for a private URL and uses only a matching connected provider's credentials", async () => {
    requireAuth = true;
    await expect(open(gitUrl(join(parent, "private")))).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    await expect(lstat(join(parent, "private"))).rejects.toMatchObject({ code: "ENOENT" });
    await svc.connect("user:a", "gitea", { token: "fixture-token", serverUrl: origin });
    const result = await open(gitUrl(join(parent, "private")));
    expect(result.binding).toMatchObject({ kind: "git-url", provider: "gitea" });
    expect(await readFile(join(parent, "private", ".git", "config"), "utf8")).not.toContain("fixture-token");
    await svc.setEnabled("user:a", "gitea", false);
    await expect(open(gitUrl(join(parent, "disabled")))).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("clones a provider repository by stable ID into a new folder and binds that repository", async () => {
    requireAuth = true;
    await svc.connect("user:a", "gitea", { token: "fixture-token", serverUrl: origin });
    const result = await open({ source: { kind: "provider", provider: "gitea", repositoryId: "77" }, destination: join(parent, "from-provider") });
    expect(result).toMatchObject({ binding: { kind: "provider", provider: "gitea", repository: { id: "77" } }, source: { label: "Gitea", detail: "fixture/upstream" } });
    expect(await readFile(join(parent, "from-provider", "README.md"), "utf8")).toBe("upstream\n");
    const status = await svc.status("user:a", result.binding!.id);
    expect(status.comparison).toBeTruthy();
  });

  it("lets only one of two concurrent requests use a destination", async () => {
    const destination = join(parent, "race");
    const results = await Promise.allSettled([open(gitUrl(destination)), open(gitUrl(destination))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(["DESTINATION_BUSY", "NOT_EMPTY"]).toContain((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("upstream\n");
  });
});
