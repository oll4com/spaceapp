import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDefaultConfig, renderWorkspaceCompose, userNamespacesUsable } from "../src/index.mjs";

const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
const images = [...template.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((match) => match[1]);
const storageSource = await readFile(new URL("../src/storage.mjs", import.meta.url), "utf8");

test("every compose image is pinned to a version or a digest", () => {
  assert.ok(images.length >= 7);
  for (const image of images) {
    if (image.startsWith("ghcr.io/oll4com/spaceapp-")) {
      assert.match(image, /:\$\{SPACEAPP_IMAGE_TAG\}$/, image);
      continue;
    }
    const tag = image.split("@")[0].split(":").at(-1);
    const digest = image.includes("@sha256:");
    assert.ok(digest || /\d/.test(tag), `${image} uses a moving tag`);
    assert.notEqual(tag, "latest", image);
  }
});

test("the headroom companion is pinned to the reviewed digest", () => {
  const headroom = images.find((image) => image.startsWith("ghcr.io/oll4com/headroom-codex-lb"));
  assert.match(headroom, /@sha256:[0-9a-f]{64}$/);
  assert.ok(storageSource.includes(`"${headroom}"`), "storage plan must estimate the same companion image");
});

test("the CLI container gets the user-namespace profile only where the host allows user namespaces (F17)", async () => {
  const cli = template.slice(template.indexOf("\n  spaceapp-cli:\n"), template.indexOf("\n  spaceapp-cli:\n") + 600);
  assert.doesNotMatch(cli, /seccomp=|apparmor=/);
  const config = createDefaultConfig({ version: "1.1.7" });
  assert.match(renderWorkspaceCompose(config, { cliSandbox: true }), /  spaceapp-cli:\n    volumes: \[\]\n    security_opt:\n      - seccomp=\.\/seccomp-cli\.json\n      - apparmor=unconfined\n/);
  assert.doesNotMatch(renderWorkspaceCompose(config), /security_opt/);
  const host = (files) => (path) => path in files ? Promise.resolve(`${files[path]}\n`) : Promise.reject(new Error("ENOENT"));
  assert.equal(await userNamespacesUsable("darwin", host({})), true);
  assert.equal(await userNamespacesUsable("linux", host({ "/proc/sys/user/max_user_namespaces": "63000" })), true);
  assert.equal(await userNamespacesUsable("linux", host({ "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1" })), false);
  assert.equal(await userNamespacesUsable("linux", host({ "/proc/sys/kernel/unprivileged_userns_clone": "0" })), false);
  assert.equal(await userNamespacesUsable("linux", host({ "/proc/sys/user/max_user_namespaces": "0" })), false);
  const profile = JSON.parse(await readFile(new URL("../templates/seccomp-cli.json", import.meta.url), "utf8"));
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  const added = profile.syscalls.at(-1);
  assert.deepEqual(added.names, ["clone", "mount", "pivot_root", "setns", "umount2", "unshare"]);
  assert.equal(added.action, "SCMP_ACT_ALLOW");
  // Everything else stays denied by the default profile, e.g. bpf, keyctl and perf_event_open.
  const allowed = new Set(profile.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW" && !rule.includes?.caps).flatMap((rule) => rule.names));
  for (const name of ["bpf", "keyctl", "perf_event_open", "kexec_load"]) assert.equal(allowed.has(name), false, name);
});
