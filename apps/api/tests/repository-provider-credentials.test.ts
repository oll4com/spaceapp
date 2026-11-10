import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as providers from "../src/source-control/providers.js";
import { GitEngine, runGit } from "../src/source-control/git-engine.js";
let root: string, server: Server | undefined;
beforeEach(async () => { const scratch = join(tmpdir(), "repository-provider-test-fixtures"); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "credentials-")); });
afterEach(async () => { if (server) await new Promise<void>(r => server!.close(() => r())); server = undefined; await rm(root, { recursive: true, force: true }); });
describe("scoped Git credential transport", () => {
  it("releases credentials only for the validated repository path and expected Git username", async () => {
    const policy = new providers.ProviderUrlPolicy(["http://127.0.0.1:12345"]);
    const env = await providers.createGitEnvironment(policy, join(root, "credentials"), "http://127.0.0.1:12345/owned/repo.git", "fixture-secret", "x-bitbucket-api-token-auth");
    const run = promisify(execFile);
    for (const prompt of ["Password for 'http://127.0.0.1:12345/foreign/repo.git':", "Password for 'http://evil.invalid/owned/repo.git':", "Password for 'http://wrong@127.0.0.1:12345/owned/repo.git':"]) {
      await expect(run(process.execPath, [env.GIT_ASKPASS!, prompt], { env: { ...process.env, ...env } })).rejects.toMatchObject({ code: 1, stdout: "" });
    }
    expect(await readFile(env.GIT_ASKPASS!, "utf8")).not.toContain("fixture-secret");
    expect(JSON.stringify(env)).not.toContain("fixture-secret@");
  });
  it("clones and explicitly pushes using owned HTTP Git without saving credentials or committing user files", async () => {
    const bare = join(root, "remote.git"); execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" }); execFileSync("git", ["-C", bare, "config", "http.receivepack", "true"]);
    let authenticated = 0;
    server = createServer((request, response) => {
      if (request.headers.authorization !== `Basic ${Buffer.from("fixture-login:fixture-secret").toString("base64")}`) { response.writeHead(401, { "www-authenticate": 'Basic realm="Owned fixture"' }).end(); return; }
      authenticated++; const url = new URL(request.url!, "http://127.0.0.1");
      const child = execFile("git", ["http-backend"], { encoding: "buffer", timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] || "", REMOTE_USER: "fixture" } }, (error, stdout) => {
        if (error) { response.writeHead(500).end(); return; }
        const end = stdout.indexOf("\r\n\r\n"); for (const line of stdout.subarray(0, end).toString().split("\r\n")) { const index = line.indexOf(":"); const key = line.slice(0, index), value = line.slice(index + 1).trim(); if (key.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]); else response.setHeader(key, value); } response.end(stdout.subarray(end + 4));
      }); request.pipe(child.stdin!);
    });
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r)); const address = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${address.port}/remote.git`, env = await providers.createGitEnvironment(new providers.ProviderUrlPolicy([new URL(url).origin]), join(root, "credentials"), url, "fixture-secret", "fixture-login");
    const project = join(root, "clone"); await mkdir(project); const engine = new GitEngine();
    await engine.operate(project, { operation: "clone", expectedVersion: (await engine.status(project)).version, remoteUrl: url, env });
    await writeFile(join(project, "approved.txt"), "approved\n"); await writeFile(join(project, "draft.txt"), "draft\n");
    let snapshot = await engine.status(project); snapshot = (await engine.operate(project, { operation: "stage", expectedVersion: snapshot.version, paths: ["approved.txt"] })).snapshot;
    snapshot = (await engine.operate(project, { operation: "commit", expectedVersion: snapshot.version, message: "Explicit commit", author: { name: "Fixture", email: "fixture@example.invalid" } })).snapshot;
    const result = await engine.operate(project, { operation: "push", expectedVersion: snapshot.version, remoteUrl: url, env }); expect(result.pushed).toBe(true); expect(authenticated).toBeGreaterThan(0);
    expect(await runGit(project, ["config", "--get", "remote.origin.url"])).toBe(url + "\n");
    expect(await readFile(join(project, ".git", "config"), "utf8")).not.toContain("fixture-secret"); expect(await runGit(project, ["ls-tree", "--name-only", "HEAD"])).toBe("approved.txt\n"); expect(await readFile(join(project, "draft.txt"), "utf8")).toBe("draft\n");
  });
});
