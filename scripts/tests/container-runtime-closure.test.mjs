import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeClosure, runtimePathAllowed } from "../container-runtime-closure.mjs";

test("runtime closure executes independently, includes licences and leaves unused dependencies behind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-closure-"));
  const root = join(directory, "source"), destination = join(directory, "output");
  const put = async (path, content) => { const target = join(root, path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, content); };
  try {
    await put("package.json", '{"type":"module"}');
    await put("packages/cli-host/dist/main.js", 'import answer from "used"; import "node-pty"; console.log(answer);');
    await put("packages/cli-host/dist/admin-main.js", 'import "used";');
    await put("node_modules/used/package.json", '{"name":"used","main":"index.js"}');
    await put("node_modules/used/index.js", 'module.exports = 42;');
    await put("node_modules/used/LICENSE", "synthetic licence");
    await put("node_modules/node-pty/package.json", '{"name":"node-pty","main":"index.js"}');
    await put("node_modules/node-pty/index.js", 'module.exports = {};');
    const native = `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/pty.node`;
    await put(native, "synthetic native file");
    await put("node_modules/unused/package.json", '{"name":"unused"}');
    await put("agent-skills/example/SKILL.md", "synthetic skill asset");
    const report = await createRuntimeClosure({ root, target: "cli", destination });
    assert.equal(report.warnings.length, 0);
    await rm(root, { recursive: true });
    assert.equal(execFileSync(process.execPath, [join(destination, "packages/cli-host/dist/main.js")], { encoding: "utf8", cwd: destination }).trim(), "42");
    assert.equal(await readFile(join(destination, "node_modules/used/LICENSE"), "utf8"), "synthetic licence");
    assert.equal(await readFile(join(destination, native), "utf8"), "synthetic native file");
    await assert.rejects(lstat(join(destination, "node_modules/unused")), { code: "ENOENT" });
    await assert.rejects(createRuntimeClosure({ root, target: "cli", destination }), { code: "EEXIST" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("runtime paths keep native files only for their operating system and architecture", () => {
  assert.equal(runtimePathAllowed("node_modules/node-pty/prebuilds/linux-arm64/pty.node", "linux", "arm64"), true);
  assert.equal(runtimePathAllowed("node_modules/node-pty/prebuilds/linux-x64/pty.node", "linux", "arm64"), false);
  assert.equal(runtimePathAllowed("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "linux", "arm64"), false);
  assert.equal(runtimePathAllowed("apps/api/dist/server.js.map"), false);
  assert.equal(runtimePathAllowed(".dev-stack/secrets/session-secret"), false);
});
