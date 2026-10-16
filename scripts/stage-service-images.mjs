#!/usr/bin/env node
/**
 * stage-service-images.mjs — assemble one production dependency closure per
 * container target (core, browser, cli) out of the monorepo build tree.
 *
 * Why this exists: the runtime images used to copy the whole /app tree into
 * every image, so the browser image shipped the Temporal worker stack and
 * the CLI image shipped the web UI's node_modules. Each target only runs a
 * small set of entrypoints, so this script traces those entrypoints and
 * stages exactly what they can load:
 *
 *   1. A static trace (import / export-from / side-effect import / require /
 *      dynamic import with a string literal) starting at the target's
 *      entrypoint files, resolved with Node's node_modules walk-up and
 *      "exports" rules.
 *   2. Every first-party (@space/* and the apps) package the trace touches
 *      is included whole (package.json + dist + declared runtime asset
 *      directories such as @space/db's migrations) and its dist files are
 *      traced too — first-party code may load siblings lazily (Temporal
 *      workflow bundles, Fastify plugins), so package-level inclusion is
 *      the safe closure for our own code. First-party packages listed in a
 *      target's package.json dependencies join the closure the same way.
 *   3. Third-party packages are copied whole (a package that is imported at
 *      all may load any of its own files lazily), and the closure expands
 *      over their package.json dependencies / optionalDependencies /
 *      peerDependencies — loaders like @napi-rs/canvas resolve their
 *      platform binary through their own package graph, not through an
 *      import the trace can see. Payloads for other platforms are then
 *      pruned: prebuilds, release binaries and optional platform packages
 *      for another OS, architecture or libc can never load on the target.
 *
 * The output mirrors the /app layout (package.json, package-lock.json,
 * node_modules/, apps/, packages/, agent-skills/ where the target uses it),
 * so the final image stages are plain COPYs of the staged tree.
 *
 * Usage: node scripts/stage-service-images.mjs [--root /app] [--out /stage]
 * The target architecture is read from TARGETARCH (amd64/arm64) when set,
 * else from the architecture of the Node.js running the build (which is the
 * target architecture under the multi-arch builders).
 */
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const ROOT = path.resolve(argValue("--root", process.cwd()));
const OUT = path.resolve(argValue("--out", "/stage"));
const ONLY_TARGETS = argValue("--targets", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TARGETARCH =
  process.env.TARGETARCH || (process.arch === "x64" ? "amd64" : process.arch);
if (!["amd64", "arm64"].includes(TARGETARCH)) {
  throw new Error(`Unsupported target architecture: ${TARGETARCH}`);
}
const TARGET_TRIPLE =
  TARGETARCH === "amd64"
    ? "x86_64-unknown-linux-gnu"
    : "aarch64-unknown-linux-gnu";

const BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")])
);

/** Runtime asset directories outside dist/ that a first-party package loads. */
const PACKAGE_ASSET_DIRS = new Map([
  // @space/db resolves migrations as <packageRoot>/migrations (src/migrations.ts).
  ["@space/db", ["migrations"]]
]);

/**
 * Entrypoints per target, plus the apps whose dist is included whole
 * (their entrypoint is spawned by path, so the trace cannot see the whole
 * surface the process may load). Paths are relative to ROOT.
 */
const TARGETS = {
  core: {
    seeds: [
      "apps/api/dist/server.js",
      "apps/worker/dist/worker.js",
      "apps/web/server.mjs"
    ],
    wholeDistApps: ["@space/api", "@space/worker", "@space/web"],
    agentSkills: true
  },
  browser: {
    seeds: ["apps/api/dist/browser-host-main.js"],
    wholeDistApps: [],
    agentSkills: false
  },
  cli: {
    seeds: ["packages/cli-host/dist/main.js"],
    wholeDistApps: ["@space/cli-host"],
    agentSkills: true
  }
};

const SPECIFIER_PATTERNS = [
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s*['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function isTestFile(file) {
  // Compiled test files live inside dist (__tests__/, *.test.js): they are
  // never loaded by a production entrypoint, and tracing them would drag
  // the dev-only test runner into the closure.
  return (
    file.split(path.sep).includes("__tests__") ||
    /\.(test|spec)\.(js|mjs|cjs)$/.test(file)
  );
}

async function listFiles(dir, predicate) {
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(full);
      } else if (entry.isFile() && predicate(full)) {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found;
}

function extractSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return specifiers;
}

async function resolveFile(candidate) {
  const attempts = [
    candidate,
    `${candidate}.js`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    `${candidate}.json`,
    path.join(candidate, "index.js"),
    path.join(candidate, "index.mjs"),
    path.join(candidate, "index.json")
  ];
  for (const attempt of attempts) {
    try {
      const info = await lstat(attempt);
      if (info.isFile()) return attempt;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function splitBareSpecifier(specifier) {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return { name: parts.slice(0, 2).join("/"), subpath: parts.slice(2).join("/") };
  }
  return { name: parts[0], subpath: parts.slice(1).join("/") };
}

function exportsTarget(entry, conditions) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) {
    for (const item of entry) {
      const resolved = exportsTarget(item, conditions);
      if (resolved) return resolved;
    }
    return null;
  }
  if (entry && typeof entry === "object") {
    for (const key of Object.keys(entry)) {
      if (key === "default" || conditions.includes(key)) {
        const resolved = exportsTarget(entry[key], conditions);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

async function resolvePackageEntry(packageDir, subpath) {
  let manifest;
  try {
    manifest = await readJson(path.join(packageDir, "package.json"));
  } catch {
    return null; // not actually a package directory (defensive)
  }
  const conditions = ["node", "import", "require", "default"];
  if (!subpath) {
    if (manifest.exports) {
      const target = exportsTarget(
        manifest.exports["."] ?? manifest.exports,
        conditions
      );
      if (target) return resolveFile(path.join(packageDir, target));
    }
    return resolveFile(path.join(packageDir, manifest.main || "index.js"));
  }
  if (manifest.exports) {
    for (const key of Object.keys(manifest.exports)) {
      if (key.includes("*")) {
        const [prefix, suffix] = key.split("*");
        const wanted = `./${subpath}`;
        if (wanted.startsWith(prefix) && wanted.endsWith(suffix || "")) {
          const star = wanted.slice(
            prefix.length,
            wanted.length - (suffix || "").length
          );
          const raw = exportsTarget(manifest.exports[key], conditions);
          if (raw) {
            const resolved = await resolveFile(
              path.join(packageDir, raw.replace("*", star))
            );
            if (resolved) return resolved;
          }
        }
      }
    }
    for (const key of [`./${subpath}`, `./${subpath}.js`, `./${subpath}/index.js`]) {
      if (manifest.exports[key]) {
        const raw = exportsTarget(manifest.exports[key], conditions);
        if (raw) {
          const resolved = await resolveFile(path.join(packageDir, raw));
          if (resolved) return resolved;
        }
      }
    }
  }
  return resolveFile(path.join(packageDir, subpath));
}

/** Find node_modules/<name> walking up from `fromDir`; returns the real dir. */
async function findPackageDir(fromDir, name) {
  let current = fromDir;
  for (;;) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    try {
      const info = await lstat(candidate);
      if (
        (info.isDirectory() || info.isSymbolicLink()) &&
        existsSync(path.join(candidate, "package.json"))
      ) {
        return await realpath(candidate);
      }
    } catch {
      /* walk up */
    }
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(ROOT)) return null;
    current = parent;
  }
}

async function loadWorkspaceMap() {
  const map = new Map(); // name -> absolute dir
  for (const parent of ["apps", "packages"]) {
    const parentDir = path.join(ROOT, parent);
    let entries = [];
    try {
      entries = await readdir(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parentDir, entry.name);
      const manifestPath = path.join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = await readJson(manifestPath);
      if (manifest.name) map.set(manifest.name, dir);
    }
  }
  return map;
}

async function traceTarget(target, workspaceMap) {
  const files = new Set(); // absolute files to copy individually
  const packageDirs = new Map(); // dir -> name (every resolved package copy)
  const wholeDistIncluded = new Set(); // first-party names included whole
  const queue = [];
  const queued = new Set();
  const enqueue = (file) => {
    if (file && !queued.has(file)) {
      queued.add(file);
      queue.push(file);
    }
  };
  for (const seed of target.seeds) enqueue(path.join(ROOT, seed));
  if (target.agentSkills) {
    // The agent runtime executes skill scripts out of /app/agent-skills and
    // resolves their imports from /app/node_modules, so the skills' own
    // imports (e.g. puppeteer-core) belong to this target's closure too.
    const skillFiles = await listFiles(path.join(ROOT, "agent-skills"), (f) =>
      /\.(js|mjs|cjs)$/.test(f)
    );
    for (const skillFile of skillFiles) enqueue(skillFile);
  }

  const includeWholeDist = async (name) => {
    if (wholeDistIncluded.has(name)) return;
    const dir = workspaceMap.get(name);
    if (!dir) return;
    wholeDistIncluded.add(name);
    packageDirs.set(dir, name);
    const distFiles = await listFiles(path.join(dir, "dist"), (f) =>
      /\.(js|mjs|cjs)$/.test(f) && !isTestFile(f)
    );
    for (const distFile of distFiles) enqueue(distFile);
    // The app's declared dependencies are part of its runtime contract
    // even when the trace cannot see an import (path-spawned entries).
    // Exception: @space/web's package.json dependencies are the SPA's
    // build inputs — Vite already bundled them into dist, and the web
    // server (apps/web/server.mjs) imports Node builtins only.
    if (name !== "@space/web") await expandPackageDeps(dir);
  };

  const expandedManifests = new Set();
  /** Expand the closure over a copied package's own dependency fields. */
  const expandPackageDeps = async (packageDir) => {
    if (expandedManifests.has(packageDir)) return;
    expandedManifests.add(packageDir);
    let manifest;
    try {
      manifest = await readJson(path.join(packageDir, "package.json"));
    } catch {
      return;
    }
    // Expand over dependencies + optionalDependencies. Peer dependencies
    // are deliberately excluded: npm auto-installs peers such as the
    // typescript peer of @t3-oss/env-core (23 MiB) that no runtime code
    // ever imports; a peer that IS imported is added by the trace itself.
    const depNames = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {})
    ]);
    for (const depName of depNames) {
      // A declared dependency is the npm package even when its name
      // collides with a Node builtin: readable-stream depends on the
      // `process` and `string_decoder` packages (its sources require
      // "process/" with a trailing slash, which is NOT the builtin).
      // Skipping builtin-named deps crashed the API at startup in CI.
      const depDir = await findPackageDir(packageDir, depName);
      if (!depDir) continue; // optional dep not installed on this platform
      if (!packageDirs.has(depDir)) {
        packageDirs.set(depDir, depName);
        if (workspaceMap.get(depName) === depDir) {
          await includeWholeDist(depName);
        }
      }
      await expandPackageDeps(depDir);
    }
  };

  for (const name of target.wholeDistApps) await includeWholeDist(name);

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file.startsWith(ROOT)) continue;
    files.add(file);
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!/\.(js|mjs|cjs)$/.test(file)) continue;
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith("node:") || BUILTINS.has(specifier)) continue;
      if (
        specifier === "." ||
        specifier === ".." ||
        specifier.startsWith("./") ||
        specifier.startsWith("../") ||
        specifier.startsWith("/")
      ) {
        const base = specifier.startsWith("/")
          ? path.join(ROOT, specifier)
          : path.resolve(path.dirname(file), specifier);
        const resolved = await resolveFile(base);
        if (resolved) enqueue(resolved);
        continue;
      }
      const { name, subpath } = splitBareSpecifier(specifier);
      if (!name) continue;
      // The exact name of a builtin resolves to the builtin; a subpath
      // form ("process/") resolves to the npm package of that name.
      if (BUILTINS.has(name) && !subpath) continue;
      const packageDir = await findPackageDir(path.dirname(file), name);
      if (!packageDir) continue; // platform-optional package absent here
      if (!packageDirs.has(packageDir)) {
        packageDirs.set(packageDir, name);
        if (workspaceMap.get(name) === packageDir) {
          await includeWholeDist(name);
        }
        await expandPackageDeps(packageDir);
      }
      const entry = await resolvePackageEntry(packageDir, subpath);
      if (entry) enqueue(entry);
    }
  }
  // A package that contributes any staged file also contributes its
  // manifest: runtime code reads it (apps/api/dist/package-version.js
  // reads ../package.json at import time, which crashed the browser
  // image when @space/api was present only through traced files).
  for (const file of [...files]) {
    const relative = path.relative(ROOT, file);
    const segments = relative.split(path.sep);
    if ((segments[0] === "apps" || segments[0] === "packages") && segments.length > 2) {
      const manifest = path.join(ROOT, segments[0], segments[1], "package.json");
      if (existsSync(manifest)) files.add(manifest);
    }
  }
  return { files, packageDirs };
}

/** Payload directories inside a copied package that another platform owns. */
function platformPayloadSkip(relativeToRoot) {
  const normalized = relativeToRoot.split(path.sep).join("/");
  // node-pty ships prebuilds for every OS; only the target OS can load them.
  if (/node_modules\/node-pty\/prebuilds\/(darwin|win32|freebsd)-/.test(normalized)) {
    return true;
  }
  // @temporalio/core-bridge ships a Rust core per platform triple; keep
  // exactly the target triple's release directory.
  const bridge = normalized.match(
    /node_modules\/@temporalio\/core-bridge\/releases\/([^/]+)(\/|$)/
  );
  if (bridge && bridge[1] !== TARGET_TRIPLE) return true;
  return false;
}

function platformPackageVerdict(packageName) {
  // Optional platform packages installed for other platforms, e.g.
  // @napi-rs/canvas-linux-x64-musl next to the glibc build on Debian, or a
  // darwin/arm64 binary package on a linux/amd64 image.
  const base = packageName.split("/").pop();
  const osMatch = base.match(/-(darwin|win32|freebsd|openbsd|sunos|aix|linux)-/);
  if (!osMatch) return "keep";
  if (osMatch[1] !== "linux") return "drop";
  if (base.includes("-musl")) return "drop"; // images are glibc (Debian)
  const archSection = base.slice(base.indexOf("-linux-"));
  const otherArch =
    TARGETARCH === "amd64" ? /(arm64|ia32|x32)/ : /(x64|ia32|x32)/;
  if (otherArch.test(archSection)) return "drop";
  return "keep";
}

async function copyTree(source, destination, { prunePlatformPayloads = false, excludeTests = false } = {}) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      if (src.endsWith(".map")) return false;
      if (excludeTests && isTestFile(src)) return false;
      const rel = path.relative(ROOT, src);
      if (rel.split(path.sep).includes(".bin") && rel.includes("node_modules")) {
        return false;
      }
      if (prunePlatformPayloads && platformPayloadSkip(rel)) return false;
      return true;
    }
  });
}

async function dirSize(dir) {
  let total = 0;
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await lstat(full)).size;
      else if (entry.isSymbolicLink()) total += 64;
    }
  }
  await walk(dir);
  return total;
}

function isNestedCopy(dir, allDirs) {
  // dir is nested if another copied package dir is a node_modules ancestor.
  for (const other of allDirs) {
    if (other === dir) continue;
    const rel = path.relative(other, dir);
    if (
      !rel.startsWith("..") &&
      rel.split(path.sep).includes("node_modules")
    ) {
      return true;
    }
  }
  return false;
}

async function stageTarget(name, target, workspaceMap) {
  const outDir = path.join(OUT, name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const { files, packageDirs } = await traceTarget(target, workspaceMap);

  // Root manifests.
  for (const rootFile of ["package.json", "package-lock.json"]) {
    const source = path.join(ROOT, rootFile);
    if (existsSync(source)) await cp(source, path.join(outDir, rootFile));
  }

  // First-party workspaces: package.json + whole dist + asset dirs.
  for (const [dir, packageName] of packageDirs) {
    if (workspaceMap.get(packageName) !== dir) continue;
    const rel = path.relative(ROOT, dir);
    const dest = path.join(outDir, rel);
    await mkdir(dest, { recursive: true });
    await cp(path.join(dir, "package.json"), path.join(dest, "package.json"));
    const distDir = path.join(dir, "dist");
    if (existsSync(distDir)) {
      await copyTree(distDir, path.join(dest, "dist"), { excludeTests: true });
    }
    // App-root modules (e.g. apps/web/server.mjs) are entrypoint territory:
    // copy the flat .mjs/.js files sitting next to package.json as well.
    for (const entry of await readdir(dir)) {
      if (/\.(mjs|js)$/.test(entry)) {
        const source = path.join(dir, entry);
        if ((await lstat(source)).isFile()) await cp(source, path.join(dest, entry));
      }
    }
    for (const assetDir of PACKAGE_ASSET_DIRS.get(packageName) || []) {
      const assetSource = path.join(dir, assetDir);
      if (existsSync(assetSource)) {
        await copyTree(assetSource, path.join(dest, assetDir));
      }
    }
  }

  // Third-party packages: copy each top-most package directory to its
  // original location; nested copies ride along with their parent.
  const thirdPartyDirs = [...packageDirs.keys()].filter((dir) =>
    dir.includes(`${path.sep}node_modules${path.sep}`)
  );
  for (const dir of thirdPartyDirs) {
    if (isNestedCopy(dir, thirdPartyDirs)) continue;
    const rel = path.relative(ROOT, dir);
    await copyTree(dir, path.join(outDir, rel), { prunePlatformPayloads: true });
  }

  // First-party symlinks in node_modules (@space/* -> ../../packages/...):
  // recreate exactly the links whose target package is included.
  for (const [dir, packageName] of packageDirs) {
    if (workspaceMap.get(packageName) !== dir) continue;
    const linkPath = path.join(ROOT, "node_modules", ...packageName.split("/"));
    try {
      const info = await lstat(linkPath);
      if (info.isSymbolicLink()) {
        const target = await readlink(linkPath);
        const dest = path.join(outDir, "node_modules", ...packageName.split("/"));
        await mkdir(path.dirname(dest), { recursive: true });
        await symlink(target, dest);
      }
    } catch {
      /* no link in source tree */
    }
  }

  // Individually traced files not already covered (entrypoints, app-root
  // modules such as apps/web/server.mjs, JSON imports).
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (rel.includes(`node_modules${path.sep}`)) continue;
    const dest = path.join(outDir, rel);
    if (existsSync(dest)) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(file, dest);
  }

  // Prune wrong-platform optional packages that arrived through dependency
  // expansion (e.g. the musl canvas build next to the glibc one).
  const stagedNm = path.join(outDir, "node_modules");
  if (existsSync(stagedNm)) {
    for (const scopeOrPkg of await readdir(stagedNm)) {
      if (scopeOrPkg.startsWith(".")) continue;
      const names = scopeOrPkg.startsWith("@")
        ? (await readdir(path.join(stagedNm, scopeOrPkg))).map(
            (n) => `${scopeOrPkg}/${n}`
          )
        : [scopeOrPkg];
      for (const packageName of names) {
        if (platformPackageVerdict(packageName) === "drop") {
          await rm(path.join(stagedNm, ...packageName.split("/")), {
            recursive: true,
            force: true
          });
        }
      }
    }
  }

  // agent-skills ships only where the target's code reads it.
  if (target.agentSkills) {
    const skillsSource = path.join(ROOT, "agent-skills");
    if (existsSync(skillsSource)) {
      await copyTree(skillsSource, path.join(outDir, "agent-skills"));
    }
  }

  const bytes = await dirSize(outDir);
  const packageNames = [...new Set(packageDirs.values())].sort();
  console.log(
    `staged ${name}: ${packageNames.length} packages, ${(bytes / 1048576).toFixed(1)} MiB payload -> ${outDir}`
  );
  console.log(`  packages: ${packageNames.join(", ")}`);
  return { name, bytes, packages: packageNames };
}

async function main() {
  const workspaceMap = await loadWorkspaceMap();
  await mkdir(OUT, { recursive: true });
  for (const [name, target] of Object.entries(TARGETS)) {
    if (ONLY_TARGETS.length > 0 && !ONLY_TARGETS.includes(name)) continue;
    await stageTarget(name, target, workspaceMap);
  }
  console.log(
    `stage-service-images: done (arch=${TARGETARCH}, triple=${TARGET_TRIPLE})`
  );
}

await main();
