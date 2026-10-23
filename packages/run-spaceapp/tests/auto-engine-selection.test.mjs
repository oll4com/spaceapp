import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { selectAutomaticEngine } from "../src/engine-selection.mjs";

const output = () => new Writable({ write: (_chunk, _encoding, done) => done() });

for (const scenario of [
  { name: "Docker only", docker: true, podman: false, expected: "docker" },
  { name: "Podman only", docker: false, podman: true, expected: "podman" },
  { name: "both engines", docker: true, podman: true, expected: "docker" },
  { name: "neither engine is suitable", docker: false, podman: false, expected: "docker" }
]) {
  test(`automatic selection chooses safely with ${scenario.name}`, async () => {
    let checkedProfile;
    const selected = await selectAutomaticEngine({
      execute: async () => 0,
      platform: "linux",
      profile: "large",
      dockerIsReady: async () => scenario.docker,
      verifyPodmanPrerequisites: async (_execute, options) => {
        checkedProfile = options.requestedProfile;
        return { ok: scenario.podman };
      }
    });
    assert.equal(selected, scenario.expected);
    assert.equal(checkedProfile, "large");
  });
}

for (const explicit of ["--engine", "--answers"]) {
  test(`explicit Podman via ${explicit} fails closed rather than falling back to Docker`, async () => {
    const root = await mkdtemp(join(tmpdir(), "spaceapp-explicit-podman-selection-"));
    let dockerProbeCount = 0;
    let dockerSetupCount = 0;
    const execute = async (spec, io) => {
      if (spec.command === "docker" && spec.args?.[0] === "info") dockerProbeCount += 1;
      if (spec.command === "podman" && spec.args?.[0] === "--version" && io?.stdout) {
        io.stdout.write("podman version 4.9.3\n");
      }
      return 0;
    };
    const answer = { confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false };
    const args = ["install", "--non-interactive"];
    if (explicit === "--engine") {
      args.push("--engine", "podman");
    } else {
      answer.engine = "podman";
    }
    args.push("--answers", JSON.stringify(answer));
    try {
      const code = await run(args, {
        env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux",
        stdin: Readable.from([]), stdout: output(), stderr: output(), execute,
        inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 24 * 1024 ** 3, freeDiskBytes: 40 * 1024 ** 3 }),
        prepareDockerPath: async () => {},
        ensureDocker: async () => { dockerSetupCount += 1; return { code: 0 }; }
      });
      assert.equal(code, 1);
      assert.equal(dockerProbeCount, 0);
      assert.equal(dockerSetupCount, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
