import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInstallation, createDefaultConfig } from "../src/index.mjs";

// Nous Cloud (plan clipboard:yw_pvUb_616N): <home>/secrets/nous-cloud holds the box's Space Gateway entry and key,
// read-only in the core only; the root entrypoint copies the key 0400 for spaceapp and points the API at it.
const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const template = await read("../templates/compose.yml");
const entrypoint = await read("../../../deploy/docker/core-entrypoint.sh");
const service = (name) => template.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|^[a-z])`, "m"))?.[1] ?? "";

test("only the core mounts the Nous Cloud folder, read-only", () => {
  assert.ok(service("spaceapp-core").includes("- ./secrets/nous-cloud:/run/spaceapp-secrets/nous-cloud:ro"));
  assert.equal(template.split("./secrets/nous-cloud").length - 1, 1, "no other service mounts it");
});

test("the entrypoint drops the old key, copies it 0400 only when both files exist, and exports both names before the API starts", () => {
  const drop = entrypoint.indexOf("rm -f /opt/spaceapp/secrets/nous-cloud-gateway.key");
  const copy = entrypoint.indexOf("install -o spaceapp -g spaceapp -m 0400 /run/spaceapp-secrets/nous-cloud/gateway.key /opt/spaceapp/secrets/nous-cloud-gateway.key");
  assert.ok(drop > 0 && drop < copy);
  assert.match(entrypoint, /if \[ -f \/run\/spaceapp-secrets\/nous-cloud\/gateway-url \] && \[ -f \/run\/spaceapp-secrets\/nous-cloud\/gateway\.key \]; then/);
  const exported = entrypoint.indexOf("export SPACE_NOUS_CLOUD_GATEWAY_URL SPACE_NOUS_CLOUD_GATEWAY_KEY_FILE");
  assert.ok(copy < exported && exported < entrypoint.indexOf("exec gosu spaceapp"));
  assert.doesNotMatch(entrypoint, /SPACE_NOUS_CLOUD_GATEWAY_KEY=/, "the key value never goes into the environment");
});

test("a staged fresh install makes the Nous Cloud folder in the compose project, owner-only", async () => {
  const staged = await mkdtemp(join(tmpdir(), "spaceapp-nc-staged-"));
  const project = await mkdtemp(join(tmpdir(), "spaceapp-nc-project-"));
  await commitInstallation(staged, createDefaultConfig({ version: "0.1.0" }), { projectRoot: project });
  const info = await stat(join(project, "secrets", "nous-cloud"));
  assert.ok(info.isDirectory());
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o700);
});
