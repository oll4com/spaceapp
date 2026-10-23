#!/usr/bin/env node
// Trace application imports without rewriting their code or import.meta URLs.
// Resolve external production dependencies from their original issuer, retaining
// nested versions, installed optional native packages and required peers.
import { createRequire, isBuiltin } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const json = path => JSON.parse(readFileSync(path, "utf8"));
const slash = path => path.split(sep).join("/");
const inside = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== ".." && !isAbsolute(relative(root, path)));
const packageName = specifier => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

function filesUnder(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path, predicate) : predicate(path) ? [path] : [];
  });
}

export function findInstalledPackage(root, issuer, name) {
  for (let cursor = resolve(issuer); inside(root, cursor); cursor = dirname(cursor)) {
    const candidate = join(cursor, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      const actual = realpathSync(candidate);
      if (!inside(root, actual)) throw new Error(`Dependency ${name} escapes the source checkout`);
      return actual;
    }
    if (cursor === root) break;
  }
  return null;
}

export function productionClosure(root, requests) {
  const packages = new Map();
  function visit(name, issuer, optional = false) {
    const path = findInstalledPackage(root, issuer, name);
    if (!path) {
      if (optional) return;
      throw new Error(`Missing production dependency ${name} from ${slash(relative(root, issuer))}`);
    }
    if (packages.has(path)) return;
    const manifest = json(join(path, "package.json"));
    if (manifest.name !== name) throw new Error(`Unexpected package at ${path}: ${manifest.name}`);
    packages.set(path, manifest);
    const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, path, optionalNames.has(dependency));
    for (const dependency of optionalNames) visit(dependency, path, true);
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      // Optional peers such as env-core's TypeScript are build-time integrations,
      // not runtime roots. An explicit application import still includes them.
      if (!manifest.peerDependenciesMeta?.[peer]?.optional) visit(peer, path);
    }
  }
  for (const { name, issuer } of requests) visit(name, issuer);
  return packages;
}

export function runtimeEntrypoints(root, target) {
  const javascript = path => /\.(?:mjs|cjs|js)$/.test(path) && !/(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\.[cm]?js$/.test(path);
  if (target === "core") return [
    ...["apps/api/dist", "apps/worker/dist", "packages/memory-graph/dist", "packages/gateway/dist"].flatMap(path => filesUnder(join(root, path), javascript)),
    join(root, "apps/web/server.mjs"),
    join(root, "packages/db/dist/migrate.js"),
    ...["reset-owner-password", "rotate-owner-setup-token", "portable-backup", "portable-restore"].map(name => join(root, `scripts/${name}.mjs`))
  ];
  if (target === "browser") return [join(root, "apps/api/dist/browser-host-main.js")];
  if (target === "cli") return filesUnder(join(root, "packages/cli-host/dist"), javascript);
  throw new Error(`Unknown runtime target: ${target}`);
}

export async function traceRuntime(root, entrypoints, build) {
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: entrypoints.map(path => `import ${JSON.stringify(`./${slash(relative(root, path))}`)};`).join("\n"), resolveDir: root, sourcefile: "container-entrypoints.mjs" },
    bundle: true, treeShaking: false, write: false, metafile: true,
    platform: "node", format: "esm", target: "node22", logLevel: "silent",
    plugins: [{ name: "runtime-package-boundary", setup(context) {
      context.onResolve({ filter: /^[^./]/ }, args => {
        if (isAbsolute(args.path) || args.path.startsWith("@space/")) return;
        return { path: args.path, external: true };
      });
    } }]
  });
  const files = new Set(entrypoints);
  const dependencies = [];
  for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
    if (input === "container-entrypoints.mjs" || input === "<stdin>") continue;
    const path = resolve(root, input);
    if (!inside(root, path)) throw new Error(`Runtime source escapes checkout: ${input}`);
    files.add(path);
    for (const imported of metadata.imports) {
      if (imported.external && !isBuiltin(imported.path)) dependencies.push({ name: packageName(imported.path), issuer: dirname(path) });
    }
  }
  return { files, dependencies };
}

export async function prepareRuntime({ root, output, target, build, entrypoints, platform = process.platform, arch = process.arch }) {
  root = realpathSync(root);
  output = resolve(output);
  if (inside(root, output) || inside(output, root)) throw new Error("Runtime output must be a separate directory outside the checkout");
  if (existsSync(output)) throw new Error("Runtime output already exists; refusing to overwrite it");
  entrypoints ??= runtimeEntrypoints(root, target);
  if (!entrypoints.length || entrypoints.some(path => !existsSync(path))) throw new Error(`Build the ${target} entrypoints before preparing its runtime`);
  build ??= createRequire(join(root, "packages/gateway/package.json"))("esbuild").build;
  const traced = await traceRuntime(root, entrypoints, build);
  const dependencies = productionClosure(root, traced.dependencies);
  const workspaces = new Map();
  for (const path of traced.files) {
    const match = slash(relative(root, path)).match(/^(apps|packages)\/[^/]+\//);
    if (match) {
      const directory = match[0].slice(0, -1);
      workspaces.set(directory, json(join(root, directory, "package.json")));
    }
  }
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  function copy(source, destination = slash(relative(root, source)), dependency = null) {
    const absolute = resolve(source);
    const dest = resolve(output, destination);
    if (!inside(root, absolute) || !inside(output, dest)) throw new Error("Runtime copy escaped its source or destination");
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(absolute, dest, { recursive: true, dereference: false, filter: path => {
      const local = slash(relative(absolute, path));
      if (/\.(?:js|mjs|cjs|css)\.map$/.test(path)) return false;
      if (dependency && (local === "node_modules" || local.startsWith("node_modules/"))) return false;
      if (dependency?.name === "@temporalio/core-bridge") {
        // The pinned SDK ships all five native release binaries in one npm
        // package. Debian images load exactly their current GNU/Linux target.
        const targets = {
          "linux-x64": "x86_64-unknown-linux-gnu", "linux-arm64": "aarch64-unknown-linux-gnu",
          "win32-x64": "x86_64-pc-windows-msvc", "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin"
        };
        const release = local.match(/^releases\/([^/]+)(?:\/|$)/)?.[1];
        if (release && Object.values(targets).includes(release) && release !== targets[`${platform}-${arch}`]) return false;
      }
      if (dependency && /(?:^|\/)prebuilds\/[^/]+/.test(local)) {
        const candidate = local.match(/(?:^|\/)prebuilds\/([^/]+)/)[1];
        if (/^(linux|darwin|win32)-(x64|arm64|ia32)(?:$|-)/.test(candidate) && !candidate.startsWith(`${platform}-${arch}`)) return false;
      }
      return true;
    } });
  }
  for (const path of traced.files) copy(path);
  for (const [directory, manifest] of workspaces) {
    copy(join(root, directory, "package.json"));
    // Runtime data sits beside compiled JS; do not ship TS sources or tests.
    for (const asset of filesUnder(join(root, directory, "dist"), path => !/\.(?:[cm]?js|map|d\.ts)$/.test(path))) copy(asset);
    const link = join(output, "node_modules", manifest.name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(platform === "win32" ? join(output, directory) : relative(dirname(link), join(output, directory)), link, platform === "win32" ? "junction" : "dir");
  }
  for (const [path, manifest] of dependencies) copy(path, slash(relative(root, path)), manifest);
  const assets = ["deploy/docker", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
  if (target === "core") assets.push("apps/web/dist", "apps/web/public", "packages/db/migrations", "packages/gateway/grammars", "agent-skills");
  if (target === "browser" && workspaces.has("packages/db")) assets.push("packages/db/migrations");
  if (target === "cli") assets.push("agent-skills");
  for (const path of assets) if (existsSync(join(root, path))) copy(join(root, path));
  const original = json(join(root, "package.json"));
  const manifest = { ...original, workspaces: [...workspaces.keys()].sort(), dependencies: {}, scripts: undefined, devDependencies: undefined };
  const lock = json(join(root, "package-lock.json"));
  const packages = { "": manifest };
  for (const [path, metadata] of dependencies) {
    const key = slash(relative(root, path));
    packages[key] = lock.packages[key] ?? { version: metadata.version };
    if (/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(key)) manifest.dependencies[metadata.name] = metadata.version;
  }
  for (const [directory, metadata] of workspaces) {
    packages[directory] = lock.packages[directory] ?? { version: metadata.version };
    packages[`node_modules/${metadata.name}`] = { resolved: directory, link: true };
  }
  writeFileSync(join(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(output, "package-lock.json"), `${JSON.stringify({ ...lock, packages }, null, 2)}\n`);
  const report = { target, platform, arch, files: traced.files.size, workspaces: [...workspaces.keys()].sort(), dependencies: [...dependencies].map(([path, manifest]) => ({ path: slash(relative(root, path)), name: manifest.name, version: manifest.version })).sort((a, b) => a.path.localeCompare(b.path)) };
  writeFileSync(join(output, "container-runtime.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [target, output] = process.argv.slice(2);
  prepareRuntime({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), target, output: output ?? "" }).then(report => {
    process.stdout.write(`${report.target}: ${report.dependencies.length} production packages, ${report.workspaces.length} workspaces\n`);
  }).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
