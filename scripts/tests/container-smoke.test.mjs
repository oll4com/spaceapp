import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinnedServiceImage, smokeImage } from "../container-smoke.mjs";

test("image smoke fixtures use the launcher's exact pinned service image", () => {
  const image = `pgvector/pgvector:fixture@sha256:${"a".repeat(64)}`;
  for (const newline of ["\n", "\r\n"]) {
    const compose = ["services:", "  postgres:", `    image: ${image}`, "    restart: unless-stopped", "", "  temporal:", "    image: unpinned:latest", ""].join(newline);
    assert.equal(pinnedServiceImage(compose, "postgres"), image);
    assert.throws(() => pinnedServiceImage(compose, "temporal"), /Missing digest-pinned temporal/);
  }
});

test("an early image-start failure cleans only its owned container and network and preserves the original error", async context => {
  const root = await mkdtemp(join(tmpdir(), "container-smoke-fixture-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages/run-spaceapp/templates"), { recursive: true });
  await writeFile(join(root, "packages/run-spaceapp/templates/compose.yml"), `services:\n  postgres:\n    image: postgres:test@sha256:${"a".repeat(64)}\n`);
  const original = new Error("owned fixture container failed before starting");
  const calls = [];
  const execute = async (command, args) => {
    assert.equal(command, "docker");
    calls.push(args);
    if (args[0] === "run") throw original;
    if (args[0] === "logs") throw new Error("diagnostic unavailable");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(smokeImage({ target: "core", image: "spaceapp:fixture", root, execute }), error => error === original);
  const removals = calls.filter(args => args[0] === "rm");
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0].slice(0, 3), ["rm", "--force", "--volumes"]);
  assert.match(removals[0][3], /^space-smoke-[a-f0-9]{16}-postgres$/);
  const networkCreate = calls.find(args => args[0] === "network" && args[1] === "create");
  assert(calls.some(args => args[0] === "network" && args[1] === "rm" && args[2] === networkCreate[2]));
  assert(!calls.some(args => args.includes("--all") || args.includes("prune")));
});

test("cleanup failures remain visible without losing the original startup error", async () => {
  const original = new Error("startup failed");
  const cleanup = new Error("owned container removal failed");
  const execute = async (_command, args) => {
    if (args[0] === "run") throw original;
    if (args[0] === "rm") throw cleanup;
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(smokeImage({ target: "cli", image: "spaceapp:fixture", execute }), error => {
    assert(error instanceof AggregateError);
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
});
