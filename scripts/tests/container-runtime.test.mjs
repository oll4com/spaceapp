import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createContainerRuntime, nativeRuntimeFile } from "../container-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "container-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, content) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  };
  await put("package.json", '{"type":"module"}');
  await put("packages/cli-host/package.json", '{"name":"@space/cli-host","type":"module"}');
  await put("packages/cli-host/dist/main.js", 'import {value} from "fixture-dependency"; console.log(value);');
  await put("packages/cli-host/dist/admin-main.js", 'import "./main.js";');
  await put("node_modules/fixture-dependency/package.json", '{"name":"fixture-dependency","type":"module","exports":"./index.js"}');
  await put("node_modules/fixture-dependency/index.js", 'export {value} from "./value.js";');
  await put("node_modules/fixture-dependency/value.js", 'export const value=42;');
  await put("node_modules/fixture-dependency/LICENSE", "fixture notice");
  await put("node_modules/unused/index.js", 'throw new Error("unused");');
  await put("apps/api/dist/server.js", 'throw new Error("other service");');
  await put("deploy/docker/credential-agent.mjs", 'export const agent = true;');
  await put("agent-skills/example/SKILL.md", "fixture skill");
  return { root, put, destination: join(root, "output") };
}

test("CLI deploy directory runs independently with transitive imports, notices and assets", async (t) => {
  const { root, destination } = await fixture(t);
  await createContainerRuntime({ root, target: "cli", destination });
  // Removing the original modules proves that the copy is self-contained.
  await rm(join(root, "node_modules"), { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(destination, "packages/cli-host/dist/main.js")], { encoding: "utf8" }).trim(), "42");
  assert.equal(await readFile(join(destination, "node_modules/fixture-dependency/LICENSE"), "utf8"), "fixture notice");
  await access(join(destination, "agent-skills/example/SKILL.md"));
  await assert.rejects(access(join(destination, "apps/api/dist/server.js")));
  await assert.rejects(access(join(destination, "node_modules/unused/index.js")));
});

test("workspace links retain their relative location in the deploy directory", async (t) => {
  const { root, destination, put } = await fixture(t);
  await put("packages/helper/package.json", '{"name":"@space/helper","type":"module","exports":"./index.js"}');
  await put("packages/helper/index.js", 'export const value=7;');
  await mkdir(join(root, "node_modules/@space"), { recursive: true });
  await symlink("../../packages/helper", join(root, "node_modules/@space/helper"));
  await put("packages/cli-host/dist/main.js", 'import {value} from "@space/helper"; console.log(value);');
  await createContainerRuntime({ root, target: "cli", destination });
  assert.equal(execFileSync(process.execPath, [join(destination, "packages/cli-host/dist/main.js")], { encoding: "utf8" }).trim(), "7");
});

test("missing application imports fail packaging before an image is produced", async (t) => {
  const { root, destination, put } = await fixture(t);
  await put("packages/cli-host/dist/main.js", 'import "missing-runtime-dependency";');
  await assert.rejects(createContainerRuntime({ root, target: "cli", destination }), /missing-runtime-dependency/);
});

test("file URL dynamic imports carry their runtime module into the image", async (t) => {
  const { root, destination, put } = await fixture(t);
  await put("scripts/runtime-fixture.mjs", "export const value=19;");
  await put("packages/cli-host/dist/main.js", 'const url=new URL("../../../scripts/runtime-fixture.mjs",import.meta.url); const {value}=await import(url.href); console.log(value);');
  await createContainerRuntime({ root, target: "cli", destination });
  await rm(join(root, "scripts"), { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(destination, "packages/cli-host/dist/main.js")], { encoding: "utf8" }).trim(), "19");
});

test("unknown targets cannot silently produce an empty runtime", async () => {
  await assert.rejects(createContainerRuntime({ target: "unknown", destination: "/unused" }), /Unknown container target/);
});

test("opaque node-pty loader retains its installed native asset and rejects missing builds", async (t) => {
  const { root, destination, put } = await fixture(t);
  await put("packages/cli-host/dist/main.js", 'import "node-pty";');
  await put("node_modules/node-pty/package.json", '{"name":"node-pty","main":"index.js"}');
  await put("node_modules/node-pty/index.js", "module.exports={};");
  await assert.rejects(createContainerRuntime({ root, target: "cli", destination }), /Missing installed node-pty/);
  await put("node_modules/node-pty/build/Release/pty.node", "native fixture");
  await put("node_modules/node-pty/prebuilds/unrelated/pty.node", "wrong platform");
  await createContainerRuntime({ root, target: "cli", destination });
  assert.equal(await readFile(join(destination, "node_modules/node-pty/build/Release/pty.node"), "utf8"), "native fixture");
  await assert.rejects(access(join(destination, "node_modules/node-pty/prebuilds/unrelated/pty.node")));
});

test("native dependencies retain each Debian target and exclude incompatible binaries", () => {
  for (const arch of ["x64", "arm64"]) {
    for (const candidate of ["x64", "arm64"]) {
      const rust = candidate === "x64" ? "x86_64" : "aarch64";
      assert.equal(nativeRuntimeFile(`node_modules/@temporalio/core-bridge/releases/${rust}-unknown-linux-gnu/index.node`, "linux", arch, true), candidate === arch);
      assert.equal(nativeRuntimeFile(`node_modules/@swc/core-linux-${candidate}-gnu/swc.node`, "linux", arch, true), candidate === arch);
      assert.equal(nativeRuntimeFile(`node_modules/@swc/core-linux-${candidate}-musl/swc.node`, "linux", arch, true), false);
      assert.equal(nativeRuntimeFile(`node_modules/@napi-rs/canvas-linux-${candidate}-gnu/canvas.node`, "linux", arch, true), candidate === arch);
      assert.equal(nativeRuntimeFile(`node_modules/@napi-rs/canvas-linux-${candidate}-musl/canvas.node`, "linux", arch, true), false);
    }
    assert.equal(nativeRuntimeFile("node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin/index.node", "linux", arch, true), false);
    assert.equal(nativeRuntimeFile("node_modules/@temporalio/core-bridge/LICENSE", "linux", arch, true), true);
    assert.equal(nativeRuntimeFile("node_modules/@swc/core/binding.js", "linux", arch, true), true);
  }
  assert.equal(nativeRuntimeFile("node_modules/@swc/core-darwin-arm64/swc.node", "darwin", "arm64", false), true);
});
