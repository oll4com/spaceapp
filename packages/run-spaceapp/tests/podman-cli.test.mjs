import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { run, executeCommand } from "../src/cli.mjs";
import { initializeInstallation, loadConfig } from "../src/index.mjs";

const GiB = 1024 ** 3;
const podmanInfo = {
  version: { Version: "5.4.2" },
  host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], cpus: 8, memTotal: 16 * GiB },
  store: { graphRootAllocated: 100 * GiB, graphRootUsed: 10 * GiB }
};

async function fixture(t, { dockerPresent = false, info = podmanInfo } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux",
    stdin: Readable.from([]), stdout: output, stderr: output,
    prepareDockerPath: async () => {},
    ensureDocker: async () => { assert.ok(dockerPresent, "Podman installs must never install Docker"); return { code: 0 }; },
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * GiB, freeDiskBytes: 40 * GiB }),
    sleep: async () => {},
    request: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null } }),
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker" && !dockerPresent) return 127;
      const args = spec.args;
      if (args[0] === "--version") io?.stdout?.write(spec.command === "podman" ? "podman version 5.4.2" : "Docker version 27.0.0");
      else if (args[0] === "info") io?.stdout?.write(JSON.stringify(spec.command === "podman" ? info : { ServerVersion: "27.0.0", NCPU: 8, MemTotal: 16 * GiB }));
      else if (args[0] === "compose" && args[1] === "version") io?.stdout?.write("2.29.2");
      else if (args.includes("image")) return 1;
      else if (args.includes("pg_dump")) io?.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
      return 0;
    }
  };
  return { root, calls, options, text: () => text };
}
const automation = ["--non-interactive", "--answers", '{"confirm":true,"open":false,"profile":"small"}'];

for (const selection of ["flag", "answers", "automatic"]) {
  test(`Podman ${selection} install persists engine and dispatches every runtime command to Podman`, async (t) => {
    const f = await fixture(t);
    const args = selection === "flag" ? ["--engine", "podman", ...automation]
      : selection === "answers" ? ["--non-interactive", "--answers", '{"engine":"podman","confirm":true,"open":false,"profile":"small"}'] : automation;
    assert.equal(await run(["install", ...args], f.options), 0, f.text());
    assert.equal((await loadConfig(f.root)).engine, "podman");
    const compose = f.calls.filter((spec) => spec.args.includes("compose"));
    assert.ok(compose.some((spec) => spec.args.includes("up")));
    assert.ok(compose.every((spec) => spec.command === "podman"));
    assert.ok(compose.every((spec) => spec.env.PODMAN_COMPOSE_PROVIDER === "docker-compose"));
  });
}

test("a working Docker remains the default when both engines are installed", async (t) => {
  const f = await fixture(t, { dockerPresent: true });
  assert.equal(await run(["install", ...automation], f.options), 0, f.text());
  assert.equal((await loadConfig(f.root)).engine, "docker");
  assert.ok(!f.calls.some((spec) => spec.command === "podman"));
});

for (const installed of ["docker", "podman"]) {
  for (const source of ["flag", "answers"]) {
    test(`refuse switching ${installed} via ${source} before any mutation or engine command`, async (t) => {
      const f = await fixture(t);
      await initializeInstallation(f.root, { engine: installed, version: "1.1.7" });
      const before = await readFile(join(f.root, "config.json"), "utf8");
      const target = installed === "docker" ? "podman" : "docker";
      const args = source === "flag" ? ["--engine", target, ...automation]
        : ["--non-interactive", "--answers", JSON.stringify({ engine: target, confirm: true })];
      await assert.rejects(run(["install", ...args], f.options), /Cannot switch engines/);
      assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
      assert.deepEqual(f.calls, []);
    });
  }
}

test("Podman rejects host-root and unsupported engine names before writing an installation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(run(["install", "--engine", "podman", "--access", "host-root", ...automation], f.options), /host-root.*not supported.*Podman/);
  await assert.rejects(run(["install", "--engine", "nerdctl", ...automation], f.options), /Usage/);
  await assert.rejects(loadConfig(f.root), { code: "ENOENT" });
});

test("missing limit delegation fails before pulling images or committing configuration", async (t) => {
  const f = await fixture(t, { info: { ...podmanInfo, host: { ...podmanInfo.host, cgroupControllers: ["pids"] } } });
  assert.equal(await run(["install", "--engine", "podman", ...automation], f.options), 1);
  assert.match(f.text(), /FAIL.*(?:CPU|memory|limits)/i);
  assert.ok(!f.calls.some((spec) => spec.args.includes("pull")));
  await assert.rejects(loadConfig(f.root), { code: "ENOENT" });
});

for (const command of [["up"], ["down"], ["status"], ["logs"], ["backup"], ["rollback"], ["doctor", "--fix"], ["provider", "install", "opencode"], ["uninstall"], ["uninstall", "--purge-data"]]) {
  test(`saved Podman engine is used by ${command.join(" ")}`, async (t) => {
    const f = await fixture(t);
    await initializeInstallation(f.root, { engine: "podman", version: "1.1.7", profile: "small" });
    const path = join(f.root, "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...config, previousVersion: "1.1.6" }));
    assert.equal(await run([...command, "--non-interactive", "--answers", '{"confirm":true,"purgeConfirm":"DELETE"}'], f.options), 0, f.text());
    assert.ok(f.calls.some((spec) => spec.args.includes("compose")));
    assert.ok(f.calls.every((spec) => spec.command === "podman"), JSON.stringify(f.calls));
  });
}

test("Podman update checkpoint and failed-cutover recovery stay on the saved engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.6", profile: "small" });
  const execute = f.options.execute;
  f.options.execute = async (spec, io) => {
    const code = await execute(spec, io);
    return spec.args.includes("up") && !spec.args.includes("--wait") ? 17 : code;
  };
  assert.equal(await run(["update", "1.1.7", ...automation], f.options), 1);
  assert.ok(f.calls.some((spec) => spec.args.includes("pg_dump")));
  assert.ok(f.calls.every((spec) => spec.command === "podman"));
  assert.match(f.text(), /RECOVERY_REQUIRED/);
});

test("Podman workspace, doctor and support bundle preserve engine and expose sanitized facts", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.7", profile: "small" });
  const workspace = join(f.root, "project");
  await mkdir(workspace);
  assert.equal(await run(["workspace", "add", workspace], f.options), 0);
  assert.match(await readFile(join(f.root, "compose.workspaces.yml"), "utf8"), /selinux: z/);
  assert.doesNotMatch(f.text(), /sudo setfacl/);
  assert.equal(await run(["doctor"], f.options), 0, f.text());
  assert.match(f.text(), /5\.4\.2/);
  assert.match(f.text(), /rootless/i);
  const out = join(f.root, "diagnostics.json");
  assert.equal(await run(["support-bundle", "--out", out], f.options), 0);
  const bundle = JSON.parse(await readFile(out, "utf8"));
  assert.equal(bundle.engine.engine, "podman");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "v2");
  assert.equal(bundle.engine.cpuLimitsDelegated, true);
  assert.equal(bundle.engine.memoryLimitsDelegated, true);
  assert.ok(!f.calls.some((spec) => spec.command === "docker"));
});

test("Podman dispatch remains a literal executable and rejects arbitrary compose providers", async () => {
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.match(source, /case "podman": return spawn\("podman", args, options\)/);
  assert.doesNotMatch(source, /spawn\(\s*spec\.command/);
  await assert.rejects(executeCommand({ command: "podman", args: ["compose", "version"], env: { PODMAN_COMPOSE_PROVIDER: "/tmp/untrusted" } }), /untrusted command environment/);
});

test("Podman execution cannot inherit a Docker endpoint or context", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const executable = join(f.root, "podman");
  await writeFile(executable, '#!/bin/sh\nprintf "%s|%s|%s" "${DOCKER_HOST-unset}" "${DOCKER_CONTEXT-unset}" "$PODMAN_COMPOSE_PROVIDER"\n');
  await chmod(executable, 0o700);
  const previous = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  try {
    process.env.PATH = `${f.root}:${process.env.PATH}`;
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    process.env.DOCKER_CONTEXT = "production-docker";
    assert.equal(await executeCommand({ command: "podman", args: ["compose", "version"], env: { PODMAN_COMPOSE_PROVIDER: "docker-compose" } }, { stdout: f.options.stdout }), 0);
    assert.equal(f.text(), "unset|unset|docker-compose");
    assert.equal(process.env.DOCKER_CONTEXT, "production-docker", "parent environment remains unchanged");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
