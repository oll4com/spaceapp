import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, chmod, stat } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { join } from "node:path";
import { GitEngine, runGit } from "../src/source-control/git-engine.js";

const scratch = join(tmpdir(), "20261003-personal-source-control");
let root: string;
let engine: GitEngine;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
beforeEach(async () => {
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "git-"));
  engine = new GitEngine();
  git("init", "-b", "main");
  git("config", "user.name", "Source Control Test");
  git("config", "user.email", "test@example.invalid");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("native source control", () => {
  it("compares the selected provider while preserving origin, upstream and local files", async () => {
    await writeFile(join(root, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
    const fixture = await mkdtemp(join(scratch, "comparison-"));
    const bare = join(fixture, "remote.git");
    execFileSync("git", ["clone", "--bare", root, bare], { stdio: "pipe" });
    execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
    await writeFile(join(root, "file.txt"), "local commit\n"); git("add", "."); git("commit", "-m", "local difference");
    const origin = "https://unrelated-origin.example/repo.git";
    git("remote", "add", "origin", origin);
    git("config", "branch.main.remote", "origin"); git("config", "branch.main.merge", "refs/heads/main");
    const head = git("rev-parse", "HEAD").trim();
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      const child = execFile("git", ["http-backend"], { encoding: "buffer", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: fixture, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] || "", REMOTE_USER: "proof" }
      }, (error, stdout) => {
        if (error) { response.writeHead(500).end(); return; }
        const end = stdout.indexOf("\r\n\r\n");
        for (const line of stdout.subarray(0, end).toString().split("\r\n")) {
          const separator = line.indexOf(":"); const key = line.slice(0, separator); const value = line.slice(separator + 1).trim();
          if (key.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]); else response.setHeader(key, value);
        }
        response.end(stdout.subarray(end + 4));
      });
      request.pipe(child.stdin!);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as import("node:net").AddressInfo;
      const comparison = { url: `http://127.0.0.1:${address.port}/remote.git`, defaultBranch: "main" };
      const pending = await engine.status(root, comparison);
      expect(pending).toMatchObject({ ahead: 0, behind: 0, comparison: { ready: false, changes: [] } });
      const fetched = await engine.operate(root, { operation: "fetch", expectedVersion: pending.version, remoteUrl: comparison.url, comparison });
      expect(fetched.snapshot).toMatchObject({ ahead: 1, behind: 0, changes: [], comparison: { ready: true, branch: "main", changes: [{ path: "file.txt", status: "M" }] } });
      const remoteDiff = await engine.diff(root, "file.txt", false, comparison, true);
      expect(remoteDiff.text).toContain("-base"); expect(remoteDiff.text).toContain("+local commit");
      expect(git("rev-parse", "HEAD").trim()).toBe(head);
      expect(git("config", "remote.origin.url").trim()).toBe(origin);
      expect(git("config", "branch.main.remote").trim()).toBe("origin");
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("local commit\n");
      const other = await engine.status(root, { url: comparison.url + "-other", defaultBranch: "main" });
      expect(other.comparison?.ready).toBe(false); expect(other.ahead).toBe(0);
      await expect(engine.diff(root, "not-a-change.txt", false, comparison, true)).rejects.toThrow(/change list/i);
      await writeFile(join(root, "new.txt"), "local addition\n");
      let status = await engine.status(root, comparison);
      status = (await engine.operate(root, { operation: "stage", paths: ["new.txt"], expectedVersion: status.version, comparison })).snapshot;
      status = (await engine.operate(root, { operation: "commit", message: "previewed local addition", expectedVersion: status.version, comparison })).snapshot;
      const pushed = await engine.operate(root, { operation: "push", expectedVersion: status.version, remoteUrl: comparison.url, comparison });
      expect(pushed.snapshot).toMatchObject({ ahead: 0, behind: 0, comparison: { changes: [] } });
      const writer = join(fixture, "writer");
      execFileSync("git", ["clone", bare, writer], { stdio: "pipe" });
      await writeFile(join(writer, "file.txt"), "new remote content\n");
      execFileSync("git", ["-C", writer, "add", "."]);
      execFileSync("git", ["-C", writer, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-m", "remote update"], { stdio: "pipe" });
      execFileSync("git", ["-C", writer, "push"], { stdio: "pipe" });
      const oldVersion = pushed.snapshot.version;
      const fetchedAgain = await engine.operate(root, { operation: "fetch", expectedVersion: oldVersion, remoteUrl: comparison.url, comparison });
      expect(fetchedAgain.snapshot).toMatchObject({ ahead: 0, behind: 1 });
      await expect(engine.operate(root, { operation: "push", expectedVersion: oldVersion, remoteUrl: comparison.url, comparison })).rejects.toThrow(/changed/i);
      await engine.operate(root, { operation: "pull", expectedVersion: fetchedAgain.snapshot.version, remoteUrl: comparison.url, comparison });
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("new remote content\n");
      expect(git("config", "remote.origin.url").trim()).toBe(origin);
      expect(git("config", "branch.main.remote").trim()).toBe("origin");
      await writeFile(join(root, "new.txt"), "another local commit\n"); git("add", "."); git("commit", "-m", "partial synchronization proof");
      const reference = git("for-each-ref", "--format=%(refname)", "refs/space-source-control").trim();
      const lock = join(root, ".git", `${reference}.lock`);
      await writeFile(lock, "owned lock fixture\n");
      status = await engine.status(root, comparison);
      try {
        const partial = await engine.operate(root, { operation: "push", expectedVersion: status.version, remoteUrl: comparison.url, comparison });
        expect(partial).toMatchObject({ ok: false, committed: false, pushed: true });
        expect(partial.message).toMatch(/push succeeded/i);
        expect(execFileSync("git", ["-C", bare, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(git("rev-parse", "HEAD").trim());
      } finally { await rm(lock, { force: true }); }
      status = await engine.status(root, comparison);
      expect((await engine.operate(root, { operation: "fetch", expectedVersion: status.version, remoteUrl: comparison.url, comparison })).snapshot.ahead).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(fixture, { recursive: true, force: true }); }
  });

  it("bounds commands whose hooks or helpers leave child processes holding output open", async () => {
    const started = Date.now();
    await expect(runGit(root, ["-c", "alias.proofwait=!sleep 2", "proofwait"], { timeout: 100 })).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("restores files group-writable for pane CLIs running as another user", async () => {
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "a.ts"), "export {};\n");
    git("add", "."); git("commit", "-m", "base");
    await rm(join(root, "src"), { recursive: true });
    // The API service runs with umask 022 while pane CLIs share only its group.
    const previousUmask = process.umask(0o022);
    try { await runGit(root, ["checkout", "--", "src"]); } finally { process.umask(previousUmask); }
    for (const path of [join(root, "src"), join(root, "src", "a.ts")]) {
      expect((await stat(path)).mode & 0o020, path).toBe(0o020);
    }
  });
  it("uses the real index and commits only staged Unicode files", async () => {
    await writeFile(join(root, "α.txt"), "first\n");
    await writeFile(join(root, "leave.txt"), "unstaged\n");
    let status = await engine.status(root);
    status = (await engine.operate(root, { operation: "stage", expectedVersion: status.version, paths: ["α.txt"] })).snapshot;
    expect(status.staged.map(f => f.path)).toEqual(["α.txt"]);
    expect(status.changes.map(f => f.path)).toEqual(["leave.txt"]);
    await engine.operate(root, { operation: "commit", expectedVersion: status.version, message: "Selected file" });
    expect(git("ls-tree", "--name-only", "HEAD").trim()).toBe("\"\\316\\261.txt\"");
    expect(await readFile(join(root, "leave.txt"), "utf8")).toBe("unstaged\n");
  });
  it("rejects stale choices after external file and index changes", async () => {
    await writeFile(join(root, "file.txt"), "one\n");
    const status = await engine.status(root);
    await writeFile(join(root, "file.txt"), "two\n");
    await expect(engine.operate(root, { operation: "stage", expectedVersion: status.version, paths: ["file.txt"] })).rejects.toThrow(/changed/i);
  });
  it("stages and unstages one hunk while preserving other edits", async () => {
    const lines = Array.from({ length: 24 }, (_, i) => `line ${i}`);
    await writeFile(join(root, "file.txt"), lines.join("\n") + "\n");
    git("add", "--", "file.txt"); git("commit", "-m", "base");
    lines[1] = "first edit"; lines[21] = "second edit";
    await writeFile(join(root, "file.txt"), lines.join("\n") + "\n");
    let status = await engine.status(root);
    const diff = await engine.diff(root, "file.txt", false);
    expect(diff.hunks).toHaveLength(2);
    status = (await engine.operate(root, { operation: "stage", expectedVersion: status.version, paths: ["file.txt"], hunkId: diff.hunks[0]!.id })).snapshot;
    expect(git("diff", "--cached")).toContain("first edit");
    expect(git("diff", "--cached")).not.toContain("second edit");
    const staged = await engine.diff(root, "file.txt", true);
    await engine.operate(root, { operation: "unstage", expectedVersion: status.version, paths: ["file.txt"], hunkId: staged.hunks[0]!.id });
    expect(git("diff", "--cached")).toBe("");
    expect(await readFile(join(root, "file.txt"), "utf8")).toContain("second edit");
  });
  it("serializes competing mutations so only one stale request succeeds", async () => {
    await writeFile(join(root, "file.txt"), "one\n");
    const status = await engine.status(root);
    const results = await Promise.allSettled([0, 1].map(() => engine.operate(root, { operation: "stage", expectedVersion: status.version, paths: ["file.txt"] })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects traversal, symlink escapes and nested repository roots", async () => {
    await writeFile(join(root, "file.txt"), "one\n");
    await symlink("/etc", join(root, "outside"));
    const status = await engine.status(root);
    for (const path of ["../outside", "outside/passwd", ".git/config"]) {
      await expect(engine.operate(root, { operation: "stage", expectedVersion: status.version, paths: [path] })).rejects.toThrow();
    }
    await mkdir(join(root, "child"));
    await expect(engine.status(join(root, "child"))).rejects.toThrow(/root/i);
  });
  it("preserves binary content, staged renames and external staging", async () => {
    await writeFile(join(root, "before.bin"), Buffer.from([0, 1, 2, 255]));
    git("add", "before.bin"); git("commit", "-m", "base");
    await rename(join(root, "before.bin"), join(root, "after.bin"));
    git("add", "-A");
    const status = await engine.status(root);
    expect(status.staged[0]).toMatchObject({ path: "after.bin", originalPath: "before.bin", status: "R" });
    expect((await engine.diff(root, "after.bin", true)).binary).toBe(true);
    await engine.operate(root, { operation: "unstage", expectedVersion: status.version, paths: ["after.bin"] });
    expect(git("diff", "--cached")).toBe("");
    expect(await readFile(join(root, "after.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
  });
  it("requires explicit discard confirmation and preserves the staged version", async () => {
    await writeFile(join(root, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
    await writeFile(join(root, "file.txt"), "staged\n"); git("add", "file.txt");
    await writeFile(join(root, "file.txt"), "unstaged\n");
    const status = await engine.status(root);
    await expect(engine.operate(root, { operation: "discard", expectedVersion: status.version, paths: ["file.txt"] })).rejects.toThrow(/confirm/i);
    await engine.operate(root, { operation: "discard", expectedVersion: status.version, paths: ["file.txt"], confirmed: true });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("staged\n");
    expect(git("diff", "--cached")).toContain("staged");
  });
  it("keeps staged changes when a commit hook fails", async () => {
    await writeFile(join(root, "file.txt"), "staged\n"); git("add", ".");
    const hook = join(root, ".git/hooks/pre-commit"); await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    const status = await engine.status(root);
    await expect(engine.operate(root, { operation: "commit", expectedVersion: status.version, message: "blocked" })).rejects.toThrow();
    expect((await engine.status(root)).staged).toHaveLength(1);
  });
  it("reports a completed commit when push fails, allowing Push to be retried", async () => {
    await writeFile(join(root, "file.txt"), "staged\n"); git("add", ".");
    const status = await engine.status(root);
    const result = await engine.operate(root, { operation: "commit-push", expectedVersion: status.version, message: "persisted", remoteUrl: "https://127.0.0.1:1/proof.git" });
    expect(result).toMatchObject({ ok: false, committed: true, pushed: false });
    expect(git("log", "-1", "--format=%s").trim()).toBe("persisted");
    expect(result.snapshot.staged).toHaveLength(0);
  });
  it("rejects stage selections that include clean files outside the displayed snapshot", async () => {
    await writeFile(join(root, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
    const status = await engine.status(root);
    await expect(engine.operate(root, { operation: "stage", expectedVersion: status.version, paths: ["file.txt"] })).rejects.toThrow(/selection/i);
  });
  it("refuses hook-added staging so a commit contains only the previewed index", async () => {
    await writeFile(join(root, "selected.txt"), "selected\n");
    await writeFile(join(root, "hidden.txt"), "not selected\n");
    git("add", "selected.txt");
    const hook = join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\ngit add -- hidden.txt\n"); await chmod(hook, 0o755);
    const status = await engine.status(root);
    await expect(engine.operate(root, { operation: "commit", expectedVersion: status.version, message: "preview only" })).rejects.toThrow();
    expect((await engine.status(root)).staged.map(f => f.path)).toEqual(["selected.txt"]);
    expect((await engine.status(root)).head).toBeNull();
  });
  it("rejects Git metadata moved outside the authorized project/workspace", async () => {
    await writeFile(join(root, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
    const external = join(root, "..", `external-${root.split("/").at(-1)}`);
    await mkdir(external);
    try {
      await rename(join(root, ".git"), join(external, "metadata"));
      await writeFile(join(root, ".git"), `gitdir: ${join(external, "metadata")}\n`);
      await expect(engine.status(root)).rejects.toThrow(/metadata|workspace/i);
    } finally { await rm(external, { recursive: true, force: true }); }
  });
  it("does not create a commit when Commit & Push selected a different existing origin", async () => {
    await writeFile(join(root, "file.txt"), "staged\n"); git("add", "."); git("remote", "add", "origin", "https://example.invalid/original.git");
    const status = await engine.status(root);
    await expect(engine.operate(root, { operation: "commit-push", expectedVersion: status.version, message: "must not commit", remoteUrl: "https://example.invalid/different.git" })).rejects.toThrow(/differs/i);
    expect((await engine.status(root)).head).toBeNull();
  });
  it("clones, pushes, fetches, pulls only fast-forwards and preserves rejected local commits", async () => {
    const remotes = await mkdtemp(join(scratch, "http-git-"));
    const bare = join(remotes, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bare]);
    execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      if (!url.pathname.startsWith("/remote.git/")) { response.writeHead(404).end(); return; }
      const child = execFile("git", ["http-backend"], { encoding: "buffer", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: remotes, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] || "", REMOTE_USER: "proof" }
      }, (error, stdout) => {
        if (error) { response.writeHead(500).end(); return; }
        const end = stdout.indexOf("\r\n\r\n");
        if (end < 0) { response.writeHead(500).end(); return; }
        for (const line of stdout.subarray(0, end).toString().split("\r\n")) {
          const separator = line.indexOf(":"); const key = line.slice(0, separator); const value = line.slice(separator + 1).trim();
          if (key.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]); else response.setHeader(key, value);
        }
        response.end(stdout.subarray(end + 4));
      });
      request.pipe(child.stdin!);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Proof server did not listen.");
      const remoteUrl = `http://127.0.0.1:${address.port}/remote.git`;
      await rm(join(root, ".git"), { recursive: true });
      const operate = async (operation: Parameters<GitEngine["operate"]>[1]["operation"], extra = {}) => {
        try { return await engine.operate(root, { operation, expectedVersion: (await engine.status(root)).version, remoteUrl, author: { name: "Proof", email: "proof@example.invalid" }, ...extra }); }
        catch (error) { throw new Error(`${operation}: ${(error as Error).message}`, { cause: error }); }
      };
      await operate("clone");
      await writeFile(join(root, "base.txt"), "base\n"); await operate("stage", { paths: ["base.txt"] }); await operate("commit", { message: "base" }); await operate("push");
      expect((await engine.status(root)).ahead).toBe(0);
      const writer = join(remotes, "writer");
      await promisify(execFile)("git", ["clone", remoteUrl, writer], { timeout: 10000 });
      const writeRemote = async (name: string) => {
        execFileSync("git", ["-C", writer, "add", "."]);
        execFileSync("git", ["-C", writer, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-m", name], { stdio: "pipe" });
        await promisify(execFile)("git", ["-C", writer, "push"], { timeout: 10000 });
      };
      await writeFile(join(writer, "remote.txt"), "remote\n"); await writeRemote("remote update");
      await operate("fetch"); expect((await engine.status(root)).behind).toBe(1);
      await operate("pull"); expect(await readFile(join(root, "remote.txt"), "utf8")).toBe("remote\n");
      await writeFile(join(root, "local.txt"), "local\n"); await operate("stage", { paths: ["local.txt"] }); await operate("commit", { message: "local preserved" });
      await writeFile(join(writer, "remote.txt"), "new remote\n"); await writeRemote("remote divergence");
      const head = (await engine.status(root)).head;
      await expect(operate("push")).rejects.toThrow(/rejected/i);
      await operate("fetch"); await expect(operate("pull")).rejects.toThrow(/fast-forward/i);
      expect((await engine.status(root)).head).toBe(head);
      expect(await readFile(join(root, "local.txt"), "utf8")).toBe("local\n");
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(remotes, { recursive: true, force: true });
    }
  });
});
