import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../stage-service-images.mjs"
);

async function write(root, relative, content) {
  const file = join(root, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function makeFixture(root) {
  // Root manifests.
  await write(root, "package.json", JSON.stringify({ name: "fixture", private: true }));
  await write(root, "package-lock.json", JSON.stringify({ name: "fixture", lockfileVersion: 3 }));

  // First-party packages.
  await write(root, "packages/db/package.json", JSON.stringify({
    name: "@space/db", version: "0.0.0", main: "dist/index.js",
    dependencies: { pg: "*" }
  }));
  await write(root, "packages/db/dist/index.js", `import "pg";\nexport const db = 1;\n`);
  await write(root, "packages/db/migrations/0001_initial.sql", "create table t (id int);\n");

  await write(root, "packages/browser-host/package.json", JSON.stringify({
    name: "@space/browser-host", version: "0.0.0", main: "dist/index.js",
    dependencies: { "@space/contracts": "*" }
  }));
  await write(root, "packages/browser-host/dist/index.js", `import "@space/contracts";\n`);

  await write(root, "packages/contracts/package.json", JSON.stringify({
    name: "@space/contracts", version: "0.0.0", main: "dist/index.js",
    dependencies: { zod: "*" }
  }));
  await write(root, "packages/contracts/dist/index.js", `import "zod";\n`);

  await write(root, "packages/cli-host/package.json", JSON.stringify({
    name: "@space/cli-host", version: "0.0.0", main: "dist/index.js",
    dependencies: { "node-pty": "*" }
  }));
  await write(root, "packages/cli-host/dist/main.js", `import "node-pty";\n`);
  await write(root, "packages/cli-host/dist/index.js", `export {};\n`);

  // Apps: api (server + browser-host entrypoints), worker, web.
  await write(root, "apps/api/package.json", JSON.stringify({
    name: "@space/api", version: "0.0.0",
    dependencies: { "@space/db": "*", "@napi-rs/canvas": "*", "env-fixture": "*" }
  }));
  await write(root, "apps/api/dist/server.js",
    `import "@space/db";\nimport "@napi-rs/canvas";\nimport "env-fixture";\n`);
  await write(root, "apps/api/dist/browser-host-main.js",
    `import "@space/browser-host";\nimport "@space/db";\n`);
  await write(root, "apps/api/dist/__tests__/server.test.js", `import "vitest";\n`);

  await write(root, "apps/worker/package.json", JSON.stringify({
    name: "@space/worker", version: "0.0.0",
    dependencies: { "@temporalio/core-bridge": "*" }
  }));
  await write(root, "apps/worker/dist/worker.js", `import "@temporalio/core-bridge";\n`);

  await write(root, "apps/web/package.json", JSON.stringify({
    name: "@space/web", version: "0.0.0",
    dependencies: { "react-fixture": "*" }
  }));
  await write(root, "apps/web/server.mjs", `import http from "node:http";\n`);
  await write(root, "apps/web/dist/index.html", "<html></html>\n");

  // Skills: imported package must join the closure of skill-shipping targets.
  await write(root, "agent-skills/skill-a/scripts/run.mjs", `import "leftpad-fixture";\n`);

  // Third-party node_modules.
  const nm = (p) => join(root, "node_modules", p);
  await write(root, "node_modules/pg/package.json", JSON.stringify({ name: "pg", version: "0.0.0", main: "index.js" }));
  await write(root, "node_modules/pg/index.js", "module.exports = {};\n");
  await write(root, "node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "0.0.0", main: "index.js" }));
  await write(root, "node_modules/zod/index.js", "module.exports = {};\n");
  await write(root, "node_modules/leftpad-fixture/package.json", JSON.stringify({ name: "leftpad-fixture", version: "0.0.0", main: "index.js" }));
  await write(root, "node_modules/leftpad-fixture/index.js", "module.exports = {};\n");
  await write(root, "node_modules/react-fixture/package.json", JSON.stringify({ name: "react-fixture", version: "0.0.0", main: "index.js" }));
  await write(root, "node_modules/react-fixture/index.js", "module.exports = {};\n");
  await write(root, "node_modules/vitest/package.json", JSON.stringify({ name: "vitest", version: "0.0.0", main: "index.js" }));
  await write(root, "node_modules/vitest/index.js", "module.exports = {};\n");
  await write(root, "node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "0.0.0", main: "index.js" }));
  await write(root, "node_modules/typescript/index.js", "module.exports = {};\n");

  // A package whose typescript peer must NOT be auto-installed into images.
  await write(root, "node_modules/env-fixture/package.json", JSON.stringify({
    name: "env-fixture", version: "0.0.0", main: "index.js",
    peerDependencies: { typescript: "*" }
  }));
  await write(root, "node_modules/env-fixture/index.js", "module.exports = {};\n");

  // Canvas wrapper + both libc variants as optional dependencies.
  await write(root, "node_modules/@napi-rs/canvas/package.json", JSON.stringify({
    name: "@napi-rs/canvas", version: "0.0.0", main: "index.js",
    optionalDependencies: {
      "@napi-rs/canvas-linux-x64-gnu": "*",
      "@napi-rs/canvas-linux-x64-musl": "*"
    }
  }));
  await write(root, "node_modules/@napi-rs/canvas/index.js", "module.exports = {};\n");
  await write(root, "node_modules/@napi-rs/canvas-linux-x64-gnu/package.json", JSON.stringify({ name: "@napi-rs/canvas-linux-x64-gnu", version: "0.0.0" }));
  await write(root, "node_modules/@napi-rs/canvas-linux-x64-gnu/gnu.node", "gnu");
  await write(root, "node_modules/@napi-rs/canvas-linux-x64-musl/package.json", JSON.stringify({ name: "@napi-rs/canvas-linux-x64-musl", version: "0.0.0" }));
  await write(root, "node_modules/@napi-rs/canvas-linux-x64-musl/musl.node", "musl");

  // Temporal core bridge with every platform's release directory.
  await write(root, "node_modules/@temporalio/core-bridge/package.json", JSON.stringify({
    name: "@temporalio/core-bridge", version: "0.0.0", main: "index.js"
  }));
  await write(root, "node_modules/@temporalio/core-bridge/index.js", "module.exports = {};\n");
  for (const triple of [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc"
  ]) {
    await write(root, `node_modules/@temporalio/core-bridge/releases/${triple}/core.node`, triple);
  }

  // node-pty with prebuilds for other operating systems.
  await write(root, "node_modules/node-pty/package.json", JSON.stringify({
    name: "node-pty", version: "0.0.0", main: "lib/index.js",
    dependencies: { "node-addon-api": "*" }
  }));
  await write(root, "node_modules/node-pty/lib/index.js", "module.exports = {};\n");
  await write(root, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "x");
  await write(root, "node_modules/node-pty/prebuilds/win32-x64/pty.node", "x");
  await write(root, "node_modules/node-pty/prebuilds/linux-x64/pty.node", "x");
  await write(root, "node_modules/node-addon-api/package.json", JSON.stringify({ name: "node-addon-api", version: "0.0.0" }));
  await write(root, "node_modules/node-addon-api/index.js", "module.exports = {};\n");

  // Workspace symlinks, as npm creates them.
  for (const [link, target] of [
    ["@space/db", "../../packages/db"],
    ["@space/browser-host", "../../packages/browser-host"],
    ["@space/contracts", "../../packages/contracts"],
    ["@space/cli-host", "../../packages/cli-host"],
    ["@space/api", "../../apps/api"],
    ["@space/worker", "../../apps/worker"],
    ["@space/web", "../../apps/web"]
  ]) {
    const linkPath = nm(link);
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(target, linkPath);
  }
}

test("stage-service-images builds per-service closures with platform pruning", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "stage-fixture-"));
  const out = await mkdtemp(join(tmpdir(), "stage-out-"));
  try {
    await makeFixture(fixture);
    const env = { ...process.env, TARGETARCH: "amd64" };
    await execFileAsync(
      "node",
      [script, "--root", fixture, "--out", out],
      { env, timeout: 120_000 }
    );

    const core = (...p) => join(out, "core", ...p);
    const browser = (...p) => join(out, "browser", ...p);
    const cli = (...p) => join(out, "cli", ...p);

    // Core: full server closure, migrations, kept platform payloads.
    assert.ok(existsSync(core("apps/api/dist/server.js")));
    assert.ok(existsSync(core("packages/db/migrations/0001_initial.sql")));
    assert.ok(existsSync(core("node_modules/@napi-rs/canvas-linux-x64-gnu/gnu.node")));
    assert.ok(existsSync(core("node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/core.node")));
    assert.ok(existsSync(core("node_modules/leftpad-fixture/index.js")), "skill imports join the closure");
    assert.ok(existsSync(core("agent-skills/skill-a/scripts/run.mjs")));

    // Core: pruned payloads and non-closure packages stay out.
    assert.ok(!existsSync(core("node_modules/@napi-rs/canvas-linux-x64-musl")), "musl variant pruned on glibc");
    assert.ok(!existsSync(core("node_modules/@temporalio/core-bridge/releases/x86_64-apple-darwin")), "darwin bridge pruned");
    assert.ok(!existsSync(core("node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu")), "other-arch bridge pruned");
    assert.ok(!existsSync(core("node_modules/typescript")), "peer-only typescript is not staged");
    assert.ok(!existsSync(core("node_modules/vitest")), "test imports are not traced");
    assert.ok(!existsSync(core("apps/api/dist/__tests__")), "compiled tests are not staged");
    assert.ok(!existsSync(core("node_modules/react-fixture")), "web build inputs are not staged for core");

    // Workspace symlink is recreated with its original target.
    const linkInfo = await lstat(core("node_modules/@space/db"));
    assert.ok(linkInfo.isSymbolicLink());
    assert.equal(await readlink(core("node_modules/@space/db")), "../../packages/db");

    // Browser: only the browser-host closure — no worker, no canvas, no skills.
    assert.ok(existsSync(browser("apps/api/dist/browser-host-main.js")));
    assert.ok(existsSync(browser("apps/api/package.json")),
      "a package contributing staged files also contributes its manifest (runtime version reads)");
    assert.ok(existsSync(browser("packages/db/migrations/0001_initial.sql")));
    assert.ok(existsSync(browser("node_modules/zod/index.js")));
    assert.ok(!existsSync(browser("apps/worker/dist/worker.js")));
    assert.ok(!existsSync(browser("node_modules/@temporalio/core-bridge")));
    assert.ok(!existsSync(browser("node_modules/@napi-rs/canvas")));
    assert.ok(!existsSync(browser("agent-skills")));

    // CLI: the cli-host closure only, with other-OS prebuilds pruned.
    assert.ok(existsSync(cli("packages/cli-host/dist/main.js")));
    assert.ok(existsSync(cli("node_modules/node-pty/prebuilds/linux-x64/pty.node")));
    assert.ok(!existsSync(cli("node_modules/node-pty/prebuilds/darwin-arm64")));
    assert.ok(!existsSync(cli("node_modules/node-pty/prebuilds/win32-x64")));
    assert.ok(!existsSync(cli("node_modules/pg")));
    assert.ok(existsSync(cli("agent-skills/skill-a/scripts/run.mjs")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
