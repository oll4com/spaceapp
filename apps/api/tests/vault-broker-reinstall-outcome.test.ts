import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reinstallVaultBroker } from "../src/service-restarts.js";

// R19-1 (30/10 09:07 BKK): the reinstall ran and installed the new broker, yet the decision read "did not run: no exit status":
// systemd unloads a oneshot that succeeded, so `systemctl show` loses its invocation. Synthetic bundles only.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function harness(start: (bundle: string) => Promise<void>, shows: [string, string]) {
  const dir = await mkdtemp(join(tmpdir(), "vault-reinstall-"));
  dirs.push(dir);
  const bundle = join(dir, "broker.mjs");
  await writeFile(bundle, "// space-vault-broker 1111111111 built 2026-10-29T00:00:00Z\n");
  let show = 0;
  const run = async (command: string, args: readonly string[]) => {
    if (args[0] === "show") return { stdout: shows[show++]! };
    expect([command, ...args]).toEqual(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "start", "space-vault-broker-reinstall.service"]);
    await start(bundle);
    return { stdout: "" };
  };
  return () => reinstallVaultBroker(run, bundle);
}
const unloaded = "InvocationID=\nExecMainStatus=0";

describe("the Vault broker reinstall's outcome", () => {
  it("says the broker was rebuilt when the unit succeeded and was unloaded, and the bundle changed", async () => {
    const reinstall = await harness((bundle) => writeFile(bundle, "// space-vault-broker be219b3fb8 built 2026-10-30T02:07:00Z\n"), [unloaded, unloaded]);
    await expect(reinstall()).resolves.toMatch(/^Rebuilt the Vault broker/);
  });

  it("says nothing changed when the unit succeeded and the bundle is the same (exit 3)", async () => {
    const reinstall = await harness(async () => {}, [unloaded, unloaded]);
    await expect(reinstall()).resolves.toMatch(/already matches stable's code/);
  });

  it("reports a failed run from the unit the failure keeps loaded: the previous broker was restored (exit 1)", async () => {
    const reinstall = await harness(async () => { throw Object.assign(new Error("Job failed"), { stderr: "Job for space-vault-broker-reinstall.service failed" }); },
      [unloaded, "InvocationID=5e1c2a\nExecMainStatus=1"]);
    await expect(reinstall()).rejects.toThrow(/previous one was restored.*journalctl/);
  });

  it("says it did not run when sudo refused and no invocation appeared", async () => {
    const reinstall = await harness(async () => { throw Object.assign(new Error("exit 1"), { stderr: "sudo: a password is required" }); }, [unloaded, unloaded]);
    await expect(reinstall()).rejects.toThrow(/did not run .*sudo: a password is required/);
  });
});
