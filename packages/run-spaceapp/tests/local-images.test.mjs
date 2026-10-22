import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createLocalImagesExecutor } from "../src/local-images.mjs";

function output() {
  let value = "";
  const stream = new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } });
  return { stream, text: () => value };
}

test("local image mode skips Docker and Podman Compose pull commands", async () => {
  for (const engine of ["docker", "podman"]) {
    const calls = [];
    const out = output();
    const execute = createLocalImagesExecutor(async (spec) => { calls.push(spec); return 19; }, out.stream);
    const code = await execute({ command: engine, args: ["compose", "-f", "compose.yml", "pull"] }, {});
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
    assert.match(out.text(), /skipping registry downloads/);
  }
});

test("local image mode adds the provider-supported pull-never policy to both engines", async () => {
  for (const engine of ["docker", "podman"]) {
    const calls = [];
    const execute = createLocalImagesExecutor(async (spec, io) => { calls.push([spec, io]); return 17; }, output().stream);
    const original = { command: engine, args: ["compose", "-f", "compose.yml", "up", "-d", "spaceapp"] };
    const io = { marker: true };
    assert.equal(await execute(original, io), 17);
    assert.deepEqual(calls, [[{
      ...original,
      args: ["compose", "-f", "compose.yml", "up", "--pull", "never", "-d", "spaceapp"]
    }, io]]);
  }
});

test("local image mode leaves unrelated commands unchanged", async () => {
  const calls = [];
  const execute = createLocalImagesExecutor(async (spec) => { calls.push(spec); return 0; }, output().stream);
  const spec = { command: "podman", args: ["images"] };
  await execute(spec, null);
  assert.deepEqual(calls, [spec]);
});
