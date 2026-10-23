import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { packageMatchesPlatform, stageContainerRuntime, stageProductionDependencies } from "../stage-container-runtime.mjs";

async function fixture(context) {
  const temporary = await mkdtemp(join(tmpdir(), "spaceapp-runtime-closure-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "source");
  const destination = join(temporary, "runtime");
  await mkdir(root, { recursive: true });
  return { temporary, root, destination };
}

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function packageAt(root, path, manifest, workspace = false) {
  const directory = join(root, path);
  await json(join(directory, "package.json"), { version: "1.0.0", ...manifest });
  const entry = join(directory, workspace ? "dist/index.js" : "index.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "export const present = true;\n");
  return directory;
}

test("runtime closure keeps nested versions, installed peers and native assets without dev packages", async (context) => {
  const { root, destination } = await fixture(context);
  await packageAt(root, "packages/app", {
    name: "@space/app", dependencies: { alpha: "1", beta: "1" },
    optionalDependencies: { unavailable: "1" },
    peerDependencies: { peer: "1", absentPeer: "1" },
    peerDependenciesMeta: { absentPeer: { optional: true } },
    devDependencies: { devOnly: "1" }
  }, true);
  await writeFile(join(root, "packages/app/dist/index.d.ts"), "export declare const present: boolean;\n");
  await mkdir(join(root, "packages/app/src"));
  await writeFile(join(root, "packages/app/src/private.ts"), "not runtime code\n");
  await mkdir(join(root, "packages/app/dist/__tests__"));
  await writeFile(join(root, "packages/app/dist/__tests__/runtime.test.js"), "not runtime code\n");
  await writeFile(join(root, "packages/app/dist/inline.test.js"), "not runtime code\n");
  await packageAt(root, "node_modules/alpha", {
    name: "alpha", dependencies: { shared: "1" }, exports: { ".": "./index.js" }
  });
  await packageAt(root, "node_modules/beta", { name: "beta", dependencies: { shared: "2" } });
  await packageAt(root, "node_modules/shared", { name: "shared", version: "1.0.0" });
  await packageAt(root, "node_modules/beta/node_modules/shared", { name: "shared", version: "2.0.0" });
  await packageAt(root, "node_modules/peer", { name: "peer" });
  await packageAt(root, "node_modules/devOnly", { name: "devOnly" });
  await writeFile(join(root, "node_modules/alpha/native.node"), "fixture native asset\n");
  await writeFile(join(root, "node_modules/alpha/LICENSE"), "fixture license\n");
  await writeFile(join(root, "node_modules/alpha/index.d.ts"), "fixture dependency declaration asset\n");

  const packages = await stageProductionDependencies({ root, destination, roots: ["packages/app"] });

  assert.deepEqual(packages.filter((entry) => entry.name === "shared").map((entry) => entry.version).sort(), ["1.0.0", "2.0.0"]);
  assert.equal(await readFile(join(destination, "node_modules/alpha/native.node"), "utf8"), "fixture native asset\n");
  assert.equal(await readFile(join(destination, "node_modules/alpha/LICENSE"), "utf8"), "fixture license\n");
  await access(join(destination, "node_modules/alpha/index.d.ts"));
  await access(join(destination, "node_modules/peer/index.js"));
  await access(join(destination, "packages/app/dist/index.js"));
  await assert.rejects(access(join(destination, "node_modules/devOnly")), { code: "ENOENT" });
  await assert.rejects(access(join(destination, "packages/app/src")), { code: "ENOENT" });
  await assert.rejects(access(join(destination, "packages/app/dist/index.d.ts")), { code: "ENOENT" });
  await assert.rejects(access(join(destination, "packages/app/dist/__tests__")), { code: "ENOENT" });
  await assert.rejects(access(join(destination, "packages/app/dist/inline.test.js")), { code: "ENOENT" });
});

test("workspace links remain usable and cycles terminate", async (context) => {
  const { root, destination } = await fixture(context);
  await packageAt(root, "packages/app", { name: "@space/app", dependencies: { "@space/library": "1" } }, true);
  const library = await packageAt(root, "packages/library", { name: "@space/library", dependencies: { cyclic: "1" } }, true);
  await packageAt(root, "node_modules/cyclic", { name: "cyclic", dependencies: { "@space/library": "1" } });
  const link = join(root, "node_modules/@space/library");
  await mkdir(dirname(link), { recursive: true });
  await symlink(library, link, process.platform === "win32" ? "junction" : "dir");

  const packages = await stageProductionDependencies({ root, destination, roots: ["packages/app"] });

  assert.equal(packages.length, 3);
  assert.equal(await readFile(join(destination, "node_modules/@space/library/dist/index.js"), "utf8"), "export const present = true;\n");
});

test("missing mandatory production dependency fails instead of shipping a broken image", async (context) => {
  const { root, destination } = await fixture(context);
  await packageAt(root, "packages/app", { name: "@space/app", dependencies: { missing: "1" } }, true);
  await assert.rejects(stageProductionDependencies({ root, destination, roots: ["packages/app"] }), /Missing production dependency missing/);
});

test("service trees retain notices and core maintenance assets without shipping API code to CLI", async (context) => {
  const { temporary, root } = await fixture(context);
  await json(join(root, "package.json"), { name: "fixture", type: "module" });
  for (const notice of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await writeFile(join(root, notice), `${notice} fixture\n`);
  await packageAt(root, "apps/api", { name: "@space/api", dependencies: { apiOnly: "1" } }, true);
  await packageAt(root, "apps/worker", { name: "@space/worker" }, true);
  await packageAt(root, "packages/cli-host", { name: "@space/cli-host", dependencies: { cliOnly: "1" } }, true);
  await packageAt(root, "node_modules/apiOnly", { name: "apiOnly" });
  await packageAt(root, "node_modules/cliOnly", { name: "cliOnly" });
  await json(join(root, "apps/web/package.json"), { name: "@space/web" });
  await mkdir(join(root, "apps/web/dist"));
  await writeFile(join(root, "apps/web/dist/index.html"), "<html>fixture</html>");
  await writeFile(join(root, "apps/web/server.mjs"), "// fixture web server\n");
  await mkdir(join(root, "agent-skills"));
  await writeFile(join(root, "agent-skills/fixture.txt"), "fixture skill\n");
  await mkdir(join(root, "scripts"));
  for (const name of ["reset-owner-password", "rotate-owner-setup-token", "portable-backup", "portable-restore"]) await writeFile(join(root, `scripts/${name}.mjs`), "// fixture\n");
  const outputRoot = join(temporary, "services");

  await stageContainerRuntime({ root, outputRoot, targets: ["core", "cli"] });

  for (const target of ["core", "cli"]) {
    for (const notice of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) assert.equal(await readFile(join(outputRoot, target, notice), "utf8"), `${notice} fixture\n`);
    await access(join(outputRoot, target, "agent-skills/fixture.txt"));
  }
  await access(join(outputRoot, "core/apps/api/dist/index.js"));
  await access(join(outputRoot, "core/apps/web/dist/index.html"));
  for (const name of ["reset-owner-password", "rotate-owner-setup-token", "portable-backup", "portable-restore"]) await access(join(outputRoot, `core/scripts/${name}.mjs`));
  await access(join(outputRoot, "cli/packages/cli-host/dist/index.js"));
  await assert.rejects(access(join(outputRoot, "cli/apps")), { code: "ENOENT" });
  await assert.rejects(access(join(outputRoot, "cli/node_modules/apiOnly")), { code: "ENOENT" });
  await assert.rejects(access(join(outputRoot, "core/node_modules/cliOnly")), { code: "ENOENT" });
  await assert.rejects(stageContainerRuntime({ root, outputRoot, targets: ["core"] }), /already exists/);
});

test("dependency links cannot copy files from outside the checkout", async (context) => {
  const { temporary, root, destination } = await fixture(context);
  await packageAt(root, "packages/app", { name: "@space/app", dependencies: { external: "1" } }, true);
  const external = await packageAt(temporary, "outside", { name: "external" });
  const link = join(root, "node_modules/external");
  await mkdir(dirname(link), { recursive: true });
  await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(stageProductionDependencies({ root, destination, roots: ["packages/app"] }), /outside the repository/);
});

test("browser graph recognizes prefix-only Node builtins without resolving npm packages", async (context) => {
  const { root } = await fixture(context);
  await mkdir(join(root, "apps/api/dist"), { recursive: true });
  await writeFile(join(root, "apps/api/dist/browser-host-main.js"), 'import "node:sqlite"; import "./helper.js"; import "library/subpath";\n');
  await writeFile(join(root, "apps/api/dist/helper.js"), 'import "node:fs";\n');
  await packageAt(root, "node_modules/library", { name: "library" });
  const source = `import { browserEntrypointClosure } from ${JSON.stringify(new URL("../stage-container-runtime.mjs", import.meta.url).href)}; console.log(JSON.stringify(await browserEntrypointClosure(${JSON.stringify(root)})));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", source]);
  const graph = JSON.parse(stdout);
  assert.deepEqual(graph.files.map((path) => path.replaceAll("\\", "/")), ["apps/api/dist/browser-host-main.js", "apps/api/dist/helper.js"]);
  assert.deepEqual(graph.roots.map((path) => path.replaceAll("\\", "/")), ["node_modules/library"]);
});

test("npm platform constraints support exclusions and Linux libc", () => {
  const platform = { os: "linux", cpu: "x64", libc: "glibc" };
  assert.equal(packageMatchesPlatform({ os: ["!darwin"], cpu: ["x64"], libc: ["glibc"] }, platform), true);
  assert.equal(packageMatchesPlatform({ os: ["any", "!linux"] }, platform), false);
  assert.equal(packageMatchesPlatform({ cpu: ["arm64"] }, platform), false);
  assert.equal(packageMatchesPlatform({ libc: ["musl"] }, platform), false);
});

for (const cpu of ["x64", "arm64"]) {
  test(`runtime closure selects ${cpu} glibc optional binaries and excludes incompatible packages`, async (context) => {
    const { root, destination } = await fixture(context);
    const platform = { os: "linux", cpu, libc: "glibc" };
    const variants = [
      { name: "x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
      { name: "arm64-gnu", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
      { name: "x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
      { name: "arm64-musl", os: ["linux"], cpu: ["arm64"], libc: ["musl"] },
      { name: "darwin", os: ["darwin"], cpu: [cpu] }
    ];
    await packageAt(root, "packages/app", {
      name: "@space/app", optionalDependencies: Object.fromEntries(variants.map(({ name }) => [name, "1"]))
    }, true);
    for (const variant of variants) await packageAt(root, `node_modules/${variant.name}`, variant);
    const packages = await stageProductionDependencies({ root, destination, roots: ["packages/app"], platform });
    assert.deepEqual(packages.map(({ name }) => name).sort(), ["@space/app", `${cpu}-gnu`].sort());
    await access(join(destination, `node_modules/${cpu}-gnu/index.js`));
    for (const variant of variants.filter(({ name }) => name !== `${cpu}-gnu`)) {
      await assert.rejects(access(join(destination, "node_modules", variant.name)), { code: "ENOENT" });
    }
  });

  test(`native package staging retains ${cpu} Linux loaders and legal files without foreign binaries or build sources`, async (context) => {
    const { root, destination } = await fixture(context);
    const platform = { os: "linux", cpu, libc: "glibc" };
    const temporal = await packageAt(root, "node_modules/@temporalio/core-bridge", { name: "@temporalio/core-bridge", version: "1.24.0" });
    const pty = await packageAt(root, "node_modules/node-pty", { name: "node-pty", version: "1.1.0" });
    const expected = `${cpu === "x64" ? "x86_64" : "aarch64"}-unknown-linux-gnu`;
    for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc"]) {
      await mkdir(join(temporal, "releases", target), { recursive: true });
      await writeFile(join(temporal, "releases", target, "index.node"), `fixture ${target}`);
    }
    await mkdir(join(temporal, "lib"));
    await writeFile(join(temporal, "common.js"), "// fixture loader\n");
    await writeFile(join(temporal, "lib/index.js"), "// fixture runtime\n");
    await mkdir(join(temporal, "sdk-core/third-party"), { recursive: true });
    await writeFile(join(temporal, "sdk-core/third-party/NOTICE.txt"), "upstream legal notice\n");
    await writeFile(join(temporal, "sdk-core/third-party/build.rs"), "build source\n");
    await writeFile(join(temporal, "sdk-core/LICENSE"), "upstream license\n");
    await writeFile(join(temporal, "Cargo.lock"), "build lockfile\n");
    await mkdir(join(pty, "build/Release"), { recursive: true });
    await writeFile(join(pty, "build/Release/pty.node"), `compiled ${cpu}`);
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "win32-x64", "win32-arm64"]) {
      await mkdir(join(pty, "prebuilds", target), { recursive: true });
      await writeFile(join(pty, "prebuilds", target, "pty.node"), `fixture ${target}`);
    }
    await writeFile(join(pty, "LICENSE"), "node-pty license\n");
    await stageProductionDependencies({ root, destination, roots: ["node_modules/@temporalio/core-bridge", "node_modules/node-pty"], platform });
    const outputTemporal = join(destination, "node_modules/@temporalio/core-bridge");
    const outputPty = join(destination, "node_modules/node-pty");
    await access(join(outputTemporal, "index.js"));
    await access(join(outputTemporal, "common.js"));
    await access(join(outputTemporal, "lib/index.js"));
    await access(join(outputTemporal, "releases", expected, "index.node"));
    for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc"].filter((target) => target !== expected)) {
      await assert.rejects(access(join(outputTemporal, "releases", target)), { code: "ENOENT" });
    }
    await access(join(outputTemporal, "sdk-core/LICENSE"));
    await access(join(outputTemporal, "sdk-core/third-party/NOTICE.txt"));
    await assert.rejects(access(join(outputTemporal, "sdk-core/third-party/build.rs")), { code: "ENOENT" });
    await assert.rejects(access(join(outputTemporal, "Cargo.lock")), { code: "ENOENT" });
    await access(join(outputPty, "build/Release/pty.node"));
    await access(join(outputPty, "prebuilds", `linux-${cpu}`, "pty.node"));
    await access(join(outputPty, "LICENSE"));
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "win32-x64", "win32-arm64"].filter((target) => target !== `linux-${cpu}`)) {
      await assert.rejects(access(join(outputPty, "prebuilds", target)), { code: "ENOENT" });
    }
  });
}

test("mandatory incompatible dependencies and missing native binaries fail the build", async (context) => {
  const { temporary, root } = await fixture(context);
  const platform = { os: "linux", cpu: "arm64", libc: "glibc" };
  await packageAt(root, "packages/app", { name: "@space/app", dependencies: { wrong: "1" } }, true);
  await packageAt(root, "node_modules/wrong", { name: "wrong", cpu: ["x64"] });
  await assert.rejects(stageProductionDependencies({ root, destination: join(temporary, "incompatible"), roots: ["packages/app"], platform }), /incompatible/);
  await packageAt(root, "node_modules/@temporalio/core-bridge", { name: "@temporalio/core-bridge" });
  await assert.rejects(stageProductionDependencies({ root, destination: join(temporary, "temporal"), roots: ["node_modules/@temporalio/core-bridge"], platform }), /Missing Temporal native binary for aarch64-unknown-linux-gnu/);
  await packageAt(root, "node_modules/node-pty", { name: "node-pty" });
  await assert.rejects(stageProductionDependencies({ root, destination: join(temporary, "pty"), roots: ["node_modules/node-pty"], platform }), /Missing node-pty native binary for linux-arm64/);
});

test("only the pinned env-core type-only peer is omitted while runtime peers and compiler dependencies remain", async (context) => {
  const { temporary, root, destination } = await fixture(context);
  await packageAt(root, "packages/app", { name: "@space/app", dependencies: { "@t3-oss/env-core": "0.13.11" } }, true);
  const env = await packageAt(root, "node_modules/@t3-oss/env-core", {
    name: "@t3-oss/env-core", version: "0.13.11",
    peerDependencies: { typescript: ">=5", runtimePeer: "1" },
    peerDependenciesMeta: { typescript: { optional: true }, runtimePeer: { optional: true } }
  });
  await packageAt(root, "node_modules/typescript", { name: "typescript" });
  await packageAt(root, "node_modules/runtimePeer", { name: "runtimePeer" });
  await packageAt(root, "node_modules/compiler-user", { name: "compiler-user", dependencies: { typescript: "1" } });

  const packages = await stageProductionDependencies({ root, destination, roots: ["packages/app"] });
  assert.equal(packages.some(({ name }) => name === "typescript"), false);
  await assert.rejects(access(join(destination, "node_modules/typescript")), { code: "ENOENT" });
  await access(join(destination, "node_modules/runtimePeer/index.js"));

  const compilerDestination = join(temporary, "compiler-runtime");
  await stageProductionDependencies({ root, destination: compilerDestination, roots: ["packages/app", "node_modules/compiler-user"] });
  await access(join(compilerDestination, "node_modules/typescript/index.js"));

  const manifest = JSON.parse(await readFile(join(env, "package.json"), "utf8"));
  manifest.version = "0.13.12";
  await json(join(env, "package.json"), manifest);
  const futureDestination = join(temporary, "future-env-runtime");
  await stageProductionDependencies({ root, destination: futureDestination, roots: ["packages/app"] });
  await access(join(futureDestination, "node_modules/typescript/index.js"));
});
