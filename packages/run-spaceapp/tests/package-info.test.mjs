import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as packageInfo from "../src/package-info.mjs";

test("amd64 host-root launcher metadata pins the matching runtime", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(manifest.version, "0.1.15");
  assert.equal(manifest.spaceappRuntimeVersion, "0.1.15");
  assert.equal(manifest.spaceappHostRootRuntimeCompatible, true);
  assert.deepEqual(manifest.cpu, ["x64"]);
  assert.equal(packageInfo.PACKAGE_VERSION, manifest.version);
  assert.equal(packageInfo.RUNTIME_VERSION, manifest.spaceappRuntimeVersion);
  assert.equal(
    packageInfo.HOST_ROOT_RUNTIME_COMPATIBLE,
    manifest.spaceappHostRootRuntimeCompatible
  );
});
