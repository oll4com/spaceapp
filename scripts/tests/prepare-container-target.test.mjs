import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readlink, lstat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectBrowserRuntimeFiles, normalizeCpuArch, prepareContainerTarget, resolveNodeModulesClosure } from "../prepare-container-target.mjs";

test("closure resolves nested runtime dependencies, required peers and optional platform packages", () => {
  const lockfile = { packages: {
    "packages/cli-host/node_modules/node-pty": { dependencies: { leaf: "1" }, peerDependencies: { peer: "1", tool: "1" }, peerDependenciesMeta: { tool: { optional: true } }, optionalDependencies: { absent: "1", native: "1", other: "1" } },
    "packages/cli-host/node_modules/node-pty/node_modules/leaf": {},
    "packages/cli-host/node_modules/peer": {},
    "packages/cli-host/node_modules/tool": { dev: true },
    "packages/cli-host/node_modules/native": { os: ["!darwin"], cpu: ["x64"] },
    "packages/cli-host/node_modules/other": { os: ["linux"], cpu: ["!x64"] }
  } };
  assert.deepEqual(resolveNodeModulesClosure({ target: "cli", lockfile, targetArch: "amd64" }), [
    "packages/cli-host/node_modules/native",
    "packages/cli-host/node_modules/node-pty",
    "packages/cli-host/node_modules/node-pty/node_modules/leaf",
    "packages/cli-host/node_modules/peer"
  ]);
  delete lockfile.packages["packages/cli-host/node_modules/peer"];
  assert.throws(() => resolveNodeModulesClosure({ target: "cli", lockfile }), /Missing required dependency peer/);
  assert.throws(() => normalizeCpuArch("riscv64"), /Unsupported/);
});

test("target copying preserves runtime assets and links while removing foreign native builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-target-test-"));
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "out");
  async function put(path, value) {
    const { dirname } = await import("node:path");
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), value);
  }
  try {
    await put("package.json", '{"type":"module"}');
    await put("package-lock.json", JSON.stringify({ packages: { "node_modules/node-pty": {} } }));
    await put("packages/cli-host/package.json", '{"name":"@space/cli-host","type":"module","main":"dist/index.js"}');
    await put("packages/cli-host/dist/index.js", "export const host = true;");
    await put("packages/cli-host/dist/index.d.ts", "export declare const host: boolean;");
    await put("node_modules/node-pty/package.json", '{"name":"node-pty"}');
    await put("node_modules/node-pty/prebuilds/linux-x64/pty.node", "native");
    await put("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "foreign");
    await put("node_modules/node-pty/LICENSE", "retain license");
    await put("agent-skills/example/SKILL.md", "runtime skill");
    const result = await prepareContainerTarget({ sourceRoot, outputRoot, target: "cli", targetArch: "amd64" });
    assert.equal(result.packageCount, 1);
    assert.equal(await readlink(join(result.destination, "node_modules/@space/cli-host")), "../../packages/cli-host");
    assert.equal(await readFile(join(result.destination, "node_modules/node-pty/LICENSE"), "utf8"), "retain license");
    assert.equal(await readFile(join(result.destination, "agent-skills/example/SKILL.md"), "utf8"), "runtime skill");
    await assert.rejects(lstat(join(result.destination, "packages/cli-host/dist/index.d.ts")), { code: "ENOENT" });
    await assert.rejects(lstat(join(result.destination, "node_modules/node-pty/prebuilds/darwin-arm64")), { code: "ENOENT" });
    await assert.rejects(prepareContainerTarget({ sourceRoot, outputRoot: sourceRoot, target: "cli" }), /outside/);
    await assert.rejects(prepareContainerTarget({ sourceRoot, outputRoot: "/", target: "cli" }), /outside/);
    await symlink(sourceRoot, join(root, "alias"));
    await assert.rejects(prepareContainerTarget({ sourceRoot, outputRoot: join(root, "alias/out"), target: "cli" }), /outside/);
    await rm(join(sourceRoot, "node_modules/node-pty"), { recursive: true });
    await assert.rejects(prepareContainerTarget({ sourceRoot, outputRoot, target: "cli" }), /not installed/);
    assert.equal(await readFile(join(sourceRoot, "packages/cli-host/dist/index.js"), "utf8"), "export const host = true;");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser graph follows lazy imports and re-exports without unrelated API files", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-browser-graph-"));
  const dist = join(root, "apps/api/dist");
  try {
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "browser-host-main.js"), 'export * from "./helper.js"; import("./lazy.js"); import "zod";');
    await writeFile(join(dist, "helper.js"), 'import "node:fs";');
    await writeFile(join(dist, "lazy.js"), "export default 1;");
    await writeFile(join(dist, "unrelated.js"), 'import "fastify";');
    const graph = await collectBrowserRuntimeFiles(root);
    assert.deepEqual(graph.externalPackages, ["zod"]);
    assert.deepEqual(graph.files.map((file) => file.split("/").at(-1)), ["browser-host-main.js", "helper.js", "lazy.js"]);
    await writeFile(join(dist, "lazy.js"), "import(process.env.MODULE);");
    await assert.rejects(collectBrowserRuntimeFiles(root), /Nonliteral/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
