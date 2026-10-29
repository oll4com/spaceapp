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

test("every lab platform that installed the published package ran its locked images", () => {
  assert.deepEqual(evaluateShippedEvidence(lock, { linux: record(), windows: record(), macos: record() }), {
    ok: true, blockers: [], runtimeVersion: "1.1.8", runs: [`41@${"f".repeat(40)}`]
  });
});

test("a platform that ran other images or another version fails", () => {
  const result = evaluateShippedEvidence(lock, {
    linux: record({ ...lock.images, cli: digest("9") }),
    windows: { "1.1.7": record()["1.1.8"] },
    macos: record(lock.images, platform("42"))
  });
  assert.deepEqual(result.blockers, [
    `linux: cli ran ${digest("9")}, not the published ${digest("b")}.`,
    "windows: no verified install of runtime 1.1.8."
  ]);
  // A reused browser image (amd64-core-cli releases) comes from an earlier run; the runs are listed, not refused.
  assert.deepEqual(result.runs, [`41@${"f".repeat(40)}`, `42@${"f".repeat(40)}`]);
  assert.deepEqual(evaluateShippedEvidence(lock, {}).blockers, ["No platform evidence was given."]);
});
