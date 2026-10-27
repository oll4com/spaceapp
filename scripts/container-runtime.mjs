import { cp, lstat, mkdir, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeFileTrace, resolve as resolveDependency } from "@vercel/nft";

export const runtimeEntries = Object.freeze({
  core: [
    "apps/api/dist/server.js", "apps/worker/dist/worker.js", "apps/worker/dist/workflows.js",
    "apps/worker/dist/memory-mutation-worker.js", "apps/worker/dist/memory-maintenance-worker.js",
    "apps/worker/dist/memory-mutation-workflows.js", "apps/worker/dist/memory-maintenance-workflows.js",
    "apps/web/server.mjs", "packages/db/dist/migrate.js",
    "scripts/reset-owner-password.mjs", "scripts/rotate-owner-setup-token.mjs",
    "scripts/portable-backup.mjs", "scripts/portable-restore.mjs",
    // PDF.js creates require through process.getBuiltinModule and imports its
    // worker through a computed URL; neither dependency is statically visible.
    "node_modules/@napi-rs/canvas/index.js",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    // Temporal injects these imports into a generated webpack entrypoint.
    "node_modules/@temporalio/workflow/lib/worker-interface.js",
    "node_modules/@temporalio/workflow/lib/global-overrides.js"
  ],
  browser: ["apps/api/dist/browser-host-main.js"],
  cli: ["packages/cli-host/dist/main.js", "packages/cli-host/dist/admin-main.js"]
});

const runtimeAssets = {
  core: ["apps/web/dist", "packages/db/migrations", "apps/api/dist/databases/sqlite-worker.py", "agent-skills",
    "node_modules/pdfjs-dist/cmaps", "node_modules/pdfjs-dist/standard_fonts", "node_modules/pdfjs-dist/wasm", "node_modules/pdfjs-dist/iccs"],
  browser: [],
  cli: ["agent-skills"]
};

// nft follows native loaders conservatively and can include every shipped
// binary. These paths are selected explicitly by the dependencies' loaders.
// Docker builds run under the target architecture, on glibc Debian.
const glibcRuntime = process.platform === "linux" && Boolean(process.report.getReport().header.glibcVersionRuntime);
export function nativeRuntimeFile(file, platform = process.platform, arch = process.arch, glibc = glibcRuntime) {
  if (platform !== "linux" || !glibc || !["x64", "arm64"].includes(arch)) return true;
  const temporal = file.match(/(?:^|\/)node_modules\/@temporalio\/core-bridge\/releases\/([^/]+)\//);
  if (temporal) return temporal[1] === `${arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-gnu`;
  const swc = file.match(/(?:^|\/)node_modules\/@swc\/(core-[^/]+)\//);
  if (swc) return swc[1] === `core-linux-${arch}-gnu`;
  const canvas = file.match(/(?:^|\/)node_modules\/@napi-rs\/(canvas-[^/]+)\//);
  return !canvas || canvas[1] === `canvas-linux-${arch}-gnu`;
}

function contained(root, path) {
  const name = relative(root, path);
  if (name === ".." || name.startsWith("../") || isAbsolute(name)) {
    throw new Error(`Runtime file escapes build root: ${path}`);
  }
  return name;
}

// Preserve package notices even when a runtime does not read them itself.
async function packageNotices(root, files) {
  const packages = new Set();
  for (const file of files) {
    if (file.endsWith("/package.json")) packages.add(dirname(file));
  }
  for (const dir of packages) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.isFile() && /^(licen[cs]e|notice|copying)([.-]|$)/i.test(entry.name)) {
        files.add(join(dir, entry.name));
      }
    }
  }
}

async function nativeLoaderAssets(root, files) {
  // node-pty assembles its require path in a loop, which nft cannot resolve.
  // Retain the actual installed target binary (and macOS spawn helper), not
  // the package's other operating-system prebuilds or compilation objects.
  for (const file of [...files]) {
    if (!file.endsWith("node_modules/node-pty/package.json")) continue;
    const dir = dirname(file);
    let found = false;
    for (const folder of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
      const candidate = join(dir, folder);
      let entries;
      try { entries = await readdir(join(root, candidate), { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith(".node") || entry.name === "spawn-helper")) {
          files.add(join(candidate, entry.name));
          if (entry.name === "pty.node") found = true;
        }
      }
    }
    if (!found) throw new Error(`Missing installed node-pty native binary in ${dir}`);
  }
}

export async function createContainerRuntime({ root = process.cwd(), target, destination }) {
  if (!Object.hasOwn(runtimeEntries, target)) throw new Error(`Unknown container target: ${target}`);
  root = resolve(root);
  destination = resolve(destination);
  if (destination === root || root.startsWith(`${destination}/`)) throw new Error("Unsafe runtime destination");
  // Shell entrypoints launch these modules indirectly; trace them explicitly.
  const dockerModules = (await readdir(join(root, "deploy/docker")))
    .filter((name) => name.endsWith(".mjs")).map((name) => `deploy/docker/${name}`);
  const entries = [...runtimeEntries[target], ...dockerModules].map((file) => join(root, file));
  const { fileList, warnings } = await nodeFileTrace(entries, {
    base: root, processCwd: root, exportsOnly: true, fileIOConcurrency: 64,
    ignore: ["**/*.map", "**/.git/**", "agent-skills/**"],
    // Dynamic imports built with new URL(..., import.meta.url).href are valid
    // Node imports; normalize them before nft's filesystem resolver.
    resolve: (id, parent, job, isCjs) => resolveDependency(
      id.startsWith("file:") ? fileURLToPath(id) : id, parent, job, isCjs
    )
  });
  for (const warning of warnings) {
    if (["apps/", "packages/", "deploy/", "scripts/"].some((prefix) =>
      String(warning).includes(`loaded from ${join(root, prefix)}`))) {
      throw warning;
    }
  }
  const files = new Set([...fileList].filter((file) => nativeRuntimeFile(file)));
  files.add("package.json");
  await nativeLoaderAssets(root, files);
  await packageNotices(root, files);
  await mkdir(destination, { recursive: true });
  for (const file of [...files].sort()) {
    const source = resolve(root, file);
    const name = contained(root, source);
    const output = join(destination, name);
    const stat = await lstat(source);
    await mkdir(dirname(output), { recursive: true });
    if (stat.isSymbolicLink()) {
      const link = await readlink(source);
      contained(root, resolve(dirname(source), link));
      if (isAbsolute(link)) throw new Error(`Absolute runtime symlink: ${file}`);
      await symlink(link, output);
    } else if (stat.isFile()) {
      await cp(source, output);
    }
  }
  for (const asset of runtimeAssets[target]) {
    await cp(join(root, asset), join(destination, asset), { recursive: true });
  }
  // Warnings remain visible for review and runtime acceptance. Optional native
  // loaders can reference packages for other platforms which npm did not install.
  const manifest = { target, entries: runtimeEntries[target], files: [...files].sort(), warnings: [...warnings].map(String) };
  await writeFile(join(destination, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, destination] = process.argv.slice(2);
  if (!destination) throw new Error("Usage: container-runtime.mjs <core|browser|cli> <destination>");
  const manifest = await createContainerRuntime({ target, destination });
  console.log(JSON.stringify({ target, files: manifest.files.length, warnings: manifest.warnings }));
}
