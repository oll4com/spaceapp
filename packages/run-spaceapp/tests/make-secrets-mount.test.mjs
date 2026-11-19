import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Make app (key, IP allowlist, webhook files) in a Docker install: <home>/secrets/make, read-only in the core only,
// copied by the root entrypoint into the install root's secrets folder the API reads, owner-only for spaceapp.
const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const template = await read("../templates/compose.yml");
const entrypoint = await read("../../../deploy/docker/core-entrypoint.sh");
const service = (name) => template.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|^[a-z])`, "m"))?.[1] ?? "";
const mount = "./secrets/make:/run/spaceapp-secrets/make:ro";

test("only the core mounts the Make folder, read-only", () => {
  assert.ok(service("spaceapp-core").includes(`- ${mount}`));
  assert.equal(template.split("./secrets/make").length - 1, 1, "no other service mounts it");
});

test("the entrypoint copies only space-make-* files, 0400 for spaceapp, and drops removed ones before the API starts", () => {
  const copy = entrypoint.indexOf("for file in /run/spaceapp-secrets/make/space-make-*");
  assert.ok(copy > 0);
  assert.ok(entrypoint.indexOf("rm -f /opt/spaceapp/secrets/space-make-*") < copy);
  assert.match(entrypoint.slice(copy), /^\s*if \[ -f "\$file" \]; then install -o spaceapp -g spaceapp -m 0400 "\$file" \/opt\/spaceapp\/secrets\/; fi/m);
  assert.ok(copy < entrypoint.indexOf("exec gosu spaceapp"));
});
