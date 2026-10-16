#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = Object.freeze({
  core: {
    workspaces: ["@space/api", "@space/worker", "@space/web"],
    agentSkills: true,
    scripts: [
      "reset-owner-password.mjs",
      "rotate-owner-setup-token.mjs",
      "portable-backup.mjs",
      "portable-restore.mjs"
    ]
  },
  browser: {
    workspaces: ["@space/browser-host", "@space/db", "@space/runtime"],
    applicationFiles: [
      "apps/api/package.json",
      "apps/api/dist/browser-host-main.js",
      "apps/api/dist/browser-sessions.js",
      "apps/api/dist/browser-errors.js",
      "apps/api/dist/child-process-env.js",
      "apps/api/dist/cli-runtime-descriptors.js",
      "apps/api/dist/config.js",
      "apps/api/dist/google-browser-session-check.js",
      "apps/api/dist/live-model-policy.js",
      "apps/api/dist/package-version.js",
      "apps/api/dist/t3-env.js",
      "apps/api/dist/youtube-ad-block.js"
    ],
    agentSkills: false,
    scripts: []
  },
  cli: {
    workspaces: ["@space/cli-host"],
    agentSkills: true,
    scripts: []
  }
});

const workspaceRuntimeAssets = Object.freeze({
  "@space/db": ["migrations"],
  "@space/gateway": ["grammars"]
});

// The web build compiles these TSX icon components into its static bundle. They
// are a declared workspace dependency, but Node never loads them at runtime.
const runtimeManifestOnlyWorkspaces = new Set(["@space/icons"]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readWorkspaces(root) {
  const rootPackage = readJson(path.join(root, "package.json"));
  const workspaces = new Map();

  for (const pattern of rootPackage.workspaces ?? []) {
    const [parent, wildcard, ...rest] = pattern.split("/");
    if (wildcard !== "*" || rest.length > 0) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const parentPath = path.join(root, parent);
    for (const entry of readdirSync(parentPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const workspacePath = path.join(parent, entry.name);
      const manifestPath = path.join(root, workspacePath, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      if (typeof manifest.name !== "string") continue;
      workspaces.set(manifest.name, { path: workspacePath, manifest });
    }
  }

  return workspaces;
}

function workspaceClosure(workspaces, roots) {
  const selected = new Set();
  const visit = (name) => {
    if (selected.has(name)) return;
    const workspace = workspaces.get(name);
    if (!workspace) throw new Error(`Workspace dependency is missing: ${name}`);
    selected.add(name);
    const dependencies = {
      ...workspace.manifest.dependencies,
      ...workspace.manifest.optionalDependencies,
      ...workspace.manifest.peerDependencies
    };
    for (const dependency of Object.keys(dependencies)) {
      if (workspaces.has(dependency)) visit(dependency);
    }
  };
  for (const root of roots) visit(root);
  return [...selected].sort();
}

function copyWorkspace(root, output, workspace) {
  const source = path.join(root, workspace.path);
  const destination = path.join(output, workspace.path);
  const dist = path.join(source, "dist");
  if (!existsSync(dist) && !runtimeManifestOnlyWorkspaces.has(workspace.manifest.name)) {
    throw new Error(`Built workspace output is missing: ${path.join(workspace.path, "dist")}`);
  }
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(source, "package.json"), path.join(destination, "package.json"));
  if (runtimeManifestOnlyWorkspaces.has(workspace.manifest.name)) return;
  cpSync(dist, path.join(destination, "dist"), { recursive: true });
  for (const asset of workspaceRuntimeAssets[workspace.manifest.name] ?? []) {
    const assetPath = path.join(source, asset);
    if (!existsSync(assetPath)) {
      throw new Error(`Required runtime asset is missing: ${path.join(workspace.path, asset)}`);
    }
    cpSync(assetPath, path.join(destination, asset), { recursive: true });
  }

  if (workspace.path === path.join("apps", "web")) {
    cpSync(path.join(source, "server.mjs"), path.join(destination, "server.mjs"));
  }
}

function copyOptionalDirectory(root, output, directory) {
  const source = path.join(root, directory);
  if (!existsSync(source)) throw new Error(`Required runtime directory is missing: ${directory}`);
  cpSync(source, path.join(output, directory), { recursive: true });
}

export function createRuntimeBundles(
  root = repositoryRoot,
  outputRoot = path.join(root, ".container-runtime")
) {
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    throw new Error(`Runtime bundle output directory must be empty: ${outputRoot}`);
  }
  mkdirSync(outputRoot, { recursive: true });
  const workspaces = readWorkspaces(root);
  const rootPackage = path.join(root, "package.json");

  for (const [targetName, config] of Object.entries(targets)) {
    const output = path.join(outputRoot, targetName);
    mkdirSync(output, { recursive: true });
    cpSync(rootPackage, path.join(output, "package.json"));

    for (const name of workspaceClosure(workspaces, config.workspaces)) {
      copyWorkspace(root, output, workspaces.get(name));
    }

    for (const file of config.applicationFiles ?? []) {
      const source = path.join(root, file);
      if (!existsSync(source)) throw new Error(`Required runtime file is missing: ${file}`);
      const destination = path.join(output, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(source, destination);
    }

    if (config.agentSkills) copyOptionalDirectory(root, output, "agent-skills");
    if (config.scripts.length > 0) {
      const scriptsOutput = path.join(output, "scripts");
      mkdirSync(scriptsOutput, { recursive: true });
      for (const file of config.scripts) {
        cpSync(path.join(root, "scripts", file), path.join(scriptsOutput, file));
      }
    }
  }

  return Object.fromEntries(
    Object.entries(targets).map(([name, config]) => [
      name,
      workspaceClosure(workspaces, config.workspaces)
    ])
  );
}

export function runtimeWorkspaceSelectors(targetName, root = repositoryRoot) {
  const target = targets[targetName];
  if (!target) throw new Error(`Unknown runtime target: ${targetName}`);
  const workspaces = readWorkspaces(root);
  return workspaceClosure(workspaces, target.workspaces).map((name) => `--workspace=${name}`);
}

export function includeWorkspaceNodeModules(
  targetName,
  root = repositoryRoot,
  outputRoot = path.join(root, ".container-runtime")
) {
  const target = targets[targetName];
  if (!target) throw new Error(`Unknown runtime target: ${targetName}`);
  const workspaces = readWorkspaces(root);
  const included = [];
  for (const name of workspaceClosure(workspaces, target.workspaces)) {
    const workspace = workspaces.get(name);
    const source = path.join(root, workspace.path, "node_modules");
    if (!existsSync(source)) continue;
    const destination = path.join(outputRoot, targetName, workspace.path, "node_modules");
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false });
    included.push(workspace.path);
  }
  return included;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const targetName = optionValue(args, "--workspace-selectors");
    const workspaceNodeModulesTarget = optionValue(args, "--include-workspace-node-modules");
    if (targetName) {
      process.stdout.write(`${runtimeWorkspaceSelectors(targetName).join("\n")}\n`);
      process.exit(0);
    }
    const outputRoot = optionValue(args, "--output")
      ?? path.join(repositoryRoot, ".container-runtime");
    if (workspaceNodeModulesTarget) {
      const included = includeWorkspaceNodeModules(workspaceNodeModulesTarget, repositoryRoot, path.resolve(outputRoot));
      process.stdout.write(`${workspaceNodeModulesTarget}: nested dependencies for ${included.join(", ")}\n`);
      process.exit(0);
    }
    const bundles = createRuntimeBundles(repositoryRoot, path.resolve(outputRoot));
    for (const [name, workspaces] of Object.entries(bundles)) {
      process.stdout.write(`${name}: ${workspaces.join(", ")}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
