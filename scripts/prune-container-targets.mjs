#!/usr/bin/env node
// Stage per-target /app subtrees for the core, browser and cli container
// images, so each image ships only the code and dependencies its service runs.
// Runs in the Dockerfile build stage after `npm prune --omit=dev`, when
// node_modules holds exactly the production tree npm resolved.
//
// For every target the script copies:
//   - the workspace directories the target's entrypoints import,
//   - a node_modules dependency closure computed from the declared production
//     dependencies (and their transitive production dependencies) of those
//     workspaces, resolved against the real installed tree,
//   - the target's extra payload (agent-skills, owner and backup scripts).
//
// Foreign-platform native artifacts (Temporal core bridge releases, node-pty
// prebuilds, @napi-rs/canvas platform packages) are dropped for the TARGETARCH
// being built: buildx builds each platform from its own build stage.
//
// The script then statically scans the staged JavaScript for bare module
// specifiers and verifies each one resolves inside the staged tree with
// `import.meta.resolve`, so a missing package fails the image build instead of
// the container start.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const nativePlatforms = Object.freeze({
  amd64: Object.freeze({
    prebuildArch: "linux-x64",
    canvasPlatform: "linux-x64-gnu",
    coreBridgeTriple: "x86_64-unknown-linux-gnu"
  }),
  arm64: Object.freeze({
    prebuildArch: "linux-arm64",
    canvasPlatform: "linux-arm64-gnu",
    coreBridgeTriple: "aarch64-unknown-linux-gnu"
  })
});

// The workspaces each image's entrypoints reach at runtime:
//   core:  apps/api/dist/server.js, apps/worker/dist/worker.js,
//          apps/web/server.mjs and packages/db/dist/migrate.js
//          (deploy/docker/core-supervisor.mjs, core-entrypoint.sh)
//   cli:   packages/cli-host/dist/main.js (cli-entrypoint.sh)
//   browser: apps/api/dist/browser-host-main.js (browser-entrypoint.sh)
// External dependencies are the declared `dependencies` of the workspaces in
// `dependencyWorkspaces`, plus root dependencies those workspaces reach
// through hoisting without declaring. Workspaces that are copied but not
// counted (apps/web, packages/icons) only ship prebuilt output that their
// build produced; nothing the images run imports their dependencies.
// Workspace source directories that runtime code reads next to dist/
// (packages/db/dist/migrations.js reads packages/db/migrations).
const workspaceRuntimeDirectories = Object.freeze({
  "packages/db": Object.freeze(["migrations"])
});

const targetManifest = Object.freeze({
  core: Object.freeze({
    workspaces: Object.freeze([
      "apps/api",
      "apps/worker",
      "apps/web",
      "packages/browser-host",
      "packages/cli-host",
      "packages/codex-app-server",
      "packages/contracts",
      "packages/db",
      "packages/gateway",
      "packages/memory-graph",
      "packages/opencode-control",
      "packages/runtime",
      "packages/streaming"
    ]),
    dependencyWorkspaces: Object.freeze([
      "apps/api",
      "apps/worker",
      "packages/browser-host",
      "packages/cli-host",
      "packages/codex-app-server",
      "packages/contracts",
      "packages/db",
      "packages/gateway",
      "packages/memory-graph",
      "packages/opencode-control",
      "packages/runtime",
      "packages/streaming"
    ]),
    extraDirectories: Object.freeze(["agent-skills"]),
    extraFiles: Object.freeze([]),
    rootDependencies: Object.freeze(["@modelcontextprotocol/sdk"])
  }),
  browser: Object.freeze({
    workspaces: Object.freeze([
      "apps/api",
      "packages/browser-host",
      "packages/contracts",
      "packages/db",
      "packages/memory-graph",
      "packages/runtime"
    ]),
    dependencyWorkspaces: Object.freeze([
      "apps/api",
      "packages/browser-host",
      "packages/contracts",
      "packages/db",
      "packages/memory-graph",
      "packages/runtime"
    ]),
    extraDirectories: Object.freeze([]),
    extraFiles: Object.freeze([]),
    rootDependencies: Object.freeze([])
  }),
  cli: Object.freeze({
    workspaces: Object.freeze(["packages/cli-host"]),
    dependencyWorkspaces: Object.freeze(["packages/cli-host"]),
    extraDirectories: Object.freeze(["agent-skills"]),
    extraFiles: Object.freeze([]),
    rootDependencies: Object.freeze([])
  })
});

function parseArgs(args) {
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const arch = option("--arch");
  const out = option("--out");
  const targets = args.includes("--all")
    ? Object.keys(targetManifest)
    : args.filter((value) => value === "core" || value === "browser" || value === "cli");
  if (!arch || !out || targets.length === 0) {
    throw new Error(
      "Usage: prune-container-targets.mjs --arch <amd64|arm64> --out <dir> (--all | --target core|browser|cli ...)"
    );
  }
  if (!nativePlatforms[arch]) {
    throw new Error(`Unsupported container target architecture: ${arch}`);
  }
  return { arch, out: path.resolve(out), targets };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Walks the installed tree breadth-first from the declared dependencies and
// returns every node_modules package directory (real path) the target needs.
// The closure is keyed by directory, so the hoisted and the nested version of
// a package both stage when different packages resolve different versions.
// Each dependency resolves from its requiring package, mimicking Node's
// node_modules lookup (`require.resolve(name + "/package.json")` fails for
// packages whose `exports` map does not export package.json).
// Production `dependencies` and `optionalDependencies` are followed;
// `peerDependencies` are not, because npm hoists peers only when a real
// dependency needs them and the staged-resolution check below catches a
// missing module at build time anyway.
function findPackageDirectory(from, name) {
  let directory = from;
  for (;;) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function collectDependencyClosure(seeds) {
  const stagedDirectories = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const packageDirectory = findPackageDirectory(from, name);
    if (!packageDirectory || stagedDirectories.has(packageDirectory)) continue;
    stagedDirectories.add(packageDirectory);
    const manifest = readJson(path.join(packageDirectory, "package.json"));
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        queue.push({ name: dependency, from: packageDirectory });
      }
    }
  }
  return stagedDirectories;
}

function copyWorkspace(sourceDirectory, stagingRoot) {
  const destination = path.join(stagingRoot, path.relative(repoRoot, sourceDirectory));
  mkdirSync(path.dirname(destination), { recursive: true });
  const workspace = path.relative(repoRoot, sourceDirectory);
  const extraDirectories = workspaceRuntimeDirectories[workspace] ?? [];
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (entry.name.endsWith(".tsbuildinfo")) continue;
    // Workspace-local node_modules are staged by the dependency closure below,
    // at their exact nested location, so both the hoisted and the nested
    // version of a package resolve exactly as npm installed them.
    if (entry.isDirectory() && entry.name !== "dist" && !extraDirectories.includes(entry.name)) {
      continue;
    }
    cpSync(path.join(sourceDirectory, entry.name), path.join(destination, entry.name), {
      recursive: true,
      verbatimSymlinks: true
    });
  }
}

function pruneForeignPlatformArtifacts(stagingRoot, platform) {
  const nodeModules = path.join(stagingRoot, "node_modules");
  if (!existsSync(nodeModules)) return;

  const removeForeignReleaseTriples = (packageDirectory) => {
    const releases = path.join(packageDirectory, "releases");
    if (!existsSync(releases)) return;
    for (const entry of readdirSync(releases, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== platform.coreBridgeTriple) {
        rmSync(path.join(releases, entry.name), { recursive: true, force: true });
      }
    }
  };

  const removeForeignPrebuilds = (packageDirectory) => {
    const prebuilds = path.join(packageDirectory, "prebuilds");
    if (!existsSync(prebuilds)) return;
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(`${platform.prebuildArch}-`)) {
        rmSync(path.join(prebuilds, entry.name), { recursive: true, force: true });
      }
    }
  };

  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith("@")) {
      const scope = path.join(nodeModules, entry.name);
      for (const child of readdirSync(scope, { withFileTypes: true })) {
        const packageDirectory = path.join(scope, child.name);
        if (child.name === "core-bridge") {
          removeForeignReleaseTriples(packageDirectory);
          continue;
        }
        // Platform-specific optional companions such as @napi-rs/canvas-*:
        // only the glibc build for the target architecture stays.
        const platformMatch = child.name.match(
          /-(linux-(?:x64|arm64)-(?:gnu|musl)|darwin-(?:x64|arm64)|win32-(?:x64|arm64))$/
        );
        if (platformMatch && platformMatch[1] !== platform.canvasPlatform) {
          rmSync(packageDirectory, { recursive: true, force: true });
          continue;
        }
        if (existsSync(path.join(packageDirectory, "package.json"))) {
          removeForeignPrebuilds(packageDirectory);
        }
      }
      continue;
    }
    if (!existsSync(path.join(nodeModules, entry.name, "package.json"))) continue;
    removeForeignPrebuilds(path.join(nodeModules, entry.name));
  }
}

// Scans staged runtime code for bare module specifiers, recorded per source
// directory so the resolution check can run from each directory Node would
// resolve from. Only code Node itself imports is scanned: apps/web/dist holds
// static browser bundles that server.mjs serves as files, so it is excluded.
// Static forms (`from "x"`, side-effect `import "x"`, `require("x")`) and
// dynamic `import("x")` are both recorded; the check below decides what must
// resolve.
function collectBareSpecifiers(stagingRoot) {
  const specifiersByDirectory = new Map();
  const record = (directory, specifier) => {
    if (!/^[a-z][a-z0-9@._/-]*$/i.test(specifier)) return;
    if (/\.[a-z0-9]{2,4}$/i.test(specifier)) return;
    const packageName = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    if (!specifiersByDirectory.has(directory)) specifiersByDirectory.set(directory, new Set());
    specifiersByDirectory.get(directory).add(packageName);
  };
  const skipDirectory = (relative) =>
    relative === "apps/web/dist" ||
    relative === "node_modules" ||
    relative.startsWith("node_modules/");
  const walk = (directory, relative) => {
    if (skipDirectory(relative)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), entryRelative);
        continue;
      }
      if (!/\.(m|c)?js$/.test(entry.name)) continue;
      const text = readFileSync(path.join(directory, entry.name), "utf8");
      for (const match of text.matchAll(
        /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(["'])([^"'\n]+)\1/g
      )) {
        const specifier = match[2];
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("node:") ||
          specifier.startsWith("data:")
        ) {
          continue;
        }
        record(directory, specifier);
      }
    }
  };
  walk(stagingRoot, "");
  return specifiersByDirectory;
}

// Every bare specifier found in staged code must resolve from the directory of
// the file referencing it, unless the package is already absent from the
// production tree (npm-pruned dev-only packages referenced by feature code
// that guards its use keep their pre-existing behavior). The check runs
// `import.meta.resolve` per referencing directory, so it never executes
// package code.
function verifyStagedResolution(stagingRoot, specifiersByDirectory) {
  const requiredByDirectory = new Map();
  for (const [directory, specifiers] of specifiersByDirectory) {
    const required = [...specifiers].filter((name) =>
      existsSync(path.join(repoRoot, "node_modules", ...name.split("/")))
    );
    if (required.length > 0) requiredByDirectory.set(directory, required);
  }
  const missing = [];
  for (const [directory, required] of requiredByDirectory) {
    const probe = path.join(directory, ".prune-resolution-probe.mjs");
    writeFileSync(
      probe,
      `const specifiers = ${JSON.stringify(required, null, 2)};\n` +
        "const missing = [];\n" +
        "for (const specifier of specifiers) {\n" +
        "  try { import.meta.resolve(specifier); } catch { missing.push(specifier); }\n" +
        "}\n" +
        "process.stdout.write(JSON.stringify(missing));\n"
    );
    try {
      for (const name of JSON.parse(
        execFileSync(process.execPath, [probe], { encoding: "utf8", cwd: stagingRoot })
      )) {
        missing.push(`${path.relative(stagingRoot, directory) || "."}: ${name}`);
      }
    } finally {
      rmSync(probe, { force: true });
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Staged ${path.basename(stagingRoot)} tree cannot resolve: ${missing.join(", ")}`
    );
  }
}

export const containerTargetManifest = targetManifest;

export function pruneContainerTargets(options) {
  const { arch, out, targets } = options;
  const platform = nativePlatforms[arch];
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const target of targets) {
    const manifest = targetManifest[target];
    const stagingRoot = path.join(out, target);
    mkdirSync(stagingRoot, { recursive: true });

    for (const workspace of manifest.workspaces) {
      copyWorkspace(path.join(repoRoot, workspace), stagingRoot);
    }
    for (const extra of manifest.extraDirectories) {
      cpSync(path.join(repoRoot, extra), path.join(stagingRoot, extra), {
        recursive: true,
        verbatimSymlinks: true
      });
    }
    for (const extra of manifest.extraFiles) {
      mkdirSync(path.dirname(path.join(stagingRoot, extra)), { recursive: true });
      cpSync(path.join(repoRoot, extra), path.join(stagingRoot, extra));
    }
    for (const rootFile of ["package.json", "package-lock.json"]) {
      cpSync(path.join(repoRoot, rootFile), path.join(stagingRoot, rootFile));
    }

    // First-level dependencies resolve from their workspace so packages npm
    // installed nested under a workspace (version overrides) are found.
    const closure = collectDependencyClosure([
      ...manifest.dependencyWorkspaces.flatMap((workspace) =>
        Object.keys(readJson(path.join(repoRoot, workspace, "package.json")).dependencies ?? {})
          .filter((name) => !name.startsWith("@space/"))
          .map((name) => ({ name, from: path.join(repoRoot, workspace) }))
      ),
      ...manifest.rootDependencies.map((name) => ({ name, from: repoRoot }))
    ]);

    const nodeModules = path.join(stagingRoot, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    const rootNodeModules = path.join(repoRoot, "node_modules");
    for (const packageDirectory of closure) {
      const destination = path.join(nodeModules, path.relative(rootNodeModules, packageDirectory));
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(packageDirectory, destination, { recursive: true, verbatimSymlinks: true });
    }

    // Recreate npm's workspace symlinks (node_modules/@space/api -> ../../apps/api).
    const scope = path.join(nodeModules, "@space");
    mkdirSync(scope, { recursive: true });
    for (const workspace of manifest.workspaces) {
      const packageName = workspace.split("/").pop();
      const relativeTarget = path
        .relative(scope, path.join(stagingRoot, workspace))
        .split(path.sep)
        .join("/");
      symlinkSync(relativeTarget, path.join(scope, packageName));
    }

    pruneForeignPlatformArtifacts(stagingRoot, platform);
    verifyStagedResolution(stagingRoot, collectBareSpecifiers(stagingRoot));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    pruneContainerTargets(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
