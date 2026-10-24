import assert from "node:assert/strict";
import test from "node:test";
import { parseSmokeArgs } from "../ci-container-smoke.mjs";

test("parseSmokeArgs parses target and image parameters", () => {
  const result = parseSmokeArgs(["--target", "core", "--image", "spaceapp-ci:core-amd64"]);
  assert.equal(result.target, "core");
  assert.equal(result.image, "spaceapp-ci:core-amd64");
});

test("parseSmokeArgs throws when required flags are missing", () => {
  assert.throws(() => parseSmokeArgs(["--target", "core"]), /Usage:/);
  assert.throws(() => parseSmokeArgs([]), /Usage:/);
});
