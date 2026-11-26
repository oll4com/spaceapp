import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { execFile, execInHelper, spawn, spawnLabel, startExecHelper, stopExecHelper, takeSpawnCounts } from "../src/safe-child-process.js";
import { execGit } from "../src/worktrees/worktree-service.js";
import { git as nousGit } from "../src/nous/git.js";
import { executeBroker } from "../src/cli-vpn.js";

// 1.1.5 internal review (2026-10-16): about 60 API spawns set no env and inherited Space's credentials.
const printSecret = ["-e", "process.stdout.write(process.env.SPACE_SESSION_SECRET ?? 'absent')"];
const saved = process.env.SPACE_SESSION_SECRET;
afterEach(() => { if (saved === undefined) delete process.env.SPACE_SESSION_SECRET; else process.env.SPACE_SESSION_SECRET = saved; });

it("hides Space credentials from children that pass no env and keeps an explicit env", async () => {
  process.env.SPACE_SESSION_SECRET = "fixture-session-secret";
  const run = promisify(execFile);
  expect((await run(process.execPath, printSecret)).stdout).toBe("absent");
  expect((await run(process.execPath, printSecret, { timeout: 10_000 })).stdout).toBe("absent");
  expect((await run(process.execPath, printSecret, { env: { SPACE_SESSION_SECRET: "explicit" } })).stdout).toBe("explicit");
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    const child = spawn(process.execPath, printSecret, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.once("error", reject);
    child.once("close", () => resolve(text));
  });
  expect(output).toBe("absent");
  const callback = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, printSecret, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
  expect(callback).toBe("absent");
});

it("keeps every API module on the safe wrapper", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.includes("__tests__") && !file.includes(".test.") && !file.endsWith("safe-child-process.ts"))
    // Browser Host code (its changes wait for the guarded restart): its spawn's env is checked by apps/worker/tests/child-process-env.test.ts.
    .filter((file) => file !== "browser-sandbox.ts");
  const offenders = files.filter((file) => /^import \{(?!\s*type\b)[^}]*\} from "node:child_process";/m.test(readFileSync(join(src, file), "utf8")) ||
    /from "node:child_process";/.test(readFileSync(join(src, file), "utf8").replace(/^import type [^\n]*\n/gm, "")));
  expect(offenders.map((file) => relative(src, join(src, file)))).toEqual([]);
});

// API audit 4/11: ~3 git ancestor checks a second held stable's main thread; the load line now names what the API spawns.
it("counts spawns per program through the git umask and sudo wrappers", async () => {
  expect(spawnLabel("/bin/sh", ["-c", 'umask 002 && exec git "$@"', "git", "--no-optional-locks", "-c", "safe.directory=*", "-C", "/opt/spaceapp",
    "merge-base", "--is-ancestor", "b059db7d6cced471a4006392d730509aff4a6fab", "dev"])).toBe("git merge-base dev");
  expect(spawnLabel("/usr/bin/sudo", ["-n", "-u", "spaceapp-user", "--", "/opt/spaceapp/bin/gemini-vscode-parity", "native-turns", "pane:Ab12Cd34", "7"]))
    .toBe("gemini-vscode-parity native-turns");
  expect(spawnLabel("sudo", ["-n", "-l"])).toBe("sudo");
  takeSpawnCounts();
  await promisify(execFile)(process.execPath, ["-e", ""]);
  await promisify(execFile)(process.execPath, ["-e", ""]);
  expect(takeSpawnCounts()).toEqual({ [process.execPath.split("/").at(-1)!]: 2 });
  expect(takeSpawnCounts()).toEqual({});
});

// Speed audit 14/11: every command forked the ~1 GB API (77-170 ms of blocked event loop); buffered commands run in a small helper.
it("runs buffered commands in the exec helper with execFile's results, errors and env", async () => {
  const run = promisify(execFile);
  const printParent = ["-e", "process.stdout.write(String(process.ppid))"];
  expect((await run(process.execPath, printParent)).stdout).toBe(String(process.pid));
  // Its own repository, so the test also runs where the tree is not a git checkout (the public export).
  const root = mkdtempSync(join(tmpdir(), "space-exec-helper-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: root });
  const helperPid = startExecHelper();
  try {
    expect(helperPid).toBeGreaterThan(0);
    takeSpawnCounts();
    expect((await run(process.execPath, printParent)).stdout).toBe(String(helperPid));
    expect(takeSpawnCounts()).toEqual({ [`helper ${process.execPath.split("/").at(-1)!}`]: 1 });
    process.env.SPACE_SESSION_SECRET = "fixture-session-secret";
    expect((await run(process.execPath, printSecret)).stdout).toBe("absent");
    expect((await run(process.execPath, printSecret, { env: { SPACE_SESSION_SECRET: "explicit" } })).stdout).toBe("explicit");
    expect((await run(process.execPath, ["-e", "process.stdout.write('raw')"], { encoding: "buffer" })).stdout).toEqual(Buffer.from("raw"));
    await expect(run(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]))
      .rejects.toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", message: expect.stringContaining("Command failed") });
    await expect(run("/nonexistent/space-exec-helper-fixture", [])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 200 })).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
    // An option that cannot cross to the helper: the command runs here as before.
    expect(execInHelper(process.execPath, printParent, { env: {}, unserializable: () => undefined })).toBeNull();
    expect(execInHelper(process.execPath, printParent, { env: {}, signal: new AbortController().signal })).toBeNull();
    expect((await run(process.execPath, printParent, { signal: new AbortController().signal })).stdout).toBe(String(process.pid));

    // Git through the helper: output, exit code, and a timeout that takes the process group.
    expect((await execGit(root, ["rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true");
    expect(await execGit(root, ["rev-parse", "--verify", "--quiet", "refs/heads/space-exec-helper-missing"])).toMatchObject({ code: 1, stdout: "" });
    // Nous's space_git (public-host lag 14/11: it forked the 1-2 GB API): its output and git's own error, both from the helper.
    expect((await nousGit(root, ["rev-parse", "--is-inside-work-tree"])).trim()).toBe("true");
    await expect(nousGit(root, ["rev-parse", "--verify", "refs/heads/space-exec-helper-missing"])).rejects.toThrow(/^git: fatal: /);
    expect(takeSpawnCounts()).toMatchObject({ "helper git rev-parse": 4 });
    await expect(execGit("/nonexistent/space-exec-helper-fixture", ["status"])).resolves.toMatchObject({ code: 128 });
    // The timeout takes the command's children too: a survivor would hold the output open for its 30 seconds.
    const started = Date.now();
    expect(await execInHelper("/bin/sh", ["-c", "sleep 30 & wait"], { env: { PATH: process.env.PATH } }, 300)).toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    await expect(execInHelper("/nonexistent/space-exec-helper-fixture", [], { env: {} }, 5_000)).resolves.toMatchObject({ error: { code: "ENOENT" }, timedOut: false });

    // The VPN broker's read-only actions through the helper: stdin in, its output, its own error, a broker that does not start.
    // An action that changes something runs here, so a profile's config never crosses to the helper.
    const echo = ["-e", "process.stdin.pipe(process.stdout)"];
    const node = process.execPath.split("/").at(-1)!;
    takeSpawnCounts();
    expect(await executeBroker(process.execPath, [...echo, "egress-status"], '{"runtimes":[]}')).toBe('{"runtimes":[]}');
    await expect(executeBroker(process.execPath, ["-e", "console.error(JSON.stringify({ code: 'NOT_CONFIGURED', message: 'No profile.' })); process.exit(2)", "status"], ""))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED", message: "No profile.", statusCode: 409 });
    await expect(executeBroker("/nonexistent/space-exec-helper-fixture", ["-n", "broker", "status"], "")).rejects.toMatchObject({ code: "BROKER_FAILED", statusCode: 503 });
    expect(await executeBroker(process.execPath, [...echo, "replace"], "config")).toBe("config");
    expect(takeSpawnCounts()).toEqual({ [`helper ${node} egress-status`]: 1, [`helper ${node} status`]: 1, "helper space-exec-helper-fixture broker status": 1, [`${node} replace`]: 1 });
  } finally {
    stopExecHelper();
    rmSync(root, { recursive: true, force: true });
  }
  expect((await run(process.execPath, printParent)).stdout).toBe(String(process.pid));
}, 30_000);
