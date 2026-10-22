import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { initializeInstallation, saveConfig } from "../src/index.mjs";
import { RUNTIME_VERSION } from "../src/package-info.mjs";
import { Readable, Writable } from "node:stream";

function output() {
  return new Writable({ write: (_chunk, _encoding, done) => done() });
}

async function existingEngine(engine) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-safety-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, engine });
  return root;
}

test("install refuses an explicit Docker-to-Podman engine switch", async () => {
  const root = await existingEngine("docker");
  try {
    await assert.rejects(() => run(["install", "--engine", "podman"], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: output(), stderr: output()
    }), /Cannot change the installed engine from docker to podman/);
    assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "docker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses an explicit Podman-to-Docker engine switch", async () => {
  const root = await existingEngine("podman");
  try {
    await assert.rejects(() => run(["install", "--engine", "docker"], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: output(), stderr: output()
    }), /Cannot change the installed engine from podman to docker/);
    assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install without engine selection preserves the existing engine", async () => {
  const root = await existingEngine("podman");
  try {
    const answers = JSON.stringify({ action: "cancel", confirm: true });
    const code = await run(["install", "--non-interactive", "--answers", answers], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: output(), stderr: output()
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).engine, "podman");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Podman rollback preserves the selected engine for pull and up", async () => {
  const root = await existingEngine("podman");
  const initialized = await initializeInstallation(root, { version: RUNTIME_VERSION, engine: "podman" });
  await saveConfig(root, { ...initialized.config, previousVersion: "1.1.6" });
  const commands = [];
  try {
    const code = await run(["rollback", "--non-interactive", "--answers", JSON.stringify({ confirm: true })], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: output(), stderr: output(),
      prepareDockerPath: async () => {},
      execute: async (spec) => { commands.push(spec); return 0; }
    });
    assert.equal(code, 0);
    assert.deepEqual(commands.filter(({ args }) => args.includes("pull") || args.includes("up")).map(({ command }) => command), ["podman", "podman"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Podman update keeps engine through pull, checkpoint, and runtime start", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-checkpoint-"));
  await initializeInstallation(root, { version: "0.1.14", profile: "light", engine: "podman" });
  const calls = [];
  const errors = [];
  try {
    const code = await run(["update", "--non-interactive", "--answers", JSON.stringify({ confirm: true })], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: output(),
      stderr: new Writable({ write: (chunk, _encoding, done) => { errors.push(chunk.toString()); done(); } }),
      prepareDockerPath: async () => {},
      inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 50 * 1024 ** 3 }),
      request: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      sleep: async () => {},
      execute: async (spec, io) => {
        calls.push(spec);
        if (spec.command === "podman" && spec.args?.[0] === "--version" && io?.stdout) io.stdout.write("podman version 5.1.0\n");
        if (spec.command === "podman" && spec.args?.[0] === "compose" && io?.stdout) io.stdout.write("podman-compose version 1.6.0\n");
        if (spec.command === "podman" && spec.args?.[0] === "info" && io?.stdout) io.stdout.write(JSON.stringify({
          host: { security: { rootless: true }, cgroupVersion: "v2", cpus: 4, memTotal: 8 * 1024 ** 3 },
          store: { graphStatus: { "Disk Available": "50GB" } }
        }));
        if (spec.args?.includes("pg_dump") && io?.stdout) io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
        return 0;
      }
    });
    assert.equal(code, 0, errors.join(""));
    assert.ok(calls.some(({ args }) => args?.includes("pull")));
    assert.ok(calls.some(({ args }) => args?.includes("up")));
    assert.ok(calls.some(({ args }) => args?.includes("pg_dump")));
    assert.ok(calls.every(({ command }) => command === "podman"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair on Podman never falls through to Docker installation", async () => {
  await assertPodmanMaintenanceUsesPodman(["repair"]);
});

test("update on Podman never falls through to Docker installation", async () => {
  await assertPodmanMaintenanceUsesPodman(["update", "1.1.8"]);
});

async function assertPodmanMaintenanceUsesPodman(commandArgs) {
  const root = await existingEngine("podman");
  let dockerSetupCalls = 0;
  try {
    const answers = JSON.stringify({ confirm: true });
    const code = await run([...commandArgs, "--non-interactive", "--answers", answers], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: output(), stderr: output(),
      prepareDockerPath: async () => {},
      ensureDocker: async () => { dockerSetupCalls += 1; return { code: 0 }; },
      execute: async (spec, io) => {
        if (spec.command === "podman" && spec.args?.[0] === "--version" && io?.stdout) io.stdout.write("podman version 5.1.0\n");
        if (spec.command === "podman" && spec.args?.[0] === "compose" && io?.stdout) io.stdout.write("podman-compose version 1.5.0\n");
        return 0;
      }
    });
    assert.equal(code, 1);
    assert.equal(dockerSetupCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("fresh Podman install diagnoses Podman on the resource-failure path", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  const stdout = [];
  const stderr = [];
  let dockerSetupCalls = 0;
  try {
    const code = await run(["install", "--engine", "podman", "--profile", "small", "--non-interactive",
      "--answers", JSON.stringify({ confirm: true, profile: "small", access: "isolated", telemetry: false, open: false })], {
      env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux", stdin: Readable.from([]),
      stdout: new Writable({ write: (chunk, _encoding, done) => { stdout.push(chunk.toString()); done(); } }),
      stderr: new Writable({ write: (chunk, _encoding, done) => { stderr.push(chunk.toString()); done(); } }),
      inspectResources: async () => ({ cpuCount: 1, totalMemoryBytes: 2 * 1024 ** 3, freeDiskBytes: 2 * 1024 ** 3 }),
      ensureDocker: async () => { dockerSetupCalls += 1; return { code: 0 }; },
      prepareDockerPath: async () => {},
      execute: async (spec, io) => {
        if (spec.command === "podman" && spec.args?.[0] === "--version" && io?.stdout) io.stdout.write("podman version 5.1.0\n");
        if (spec.command === "podman" && spec.args?.[0] === "compose" && io?.stdout) io.stdout.write("podman-compose version 1.6.0\n");
        if (spec.command === "podman" && spec.args?.[0] === "info" && io?.stdout) io.stdout.write(JSON.stringify({ host: { security: { rootless: true }, cgroupVersion: "v2" } }));
        return 0;
      }
    });
    assert.equal(code, 1);
    assert.match(stdout.join(""), /PASS Podman CLI/);
    assert.doesNotMatch(stdout.join("") + stderr.join(""), /Docker Engine: available/);
    assert.equal(dockerSetupCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows rejects explicit Podman engine selection before any engine probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-windows-podman-"));
  let probes = 0;
  try {
    await assert.rejects(() => run(["install", "--engine", "podman"], {
      env: { SPACEAPP_HOME: root }, platform: "win32", stdin: Readable.from([]), stdout: output(), stderr: output(),
      execute: async () => { probes += 1; return 0; }
    }), /Podman is not supported by the Windows launcher/);
    assert.equal(probes, 0);
    await assert.rejects(() => run(["install", "--non-interactive", "--answers", JSON.stringify({ engine: "podman", confirm: true })], {
      env: { SPACEAPP_HOME: root }, platform: "win32", stdin: Readable.from([]), stdout: output(), stderr: output(),
      execute: async () => { probes += 1; return 0; }
    }), /Podman is not supported by the Windows launcher/);
    assert.equal(probes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
