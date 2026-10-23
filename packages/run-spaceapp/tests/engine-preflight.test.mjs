import assert from "node:assert/strict";
import test from "node:test";
import { ensureEnginePrerequisites } from "../src/cli.mjs";

function podmanExecutor(providerVersion) {
  return async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) io.stdout.write("podman version 5.1.0\n");
    if (spec.args?.[0] === "compose" && io?.stdout) io.stdout.write(`podman-compose version ${providerVersion}\n`);
    if (spec.args?.[0] === "info" && io?.stdout) io.stdout.write(JSON.stringify({
      host: { security: { rootless: true }, cgroupVersion: "v2" }
    }));
    return 0;
  };
}

test("Podman repair/update preflight verifies Podman and never invokes Docker setup", async () => {
  let dockerSetupCalls = 0;
  const result = await ensureEnginePrerequisites({
    engine: "podman",
    execute: podmanExecutor("1.6.0"),
    stderr: null,
    platform: "linux",
    requestedProfile: "small",
    ensureDocker: async () => { dockerSetupCalls += 1; throw new Error("Docker setup must not run"); }
  });
  assert.deepEqual(result, { code: 0, reexecuted: false });
  assert.equal(dockerSetupCalls, 0);
});

test("Podman preflight fails closed without falling back to Docker setup", async () => {
  let dockerSetupCalls = 0;
  const result = await ensureEnginePrerequisites({
    engine: "podman",
    execute: podmanExecutor("1.5.0"),
    stderr: null,
    platform: "linux",
    requestedProfile: "small",
    ensureDocker: async () => { dockerSetupCalls += 1; return { code: 0 }; }
  });
  assert.deepEqual(result, { code: 1, reexecuted: false });
  assert.equal(dockerSetupCalls, 0);
});

test("Docker preflight preserves the existing Docker setup path", async () => {
  const expected = { code: 0, reexecuted: false };
  let received;
  const result = await ensureEnginePrerequisites({
    engine: "docker",
    execute: async () => 1,
    stderr: null,
    platform: "linux",
    requestedProfile: "medium",
    ensureDocker: async (options) => { received = options; return expected; },
    dockerOptions: { arch: "x64", env: {}, installArgs: { requestedProfile: "medium" } }
  });
  assert.equal(result, expected);
  assert.equal(received.platform, "linux");
  assert.equal(received.arch, "x64");
  assert.equal(received.installArgs.requestedProfile, "medium");
});
