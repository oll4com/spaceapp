import assert from "node:assert/strict";
import test from "node:test";
import { isRegistrySafeReleaseVersion } from "../release-version.mjs";

test("release versions use the SemVer subset that is safe as an npm version and Docker tag", () => {
  for (const version of [
    "0.1.15",
    "0.1.15-hostroot.0",
    "10.20.30-rc.1",
    "1.0.0-01alpha"
  ]) {
    assert.equal(isRegistrySafeReleaseVersion(version), true, version);
  }

  for (const version of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.0.0-alpha.01",
    "1.0.0-01",
    "1.0.0+build.123",
    "1.0.0-alpha+build.123",
    "1.0",
    "latest"
  ]) {
    assert.equal(isRegistrySafeReleaseVersion(version), false, version);
  }
});
