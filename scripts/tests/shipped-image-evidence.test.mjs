import assert from "node:assert/strict";
import test from "node:test";
import { evaluateShippedEvidence } from "../shipped-image-evidence.mjs";

const digest = (char) => `sha256:${char.repeat(64)}`;
const lock = { schemaVersion: 1, runtimeVersion: "1.1.8", images: { core: digest("a"), cli: digest("b"), browser: digest("c") } };
const platform = (runId = "41", workflowSha = "f".repeat(40)) => ({ digest: digest("e"), runId, workflowSha });
const record = (images = lock.images, built = platform()) => ({ "1.1.8": {
  runtimeVersion: "1.1.8", verifiedAt: "2026-10-24T07:00:00.000Z",
  images: Object.fromEntries(Object.entries(images).map(([target, index]) => [target, { index, platforms: { amd64: built } }]))
} });

// `docker inspect` of an installation's running containers (compose pins each image by its locked index digest).
const containers = (images = lock.images, runningState = true) => Object.entries(images).map(([target, index]) => ({
  Config: { Image: `ghcr.io/oll4com/spaceapp-${target}:1.1.8@${index}` }, State: { Running: runningState }
}));
const everywhere = { linux: containers(), windows: containers(), macos: containers() };

test("every lab platform that installed the published package ran its locked images", () => {
  assert.deepEqual(evaluateShippedEvidence(lock, { linux: record(), windows: record(), macos: record() }, everywhere), {
    ok: true, blockers: [], runtimeVersion: "1.1.8", runs: [`41@${"f".repeat(40)}`]
  });
});

test("a platform that ran other images or another version fails", () => {
  const result = evaluateShippedEvidence(lock, {
    linux: record({ ...lock.images, cli: digest("9") }),
    windows: { "1.1.7": record()["1.1.8"] },
    macos: record(lock.images, platform("42"))
  }, everywhere);
  assert.deepEqual(result.blockers, [
    `linux: cli ran ${digest("9")}, not the published ${digest("b")}.`,
    "windows: no verified install of runtime 1.1.8."
  ]);
  // A reused browser image (amd64-core-cli releases) comes from an earlier run; the runs are listed, not refused.
  assert.deepEqual(result.runs, [`41@${"f".repeat(40)}`, `42@${"f".repeat(40)}`]);
});

test("a registry-only record under one label is no install: running images and every platform are required (1.1.9 in-app review, Codex #5)", () => {
  // The record the launcher writes while it configures, before any image is pulled or started.
  const result = evaluateShippedEvidence(lock, { linux: record() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [
    "windows: no install evidence (image-attestations.json).",
    "macos: no install evidence (image-attestations.json).",
    "linux: no running-image evidence (docker inspect of its running containers).",
    "windows: no running-image evidence (docker inspect of its running containers).",
    "macos: no running-image evidence (docker inspect of its running containers)."
  ]);
  // Stopped containers, or a container from another digest, are not the published images running.
  const stopped = evaluateShippedEvidence(lock, { linux: record(), windows: record(), macos: record() }, {
    ...everywhere, linux: containers(lock.images, false), macos: containers({ ...lock.images, core: digest("9") })
  });
  assert.deepEqual(stopped.blockers, [
    ...["core", "cli", "browser"].map((target) => `linux: no running ${target} container from ghcr.io/oll4com/spaceapp-${target}:1.1.8@${lock.images[target]}.`),
    `macos: no running core container from ghcr.io/oll4com/spaceapp-core:1.1.8@${digest("a")}.`
  ]);
});
