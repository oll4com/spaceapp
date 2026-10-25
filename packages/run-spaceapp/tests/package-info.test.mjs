import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as packageInfo from "../src/package-info.mjs";

test("host launcher metadata pins the matching runtime", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(packageInfo.PACKAGE_VERSION, manifest.version);
  assert.equal(packageInfo.RUNTIME_VERSION, manifest.spaceappRuntimeVersion);
  // Launcher-only releases may disable host-root compatibility until
  // matching runtime images are rebuilt; assert consistency, not a constant.
  assert.equal(manifest.spaceappHostRootRuntimeCompatible, packageInfo.HOST_ROOT_RUNTIME_COMPATIBLE);
  assert.deepEqual(manifest.cpu, ["x64", "arm64"]);
  assert.equal(
    packageInfo.HOST_ROOT_RUNTIME_COMPATIBLE,
    manifest.spaceappHostRootRuntimeCompatible
  );
});
