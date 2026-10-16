import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { stageContainerRuntime } from "../stage-container-runtime.mjs";

/** Creates a fresh emitted monorepo with genuine installed-package layout. */
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "spaceapp-runtime-stage-"));
  const root = join(temporary, "source"), lock = { lockfileVersion: 3, packages: {} };
  /** Writes fixture files, including emitted JavaScript and runtime data. */
  async function put(filename, value) {
    const destination = join(root, filename);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, typeof value === "object" && !Buffer.isBuffer(value) ? `${JSON.stringify(value)}\n` : value);
  }
  /** Adds an installed package and its matching lock entry without running npm. */
  async function npm(location, manifest, files = {}) {
    await put(`${location}/package.json`, manifest);
    lock.packages[location] = { version: manifest.version };
    for (const [filename, contents] of Object.entries(files)) await put(`${location}/${filename}`, contents);
  }
  /** Adds a real relative workspace link and package scope. */
  async function workspace(directory, name, exports) {
    await put(`${directory}/package.json`, { name, version: "1.0.0", type: "module", exports,
      dependencies: { "unrelated-heavy": "1.0.0" } });
    const link = join(root, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(`../../${directory}`, link);
    lock.packages[`node_modules/${name}`] = { link: true, resolved: directory };
  }
  await put("package.json", { name: "synthetic-space", type: "module", workspaces: ["packages/*", "apps/*"] });
  for (const directory of ["apps", "packages"]) await mkdir(join(root, directory), { recursive: true });
  await workspace("packages/cli-host", "@space/cli-host", { ".": "./dist/index.js", "./client": { types: "./dist/client.d.ts", import: "./dist/client.js" } });
  await workspace("packages/db", "@space/db", { ".": "./dist/index.js" });
  await put("packages/cli-host/dist/client.js", 'export const clientValue = "native-free-client";\n');
  await put("packages/cli-host/dist/index.js", 'export * from "./client.js"; export * from "./host-only.js";\n');
  await put("packages/cli-host/dist/host-only.js", 'import "unrelated-heavy";\n');
  await put("packages/cli-host/dist/main.js", 'import "native-example"; export const host = "host";\n');
  await put("packages/db/dist/index.js", 'export const database = "synthetic";\n');
  await put("packages/db/dist/migrate.js", 'import "./migrations.js";\n');
  await put("packages/db/dist/migrations.js", 'export const migrationName = "0001_fixture.sql";\n');
  await put("packages/db/migrations/0001_fixture.sql", "SELECT 1;\n");
  await put("apps/api/package.json", { name: "@space/api", type: "module", dependencies: { "unrelated-heavy": "1.0.0" } });
  await put("apps/api/dist/server.js", 'export { clientValue } from "@space/cli-host/client"; export { default as tool } from "tool-example";\n');
  await put("apps/api/dist/browser-host-main.js", 'export { database } from "@space/db";\n');
  await put("apps/worker/package.json", { name: "@space/worker", type: "module" });
  await put("apps/worker/dist/worker.js", 'export const workflows = new URL("./workflows.js", import.meta.url);\n');
  await put("apps/worker/dist/workflows.js", 'export { default as native } from "native-example";\n');
  await put("apps/web/server.mjs", 'export const web = "static-web";\n');
  await put("apps/web/dist/index.html", "<!doctype html><title>synthetic</title>\n");
  for (const name of ["reset-owner-password", "rotate-owner-setup-token", "portable-backup", "portable-restore"]) await put(`scripts/${name}.mjs`, "export {};\n");
  for (const name of ["core-supervisor", "credential-agent", "provider-install", "credential-install", "opencode-first-run"]) await put(`deploy/docker/${name}.mjs`, "export {};\n");
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await put(name, "Synthetic test fixture.\n");
  await put("starter-memory/AGENTS.md", "Synthetic installation instructions.\n");
  await put("agent-skills/example/SKILL.md", "Synthetic bundled skill.\n");
  await npm("node_modules/tool-example", { name: "tool-example", version: "1.0.0", main: "index.cjs", dependencies: { shared: "2.0.0" } },
    { "index.cjs": 'module.exports = require("shared");\n' });
  await npm("node_modules/tool-example/node_modules/shared", { name: "shared", version: "2.0.0", main: "index.cjs" },
    { "index.cjs": 'module.exports = "nested-version-two";\n' });
  await npm("node_modules/shared", { name: "shared", version: "1.0.0", main: "index.cjs" },
    { "index.cjs": 'module.exports = "wrong-root-version";\n' });
  await npm("node_modules/unrelated-heavy", { name: "unrelated-heavy", version: "1.0.0", main: "index.cjs" },
    { "index.cjs": 'throw new Error("This unrelated package must not be copied or loaded");\n' });
  await npm("node_modules/native-example", { name: "native-example", version: "1.0.0", main: "index.cjs",
    optionalDependencies: { "absent-optional": "1.0.0", "foreign-optional": "1.0.0" } }, { "index.cjs": 'module.exports = "native-payload-retained";\n' });
  await npm("node_modules/foreign-optional", { name: "foreign-optional", version: "1.0.0", cpu: ["arm64"], os: ["linux"] }, { "index.js": "export {};\n" });
  /** Makes a minimal ELF header for a native-addon architecture selection test. */
  const elf = (machine) => { const bytes = Buffer.alloc(32); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(machine, 18); return bytes; };
  await put("node_modules/native-example/prebuilds/linux-x64/addon.node", elf(62));
  await put("node_modules/native-example/prebuilds/linux-arm64/addon.node", elf(183));
  await put("node_modules/native-example/prebuilds/darwin-arm64/addon.node", Buffer.from("cffaedfe00000000", "hex"));
  await put("package-lock.json", lock);
  return { temporary, root, put, lock, workspace, npm, elf, output: (target) => join(temporary, `runtime-${target}`),
    cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

/** Asserts an omitted payload really is absent from the staged filesystem. */
async function absent(filename) {
  await assert.rejects(stat(filename), { code: "ENOENT" });
}

test("core follows emitted subpaths, worker URLs and exact nested production dependencies", async () => {
  const f = await fixture();
  try {
    const output = f.output("core");
    const manifest = await stageContainerRuntime({ target: "core", sourceRoot: f.root, output, architecture: "x64" });
    const result = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(`file://${join(output, "apps/api/dist/server.js")}`)}); console.log(m.clientValue, m.tool);`], { encoding: "utf8" });
    assert.equal(result.trim(), "native-free-client nested-version-two");
    assert.ok(manifest.workspaceModules.includes("apps/worker/dist/workflows.js"));
    assert.ok(manifest.externalPackages.some((p) => p.location === "node_modules/tool-example/node_modules/shared"));
    await absent(join(output, "node_modules/shared"));
    await absent(join(output, "node_modules/unrelated-heavy"));
    await absent(join(output, "packages/cli-host/dist/host-only.js"));
    assert.equal(await readFile(join(output, "packages/db/migrations/0001_fixture.sql"), "utf8"), "SELECT 1;\n");
    assert.ok((await stat(join(output, "node_modules/native-example/prebuilds/linux-x64/addon.node"))).isFile());
    await absent(join(output, "node_modules/native-example/prebuilds/linux-arm64/addon.node"));
    await absent(join(output, "node_modules/native-example/prebuilds/darwin-arm64/addon.node"));
    await absent(join(output, "node_modules/foreign-optional"));
  } finally { await f.cleanup(); }
});

test("browser closure avoids API manifest dependencies and common assets can stay in a shared image layer", async () => {
  const f = await fixture();
  try {
    const output = f.output("browser");
    await stageContainerRuntime({ target: "browser", sourceRoot: f.root, output, architecture: "x64", sharedAssetsExternal: true });
    await absent(join(output, "node_modules/native-example"));
    await absent(join(output, "node_modules/tool-example"));
    await absent(join(output, "node_modules/unrelated-heavy"));
    await absent(join(output, "apps/web"));
    await absent(join(output, "deploy/docker"));
    await absent(join(output, "LICENSE"));
    assert.ok((await stat(join(output, "packages/db/dist/index.js"))).isFile());
  } finally { await f.cleanup(); }
});

test("cli keeps its native production dependency and bundled skills without copying API or web", async () => {
  const f = await fixture();
  try {
    const output = f.output("cli");
    await stageContainerRuntime({ target: "cli", sourceRoot: f.root, output, architecture: "x64" });
    assert.ok((await stat(join(output, "node_modules/native-example/index.cjs"))).isFile());
    assert.ok((await stat(join(output, "agent-skills/example/SKILL.md"))).isFile());
    await absent(join(output, "apps/api"));
    await absent(join(output, "apps/web"));
  } finally { await f.cleanup(); }
});

test("arm64 retains only its ELF addon and matching optional packages", async () => {
  const f = await fixture();
  try {
    const output = f.output("arm64");
    const manifest = await stageContainerRuntime({ target: "cli", sourceRoot: f.root, output, architecture: "arm64" });
    assert.ok((await stat(join(output, "node_modules/native-example/prebuilds/linux-arm64/addon.node"))).isFile());
    assert.ok((await stat(join(output, "node_modules/foreign-optional/package.json"))).isFile());
    await absent(join(output, "node_modules/native-example/prebuilds/linux-x64/addon.node"));
    await absent(join(output, "node_modules/native-example/prebuilds/darwin-arm64/addon.node"));
    assert.equal(manifest.architecture, "arm64");
  } finally { await f.cleanup(); }
});

test("literal worker and Python assets survive while a dirname URL cannot copy unrelated source", async () => {
  const f = await fixture();
  try {
    await f.put("apps/api/dist/browser-host-main.js", 'import "./asset-user.js";\n');
    await f.put("apps/api/dist/asset-user.js", 'import path from "node:path"; import {fileURLToPath} from "node:url";\n' +
      'const __dirname = path.dirname(fileURLToPath(import.meta.url)); const python = path.join(__dirname, "sqlite-worker.py");\n' +
      'const worker = new URL("./attachment-reader-worker.js", import.meta.url); const root = new URL("../../../", import.meta.url);\n' +
      'export {python, worker, root};\n');
    await f.put("apps/api/dist/sqlite-worker.py", "print('synthetic worker')\n");
    await f.put("apps/api/dist/attachment-reader-worker.js", 'export const worker = "synthetic";\n');
    await f.put("apps/api/dist/unrelated-source.js", 'throw new Error("not a runtime dependency");\n');
    const output = f.output("assets");
    const manifest = await stageContainerRuntime({ target: "browser", sourceRoot: f.root, output, architecture: "x64" });
    assert.ok(manifest.workspaceModules.includes("apps/api/dist/attachment-reader-worker.js"));
    assert.equal(await readFile(join(output, "apps/api/dist/sqlite-worker.py"), "utf8"), "print('synthetic worker')\n");
    await absent(join(output, "apps/api/dist/unrelated-source.js"));
    await absent(join(output, "packages/cli-host"));
    await absent(join(output, "node_modules/unrelated-heavy"));
  } finally { await f.cleanup(); }
});

test("missing required runtime imports fail closed rather than producing a broken smaller image", async () => {
  const f = await fixture();
  try {
    await f.put("apps/api/dist/browser-host-main.js", 'import "missing-required";\n');
    await assert.rejects(stageContainerRuntime({ target: "browser", sourceRoot: f.root, output: f.output("browser"), architecture: "x64" }), /Required runtime package missing-required/);
    await absent(f.output("browser"));
  } finally { await f.cleanup(); }
});

test("a sibling child executable based on import.meta.resolve brings its own dependency closure", async () => {
  const f = await fixture();
  try {
    await f.workspace("packages/memory-graph", "@space/memory-graph", { ".": { import: "./dist/index.js" } });
    await f.put("packages/memory-graph/dist/index.js", 'export const graph = "synthetic";\n');
    await f.put("packages/memory-graph/dist/archive-build-cli.js", 'import tool from "tool-example"; console.log(tool);\n');
    await f.put("apps/api/dist/browser-host-main.js", 'export const child = new URL("./archive-build-cli.js", import.meta.resolve("@space/memory-graph"));\n');
    await f.put("package-lock.json", f.lock);
    const output = f.output("package-child");
    const manifest = await stageContainerRuntime({ target: "browser", sourceRoot: f.root, output, architecture: "x64" });
    assert.ok(manifest.workspaceModules.includes("packages/memory-graph/dist/archive-build-cli.js"));
    const result = execFileSync(process.execPath, [join(output, "packages/memory-graph/dist/archive-build-cli.js")], { encoding: "utf8" });
    assert.equal(result.trim(), "nested-version-two");
    await absent(join(output, "node_modules/unrelated-heavy"));
  } finally { await f.cleanup(); }
});

test("required peers are retained and optional peer metadata cannot hide a required dependency", async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await readFile(join(f.root, "node_modules/native-example/package.json"), "utf8"));
    manifest.peerDependencies = { shared: "1.0.0" };
    await f.put("node_modules/native-example/package.json", manifest);
    const output = f.output("peer");
    await stageContainerRuntime({ target: "cli", sourceRoot: f.root, output, architecture: "x64" });
    assert.ok((await stat(join(output, "node_modules/shared/package.json"))).isFile());
    manifest.dependencies = { "required-overlap": "1.0.0" };
    manifest.peerDependencies["required-overlap"] = "1.0.0";
    manifest.peerDependenciesMeta = { "required-overlap": { optional: true } };
    await f.put("node_modules/native-example/package.json", manifest);
    await assert.rejects(stageContainerRuntime({ target: "cli", sourceRoot: f.root, output: f.output("overlap"), architecture: "x64" }), /Required runtime package required-overlap/);
  } finally { await f.cleanup(); }
});

test("recognized foreign native release directories omit their helper payloads too", async () => {
  const f = await fixture();
  try {
    await f.npm("node_modules/node-pty", { name: "node-pty", version: "1.0.0", main: "index.cjs" }, {
      "index.cjs": "module.exports = {};\n", "prebuilds/linux-x64/spawn-helper": "linux helper",
      "prebuilds/darwin-arm64/spawn-helper": "foreign helper"
    });
    await f.npm("node_modules/@temporalio/core-bridge", { name: "@temporalio/core-bridge", version: "1.0.0", main: "index.cjs" }, {
      "index.cjs": "module.exports = {};\n", "releases/x86_64-unknown-linux-gnu/index.node": f.elf(62),
      "releases/aarch64-unknown-linux-gnu/index.node": f.elf(183),
      "releases/aarch64-apple-darwin/helper.js": "foreign release helper",
      "releases/future-layout/README.md": "Unknown layouts are preserved rather than guessed."
    });
    await f.put("packages/cli-host/dist/main.js", 'import "node-pty"; import "@temporalio/core-bridge";\n');
    await f.put("package-lock.json", f.lock);
    const output = f.output("prebuilds");
    await stageContainerRuntime({ target: "cli", sourceRoot: f.root, output, architecture: "x64" });
    assert.ok((await stat(join(output, "node_modules/node-pty/prebuilds/linux-x64/spawn-helper"))).isFile());
    await absent(join(output, "node_modules/node-pty/prebuilds/darwin-arm64"));
    await absent(join(output, "node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu"));
    await absent(join(output, "node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin"));
    assert.ok((await stat(join(output, "node_modules/@temporalio/core-bridge/releases/future-layout/README.md"))).isFile());
  } finally { await f.cleanup(); }
});

test("installed versions must match the lock and staging never overwrites source or an existing payload", async () => {
  const f = await fixture();
  try {
    await assert.rejects(stageContainerRuntime({ target: "browser", sourceRoot: f.root, output: join(f.root, "runtime"), architecture: "x64" }), /outside the source tree/);
    const output = f.output("existing"); await mkdir(output); await writeFile(join(output, "keep.txt"), "existing data");
    await assert.rejects(stageContainerRuntime({ target: "browser", sourceRoot: f.root, output, architecture: "x64" }), /refusing to overwrite/);
    assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "existing data");
    f.lock.packages["node_modules/native-example"].version = "99.0.0";
    await f.put("package-lock.json", f.lock);
    await assert.rejects(stageContainerRuntime({ target: "cli", sourceRoot: f.root, output: f.output("cli"), architecture: "x64" }), /not the locked version/);
  } finally { await f.cleanup(); }
});
