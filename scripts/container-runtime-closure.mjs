#!/usr/bin/env node
import { nodeFileTrace } from "@vercel/nft";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const runtimeEntries = Object.freeze({
  core: ["apps/api/dist/server.js", "apps/worker/dist/worker.js", "apps/worker/dist/workflows.js", "apps/web/server.mjs", "packages/db/dist/migrate.js",
    "scripts/reset-owner-password.mjs", "scripts/rotate-owner-setup-token.mjs", "scripts/portable-backup.mjs", "scripts/portable-restore.mjs"],
  browser: ["apps/api/dist/browser-host-main.js"],
  cli: ["packages/cli-host/dist/main.js", "packages/cli-host/dist/admin-main.js"]
});
const assets = {
  core: ["apps/web/dist", "packages/db/migrations", "apps/api/dist/databases/sqlite-worker.py", "scripts/cli-render-fixture.mjs", "agent-skills"],
  browser: [],
  cli: ["agent-skills"]
};

export function runtimePathAllowed(path, platform = process.platform, arch = process.arch) {
  if (/(^|\/)(?:\.git|\.dev-stack[^/]*|tests?|__tests__|coverage)(\/|$)/.test(path) || /\.(?:js|mjs|cjs|css)\.map$/.test(path)) return false;
  const prebuild = /\/prebuilds\/((?:linux|darwin|win32)-(?:x64|arm64|ia32))(?:\/|$)/.exec(path);
  if (prebuild && prebuild[1] !== `${platform}-${arch}`) return false;
  return true;
}

export async function createRuntimeClosure({ root, target, destination }) {
  root = resolve(root); destination = resolve(destination);
  if (!runtimeEntries[target]) throw new Error(`Unknown container target: ${target}`);
  // Never overwrite an existing tree or copy into the source checkout.
  if (destination === root || root.startsWith(destination + sep)) throw new Error("Closure destination overlaps the source root.");
  await mkdir(destination, { recursive: false });
  const { fileList, warnings } = await nodeFileTrace(runtimeEntries[target].map(path => join(root, path)), {
    base: root, processCwd: root, exportsOnly: true,
    // Skills are data copied below, not JavaScript for the tracer to parse.
    ignore: path => path.startsWith("agent-skills/") || !runtimePathAllowed(path), fileIOConcurrency: 64
  });
  for (const warning of warnings) console.warn(`[closure:${target}] ${warning.message}`);
  const files = new Set([...fileList].filter(path => runtimePathAllowed(path)));
  files.add("package.json");
  async function include(path) {
    const info = await lstat(join(root, path));
    if (info.isDirectory()) for (const entry of await readdir(join(root, path))) await include(join(path, entry));
    else if (runtimePathAllowed(path)) files.add(path);
  }
  for (const path of assets[target]) await include(path);
  // node-pty's runtime loader chooses its native file through a computed
  // require path. Include the host build/prebuild explicitly after tracing.
  if (files.has("node_modules/node-pty/package.json")) {
    let nativeFiles = 0;
    for (const directory of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
      for (const name of ["pty.node", "spawn-helper"]) {
        const path = `node_modules/node-pty/${directory}/${name}`;
        try { await lstat(join(root, path)); await include(path); if (name === "pty.node") nativeFiles++; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    if (!nativeFiles) throw new Error("node-pty is traced but its native runtime is missing.");
  }
  // The Temporal worker compiles workflows at startup. Its compiler resolves
  // modules dynamically; keep its complete installed production dependency
  // closure instead of assuming a trace sees every webpack plug-in.
  if (target === "core") {
    const visited = new Set();
    async function packageClosure(path) {
      if (visited.has(path)) return; visited.add(path);
      const manifest = JSON.parse(await readFile(join(root, path, "package.json"), "utf8"));
      await include(path);
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
        let candidate = path;
        for (;;) {
          const dependency = join(candidate, "node_modules", name);
          try { await lstat(join(root, dependency, "package.json")); await packageClosure(dependency); break; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          if (!candidate || candidate === ".") break;
          candidate = dirname(candidate); if (candidate === ".") candidate = "";
        }
      }
    }
    await packageClosure("node_modules/@temporalio/worker");
  }
  // Preserve the licences shipped with each included third-party package.
  const manifests = [...files].filter(path => path.includes("node_modules/") && path.endsWith("/package.json"));
  for (const path of manifests) for (const name of await readdir(join(root, dirname(path)))) {
    if (/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name)) await include(join(dirname(path), name));
  }
  const links = [];
  let bytes = 0;
  for (const path of [...files].sort()) {
    const source = resolve(root, path), output = resolve(destination, path);
    if (!source.startsWith(root + sep) || !output.startsWith(destination + sep)) throw new Error(`Unsafe trace path: ${path}`);
    const info = await lstat(source);
    if (info.isSymbolicLink()) { links.push([path, await readlink(source)]); continue; }
    if (!info.isFile()) continue;
    await mkdir(dirname(output), { recursive: true }); await copyFile(source, output); bytes += info.size;
  }
  for (const [path, link] of links) {
    const sourceTarget = resolve(dirname(join(root, path)), link);
    if (!sourceTarget.startsWith(root + sep)) throw new Error(`External symlink in runtime trace: ${path}`);
    const output = join(destination, path);
    await mkdir(dirname(output), { recursive: true });
    await symlink(relative(dirname(output), join(destination, relative(root, sourceTarget))), output);
  }
  const report = { target, platform: process.platform, arch: process.arch, files: files.size, bytes, warnings: [...warnings].map(warning => warning.message) };
  await writeFile(join(destination, "runtime-closure.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, destination] = process.argv.slice(2);
  if (!target || !destination) throw new Error("Usage: node scripts/container-runtime-closure.mjs <core|browser|cli> <new-directory>");
  await createRuntimeClosure({ root: process.cwd(), target, destination });
}
