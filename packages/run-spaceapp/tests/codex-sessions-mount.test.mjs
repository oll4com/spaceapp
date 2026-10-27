import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 1.1.7 (Nous decision 2026-10-18): the API reads Codex's session logs to see a Codex pane's turns. It gets only
// Codex's sessions/ (its own volume, read-only), never the Codex home, auth.json or any other credential.
// A Windows checkout has CRLF line endings (1.1.7 Platform matrix, windows-latest); the patterns below read LF.
const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const template = await read("../templates/compose.yml");
const credentialInstall = await read("../../../deploy/docker/credential-install.mjs");
const service = (name) => template.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|^[a-z])`, "m"))?.[1] ?? "";
const mounts = (block) => [...(block.match(/^    volumes:\n((?:      (?:- |#).*\n)+)/m)?.[1] ?? "").matchAll(/^      - (\S+)\s*$/gm)].map((match) => match[1]);
const sessions = "/var/lib/spaceapp-cli/providers/codex/sessions";

test("the API container mounts nothing of the CLI state but Codex's sessions volume, read-only", () => {
  const core = service("spaceapp-core");
  assert.ok(core, "spaceapp-core service");
  assert.doesNotMatch(core, /spaceapp-cli-state/);
  const cliData = mounts(core).filter((mount) => mount.includes("spaceapp-cli") && !mount.startsWith("spaceapp-cli-socket:"));
  assert.deepEqual(cliData, [`spaceapp-codex-sessions:${sessions}:ro`]);
});

test("Codex's auth.json lives in the Codex home root, outside the only volume the API mounts", () => {
  // credential-install.mjs writes codex's auth.json into its state root (providers/codex), not into sessions/.
  assert.match(credentialInstall, /codex:\s*\{\s*dir:\s*'\.',\s*files:\s*\['auth\.json'\]\s*\}/);
  for (const mount of mounts(service("spaceapp-core"))) {
    assert.doesNotMatch(mount, /auth\.json|imported-credentials|secrets\/providers|providers\/codex(?!\/sessions:ro$)/, mount);
  }
});

test("the CLI writes its sessions into that volume, at the path Codex uses", () => {
  const cli = mounts(service("spaceapp-cli"));
  assert.ok(cli.includes("spaceapp-cli-state:/var/lib/spaceapp-cli"));
  assert.ok(cli.includes(`spaceapp-codex-sessions:${sessions}`), "read-write for the CLI");
});

test("a one-shot init gives the volume to the CLI user and copies earlier sessions only while it is empty", () => {
  const init = service("codex-sessions-init");
  assert.match(init, /restart: "no"/);
  assert.match(init, /network_mode: none/);
  assert.match(init, /no-new-privileges:true/);
  assert.match(init, /-z "\$\$\(ls -A \/sessions\)"/);
  assert.match(init, /cp -a "\$\$old\/\." \/sessions\//);
  assert.match(init, /chown 10001:10001 \/sessions; chmod 0700 \/sessions/);
  assert.deepEqual(mounts(init), ["spaceapp-cli-state:/cli-state:ro", "spaceapp-codex-sessions:/sessions"]);
  for (const name of ["spaceapp-core", "spaceapp-cli"]) {
    assert.match(service(name), /codex-sessions-init:\n\s+condition: service_completed_successfully/, name);
  }
  assert.match(template, /^volumes:\n[\s\S]*^  spaceapp-codex-sessions:$/m);
});
