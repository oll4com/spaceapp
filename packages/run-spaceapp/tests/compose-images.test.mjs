import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { browserSeccompProfile, createDefaultConfig, renderWorkspaceCompose, userNamespacesUsable } from "../src/index.mjs";

const template = (await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const images = [...template.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((match) => match[1]);
const storageSource = await readFile(new URL("../src/storage.mjs", import.meta.url), "utf8");

test("every compose image is pinned to a version or a digest", () => {
  assert.ok(images.length >= 7);
  for (const image of images) {
    if (image.startsWith("ghcr.io/oll4com/spaceapp-")) {
      // The version tag plus the digest the published package pins (empty in a source checkout).
      const target = image.match(/^ghcr\.io\/oll4com\/spaceapp-(core|cli|browser):/)?.[1];
      assert.ok(target, image);
      assert.equal(image, `ghcr.io/oll4com/spaceapp-${target}:\${SPACEAPP_IMAGE_TAG}\${SPACEAPP_${target.toUpperCase()}_IMAGE_DIGEST:-}`);
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

test("the browser gets Chromium's sandbox and only its own profile and recording volumes (INT5-C-F3)", async () => {
  const section = (name, next) => template.slice(template.indexOf(`\n  ${name}:\n`), template.indexOf(`\n  ${next}:\n`));
  const browser = section("spaceapp-browser", "codex-lb");
  assert.match(browser, /no-new-privileges:true\n      - seccomp=\.\/seccomp-browser\.json\n/);
  assert.doesNotMatch(browser, /apparmor=|spaceapp-data/);
  const mounts = "      - spaceapp-browser-profiles:/var/lib/spaceapp/artifacts/browser-profiles\n      - spaceapp-browser-evidence:/var/lib/spaceapp/artifacts/browser-evidence\n";
  assert.ok(browser.includes(mounts));
  assert.match(browser, /browser-data-init:\n        condition: service_completed_successfully/);
  const core = section("spaceapp-core", "spaceapp-cli");
  assert.ok(core.includes(mounts));
  assert.match(core, /browser-data-init:\n        condition: service_completed_successfully/);
  assert.match(template, /\nvolumes:\n[^]*  spaceapp-browser-profiles:\n  spaceapp-browser-evidence:\n/);
  const init = section("browser-data-init", "spaceapp-browser");
  assert.match(init, /image: ghcr\.io\/oll4com\/spaceapp-core:[^\n]*\n    restart: "no"\n    user: "0:0"\n    network_mode: none/);
  assert.doesNotMatch(init, /^    profiles:|\brm\b/m);
  for (const config of [createDefaultConfig({ version: "1.2.1" }), { ...createDefaultConfig({ version: "1.2.1" }), users: [] }]) {
    assert.doesNotMatch(renderWorkspaceCompose(config), /spaceapp-browser:/);
  }
  const cli = await readFile(new URL("../templates/seccomp-cli.json", import.meta.url), "utf8");
  const profile = JSON.parse(browserSeccompProfile(cli));
  assert.deepEqual(profile.syscalls.at(-1).names, ["clone", "setns", "unshare"]);
  assert.deepEqual({ ...profile, syscalls: profile.syscalls.slice(0, -1) }, { ...JSON.parse(cli), syscalls: JSON.parse(cli).syscalls.slice(0, -1) });
  assert.throws(() => browserSeccompProfile(JSON.stringify({ syscalls: [] })), /user-namespace rule/);
});

// The one-shot copy run as written, on folders of a temporary directory, with this user's ids instead of 10001.
test("browser-data-init copies an earlier installation's browser data once and keeps it", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, mkdir, writeFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const init = template.slice(template.indexOf("\n  browser-data-init:\n"), template.indexOf("\n  spaceapp-browser:\n"));
  const script = /- >-\n((?:        .*\n)+)/.exec(init)[1].split("\n").map((line) => line.trim()).join(" ");
  const root = await mkdtemp(join(tmpdir(), "spaceapp-browser-data-init-"));
  const ids = `${process.getuid()}:${process.getgid()}`;
  const run = () => execFileSync("sh", ["-c", script.replaceAll("$$", "$").replaceAll("/var/lib/spaceapp", `${root}/data`)
    .replaceAll("/new/", `${root}/new/`).replaceAll("10001:10001", ids).replaceAll("-o 10001 -g 10001 ", "")]);
  for (const d of ["browser-profiles", "browser-evidence"]) await mkdir(join(root, "new", d), { recursive: true });
  run();
  assert.deepEqual(await readdir(join(root, "data", "artifacts")), []);
  await mkdir(join(root, "data", "artifacts", "browser-profiles", "acct"), { recursive: true });
  await writeFile(join(root, "data", "artifacts", "browser-profiles", "acct", "Cookies"), "login");
  await mkdir(join(root, "data", "artifacts", "browser-evidence"), { recursive: true });
  await writeFile(join(root, "data", "artifacts", "browser-evidence", "rec.webm"), "rec");
  run();
  assert.equal(await readFile(join(root, "new", "browser-profiles", "acct", "Cookies"), "utf8"), "login");
  assert.equal(await readFile(join(root, "new", "browser-evidence", "rec.webm"), "utf8"), "rec");
  assert.equal(await readFile(join(root, "data", "artifacts", "browser-profiles", "acct", "Cookies"), "utf8"), "login");
  await writeFile(join(root, "new", "browser-evidence", "rec.webm"), "changed since");
  run();
  assert.equal(await readFile(join(root, "new", "browser-evidence", "rec.webm"), "utf8"), "changed since");
});
