import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { initializeInstallation } from "../src/index.mjs";
import { RUNTIME_VERSION } from "../src/package-info.mjs";

function output() {
  return new Writable({ write: (_chunk, _encoding, done) => done() });
}

function confirmationInput() {
  let sent = false;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: "FACTORY-RESET\n" };
        }
      };
    }
  };
}

async function assertResetKeepsEngine(engine, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-factory-reset-engine-"));
  const calls = [];
  try {
    await initializeInstallation(root, { version: RUNTIME_VERSION, engine });
    const configPath = join(root, "config.json");
    if (legacy) {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      delete config.engine;
      await writeFile(configPath, JSON.stringify(config));
    }
    const execute = async (spec, io) => {
      calls.push(spec);
      if (spec.args?.includes("pg_dump") && io?.stdout) io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      return 0;
    };
    const code = await run(["factory-reset"], {
      env: { SPACEAPP_HOME: root }, platform: "linux", stdin: confirmationInput(),
      stdout: output(), stderr: output(), execute, prepareDockerPath: async () => {}
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).engine, engine);
    const engineCalls = calls.filter(({ command }) => ["docker", "podman"].includes(command));
    assert.ok(engineCalls.some(({ args }) => args?.includes("--volumes")));
    assert.ok(engineCalls.every(({ command }) => command === engine), `unexpected engine call: ${JSON.stringify(engineCalls)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("factory reset preserves Podman and never starts Docker", async () => assertResetKeepsEngine("podman"));
test("factory reset preserves Docker", async () => assertResetKeepsEngine("docker"));
test("factory reset defaults legacy engine-less Docker config to Docker", async () => assertResetKeepsEngine("docker", true));
