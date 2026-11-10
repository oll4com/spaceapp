import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const fault = vi.hoisted(() => ({ enabled: false, written: () => {}, release: Promise.resolve() }));
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    const data = args[1];
    if (!fault.enabled || typeof data !== "string" || !data.startsWith("#!/usr/bin/env node")) return fs.writeFile(...args);
    await fs.writeFile(args[0], data.slice(0, Math.floor(data.length / 2)), args[2]); fault.written(); await fault.release;
    // Complete the simulated single write; the exclusive creation happened above.
    return fs.writeFile(args[0], data, { ...(typeof args[2] === "object" ? args[2] : {}), flag: "w" });
  } };
});
import { createGitEnvironment, ProviderUrlPolicy } from "../src/source-control/providers.js";
let root: string | undefined;
afterEach(async () => { fault.enabled = false; if (root) await rm(root, { recursive: true, force: true }); });
it("keeps the previous ASKPASS executable intact while a concurrent helper write is incomplete", async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures"); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "askpass-publication-"));
  const policy = new ProviderUrlPolicy(["http://127.0.0.1:12345"]), remote = "http://127.0.0.1:12345/team/repo.git";
  const env = await createGitEnvironment(policy, root, remote, "fixture-secret", "fixture-login");
  let release!: () => void; fault.release = new Promise<void>(resolve => { release = resolve; });
  const written = new Promise<void>(resolve => { fault.written = resolve; }); fault.enabled = true;
  const preparing = createGitEnvironment(policy, root, remote, "replacement-secret", "fixture-login");
  try {
    await written;
    const result = await promisify(execFile)(process.execPath, [env.GIT_ASKPASS!, `Username for '${remote}':`], { env: { ...process.env, ...env } });
    expect(result.stdout).toBe("fixture-login");
  } finally { release(); await preparing; }
});
