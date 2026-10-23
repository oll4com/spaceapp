import assert from "node:assert/strict";
import test from "node:test";
import { parseSmokeArgs } from "../ci-container-smoke.mjs";

test("parseSmokeArgs parses target and image correctly", () => {
  const parsed = parseSmokeArgs(["--target", "core", "--image", "spaceapp:test"]);
  assert.deepEqual(parsed, { target: "core", image: "spaceapp:test" });
});

test("parseSmokeArgs throws if arguments are missing", () => {
  assert.throws(() => parseSmokeArgs([]), /Usage: ci-container-smoke.mjs/);
  assert.throws(() => parseSmokeArgs(["--target", "core"]), /Usage: ci-container-smoke.mjs/);
});
