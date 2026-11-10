import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect } from "vitest";
import { pluginsStorageRoot } from "../../src/plugins-service.js";

// Every API test file, then every test, gets its own plugins folder: the shared service's default is stable's live
// /opt/spaceapp/var/plugins. The file's folder also covers beforeAll and afterAll work outside a test.
const fileRoot = mkdtempSync(join(tmpdir(), "space-plugins-file-"));
process.env.SPACE_PLUGINS_DIR = fileRoot;
let testRoot: string;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "space-plugins-test-"));
  process.env.SPACE_PLUGINS_DIR = testRoot;
});
afterEach(() => {
  expect(pluginsStorageRoot(), "a test resolved the plugins folder under stable's var").not.toMatch(/^\/opt\/spaceapp\/var(\/|$)/);
  process.env.SPACE_PLUGINS_DIR = fileRoot;
  rmSync(testRoot, { recursive: true, force: true });
});
afterAll(() => { rmSync(fileRoot, { recursive: true, force: true }); });
