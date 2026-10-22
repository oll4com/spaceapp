import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createContainerDeploy } from "../container-deploy.mjs";

test("a deployed process resolves transitive imports and assets without unrelated packages", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "spaceapp-container-deploy-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "source");
  const output = join(fixture, "deploy");
  async function file(path, content) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  await file("package.json", JSON.stringify({ type: "module" }));
  await file("packages/cli-host/dist/main.js", `import { readFileSync } from 'node:fs'; import { message } from 'fixture-dep'; console.log(message + readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8'));`);
  await file("packages/cli-host/dist/prompt.txt", "asset-ok");
  await file("node_modules/fixture-dep/package.json", JSON.stringify({ name: "fixture-dep", type: "module", exports: "./index.js" }));
  await file("node_modules/fixture-dep/index.js", "export { message } from './nested.js';");
  await file("node_modules/fixture-dep/nested.js", "export const message = 'dependency-ok:';");
  await file("node_modules/unused-dev-tool/index.js", "throw new Error('must not be deployed');");
  await file("agent-skills/example/asset.mjs", "import 'not-a-service-dependency';");
  for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES/example.txt", "deploy/docker/cli-entrypoint.sh"]) {
    await file(path, "fixture license or runtime asset");
  }
  const manifest = await createContainerDeploy({ root, output, target: "cli" });
  assert.deepEqual(manifest.warnings, []);
  assert.equal(execFileSync(process.execPath, [join(output, "packages/cli-host/dist/main.js")], { encoding: "utf8" }).trim(), "dependency-ok:asset-ok");
  await assert.rejects(access(join(output, "node_modules/unused-dev-tool")), { code: "ENOENT" });
  assert.equal(await readFile(join(output, "agent-skills/example/asset.mjs"), "utf8"), "import 'not-a-service-dependency';");
  assert.ok(manifest.files.includes("THIRD_PARTY_LICENSES/example.txt"));
  await assert.rejects(createContainerDeploy({ root, output, target: "cli" }), { code: "EEXIST" });
  assert.equal(await readFile(join(output, "packages/cli-host/dist/prompt.txt"), "utf8"), "asset-ok");
});
