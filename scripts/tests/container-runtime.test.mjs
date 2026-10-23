import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { findInstalledPackage, prepareRuntime, productionClosure, runtimeEntrypoints, traceRuntime } from "../container-runtime.mjs";

const { build } = createRequire(new URL("../../packages/gateway/package.json", import.meta.url))("esbuild");
function fixture(context) {
  const parent = mkdtempSync(join(tmpdir(), "space-runtime-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  mkdirSync(root);
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  const pkg = (path, manifest, code = "export default null;\n") => {
    put(`${path}/package.json`, { type: "module", version: "1.0.0", main: "index.js", ...manifest });
    put(`${path}/index.js`, code);
  };
  put("package.json", { name: "fixture", version: "1.0.0", type: "module", private: true });
  put("package-lock.json", { name: "fixture", lockfileVersion: 3, packages: {} });
  return { parent, root, put, pkg };
}

test("deployed runtime executes with nested versions, optional native data and no unrelated server/tooling", async context => {
  const { parent, root, put, pkg } = fixture(context);
  put("apps/api/package.json", { name: "@space/api", type: "module" });
  const server = 'import shared from "shared"; import { call } from "@space/client/client"; export default call(shared);\n';
  put("apps/api/dist/server.js", server);
  put("packages/client/package.json", { name: "@space/client", type: "module", exports: { "./client": "./dist/client.js", ".": "./dist/server.js" }, dependencies: { "node-pty": "1.0.0", outer: "1.0.0" } });
  put("packages/client/dist/client.js", 'import outer from "outer"; export const call = value => [value, outer];\n');
  put("packages/client/dist/server.js", 'import "node-pty"; throw new Error("server must never load in the client");\n');
  pkg("node_modules/shared", { name: "shared", version: "2.0.0" }, 'export default "outer-v2";\n');
  pkg("node_modules/outer", { name: "outer", dependencies: { shared: "1.0.0" }, optionalDependencies: { "native-addon": "1.0.0", "absent-platform-addon": "1.0.0" }, peerDependencies: { typescript: "*" }, peerDependenciesMeta: { typescript: { optional: true } }, devDependencies: { "dev-tool": "*" } }, 'import shared from "shared"; export default shared;\n');
  pkg("node_modules/outer/node_modules/shared", { name: "shared" }, 'export default "inner-v1";\n');
  pkg("node_modules/native-addon", { name: "native-addon" });
  pkg("node_modules/typescript", { name: "typescript" });
  pkg("node_modules/node-pty", { name: "node-pty" }, 'throw new Error("native server package must not be loaded");\n');
  const nativePlatform = `${process.platform}-${process.arch}`;
  const otherPlatform = process.platform === "win32" ? "linux-arm64" : "win32-x64";
  put(`node_modules/native-addon/prebuilds/${nativePlatform}/native.node`, "current-native");
  put(`node_modules/native-addon/prebuilds/${otherPlatform}/native.node`, "foreign-native");
  put("node_modules/native-addon/LICENSE", "native license");
  put("node_modules/native-addon/index.js.map", "source-map-not-runtime");
  put("packages/db/migrations/0001.sql", "SELECT 1;\n");
  put("apps/web/public/brand/logo.svg", "<svg/>\n");
  put("agent-skills/example/SKILL.md", "Built-in skill\n");
  put("LICENSE", "fixture license\n");
  mkdirSync(join(root, "node_modules/@space"), { recursive: true });
  symlinkSync(join(root, "packages/client"), join(root, "node_modules/@space/client"), process.platform === "win32" ? "junction" : "dir");
  const output = join(parent, "runtime");
  const report = await prepareRuntime({ root, output, target: "core", build, entrypoints: [join(root, "apps/api/dist/server.js")] });
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `console.log(JSON.stringify((await import(${JSON.stringify(pathToFileURL(join(output, "apps/api/dist/server.js")).href)})).default))`], { encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(result), ["outer-v2", "inner-v1"]);
  assert.equal(readFileSync(join(output, "apps/api/dist/server.js"), "utf8"), server, "application code and import.meta locations stay unchanged");
  assert(!existsSync(join(output, "node_modules/node-pty")));
  assert(!existsSync(join(output, "packages/client/dist/server.js")));
  assert(!existsSync(join(output, "node_modules/typescript")));
  assert(!existsSync(join(output, "node_modules/native-addon/index.js.map")));
  assert(existsSync(join(output, `node_modules/native-addon/prebuilds/${nativePlatform}/native.node`)));
  assert(!existsSync(join(output, `node_modules/native-addon/prebuilds/${otherPlatform}`)));
  assert(existsSync(join(output, "node_modules/native-addon/LICENSE")));
  assert(existsSync(join(output, "packages/db/migrations/0001.sql")));
  assert(existsSync(join(output, "apps/web/public/brand/logo.svg")));
  assert(existsSync(join(output, "agent-skills/example/SKILL.md")));
  assert.deepEqual(report.dependencies.map(p => `${p.name}@${p.version}`).sort(), ["native-addon@1.0.0", "outer@1.0.0", "shared@1.0.0", "shared@2.0.0"]);
  const lock = JSON.parse(readFileSync(join(output, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/outer/node_modules/shared"].version, "1.0.0");
  assert(!Object.keys(lock.packages).some(path => path.includes("typescript") || path.includes("node-pty")));
});

test("production closure rejects a missing required dependency and retains required peers", context => {
  const { root, pkg } = fixture(context);
  pkg("node_modules/consumer", { name: "consumer", peerDependencies: { peer: "*" } });
  assert.throws(() => productionClosure(root, [{ name: "consumer", issuer: root }]), /Missing production dependency peer/);
  pkg("node_modules/peer", { name: "peer" });
  assert.deepEqual([...productionClosure(root, [{ name: "consumer", issuer: root }]).values()].map(p => p.name).sort(), ["consumer", "peer"]);
  assert.throws(() => productionClosure(root, [{ name: "missing", issuer: root }]), /Missing production dependency missing/);
});

test("prefix-only Node builtins such as node:sqlite are not treated as npm dependencies", async context => {
  const { root, put } = fixture(context);
  put("apps/api/package.json", { name: "@space/api", type: "module" });
  put("apps/api/dist/server.js", 'import "node:sqlite"; import "node:test";\n');
  const traced = await traceRuntime(root, [join(root, "apps/api/dist/server.js")], build);
  assert.deepEqual(traced.dependencies, []);
  assert.equal(productionClosure(root, traced.dependencies).size, 0);
});

for (const [arch, retained] of [["x64", "x86_64-unknown-linux-gnu"], ["arm64", "aarch64-unknown-linux-gnu"]]) {
  test(`Linux ${arch} runtime retains its Temporal native bridge and excludes foreign binaries`, async context => {
    const { root, parent, put, pkg } = fixture(context);
    put("entry.mjs", 'import "@temporalio/core-bridge";\n');
    pkg("node_modules/@temporalio/core-bridge", { name: "@temporalio/core-bridge" });
    const releases = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "x86_64-apple-darwin", "aarch64-apple-darwin"];
    for (const target of releases) put(`node_modules/@temporalio/core-bridge/releases/${target}/index.node`, target);
    put("node_modules/@temporalio/core-bridge/LICENSE", "native license");
    const output = join(parent, "runtime");
    await prepareRuntime({ root, output, target: "core", platform: "linux", arch, build, entrypoints: [join(root, "entry.mjs")] });
    for (const target of releases) assert.equal(existsSync(join(output, `node_modules/@temporalio/core-bridge/releases/${target}/index.node`)), target === retained);
    assert.equal(readFileSync(join(output, "node_modules/@temporalio/core-bridge/LICENSE"), "utf8"), "native license");
  });
}

test("dependency symlinks cannot copy outside the checkout", context => {
  const { parent, root } = fixture(context);
  const external = join(parent, "external");
  mkdirSync(external);
  writeFileSync(join(external, "package.json"), JSON.stringify({ name: "escape" }));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(external, join(root, "node_modules/escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => findInstalledPackage(root, root, "escape"), /escapes the source checkout/);
});

test("runtime preparation refuses existing output, overlapping paths and unbuilt entrypoints", async context => {
  const { parent, root } = fixture(context);
  const output = join(parent, "existing");
  mkdirSync(output);
  writeFileSync(join(output, "keep.txt"), "keep");
  await assert.rejects(prepareRuntime({ root, output, target: "core" }), /already exists/);
  await assert.rejects(prepareRuntime({ root, output: join(root, "runtime"), target: "core" }), /separate directory/);
  await assert.rejects(prepareRuntime({ root, output: parent, target: "core" }), /separate directory/);
  await assert.rejects(prepareRuntime({ root, output: join(parent, "unbuilt"), target: "core" }), /Build the core entrypoints/);
  assert.equal(readFileSync(join(output, "keep.txt"), "utf8"), "keep");
  assert(!existsSync(join(parent, "unbuilt")));
});

test("core entrypoints include dynamic worker and maintenance commands while excluding compiled tests", context => {
  const { root, put } = fixture(context);
  put("apps/api/dist/server.js", "");
  put("apps/api/dist/attachment-reader-worker.js", "");
  put("apps/api/dist/__tests__/example.test.js", "");
  put("apps/worker/dist/workflows.js", "");
  const entries = runtimeEntrypoints(root, "core");
  assert(entries.includes(join(root, "apps/api/dist/attachment-reader-worker.js")));
  assert(entries.includes(join(root, "apps/worker/dist/workflows.js")));
  assert(entries.includes(join(root, "scripts/rotate-owner-setup-token.mjs")));
  assert(!entries.some(path => path.includes("__tests__")));
  assert.throws(() => runtimeEntrypoints(root, "unknown"), /Unknown runtime target/);
});
