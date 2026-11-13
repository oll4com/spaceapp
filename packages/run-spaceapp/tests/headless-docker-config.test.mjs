import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { headlessDockerConfig, withHeadlessDockerConfig } from "../src/cli.mjs";

const env = { USERPROFILE: "C:\\Users\\a", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files" };

test("the headless Docker config keeps no credentials but still finds a per-user Docker Desktop's compose plugin", () => {
  assert.deepEqual(headlessDockerConfig(env), {
    auths: {},
    cliPluginsExtraDirs: [
      "C:\\Users\\a\\.docker\\cli-plugins",
      "C:\\Users\\a\\AppData\\Local\\Programs\\DockerDesktop\\resources\\cli-plugins",
      "C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins"
    ]
  });
  assert.equal(headlessDockerConfig({ ...env, DOCKER_CONFIG: "D:\\dc" }).cliPluginsExtraDirs[0], "D:\\dc\\cli-plugins");
});

test("Windows pulls run with --config pointing at that file; other platforms run unchanged", async () => {
  let written;
  await withHeadlessDockerConfig("win32", { command: "docker", args: ["compose", "pull"] }, async (spec) => {
    assert.equal(spec.args[0], "--config");
    assert.deepEqual(spec.args.slice(2), ["compose", "pull"]);
    written = JSON.parse(await readFile(join(spec.args[1], "config.json"), "utf8"));
    return 0;
  }, env);
  assert.deepEqual(written, headlessDockerConfig(env));
  const spec = { command: "docker", args: ["compose", "pull"] };
  await withHeadlessDockerConfig("linux", spec, async (s) => assert.equal(s, spec));
});
