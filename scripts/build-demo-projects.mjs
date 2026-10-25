#!/usr/bin/env node
/**
 * Builds every demo project variant under `demos/`.
 *
 * React previews are bundled with the repository Vite/React toolchain and
 * TypeScript servers are compiled with the repository TypeScript. The runtime
 * then starts a plain Node process per run, so a started demo needs no install
 * step and no network access.
 */
import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const demoRoot = join(repositoryRoot, "demos");
const tscPath = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listVariants() {
  const variants = [];
  let projects;
  try {
    projects = await readdir(demoRoot, { withFileTypes: true });
  } catch {
    return variants;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(demoRoot, project.name);
    const entries = await readdir(projectPath, { withFileTypes: true });
    for (const variant of entries) {
      if (!variant.isDirectory()) continue;
      variants.push({ project: project.name, variant: variant.name, directory: join(projectPath, variant.name) });
    }
  }
  return variants.sort((left, right) => left.directory.localeCompare(right.directory));
}

async function buildVariant({ project, variant, directory }) {
  const label = `${project}/${variant}`;
  const viteConfig = join(directory, "web", "vite.config.mjs");
  if (await exists(viteConfig)) {
    const { build } = await import("vite");
    await build({ configFile: viteConfig, logLevel: "warn" });
    const indexPath = join(directory, "web", "dist", "index.html");
    if (!(await exists(indexPath))) throw new Error(`${label}: the web build did not produce web/dist/index.html`);
    console.log(`[demos] built web preview for ${label}`);
  }

  const webTsconfig = join(directory, "web", "tsconfig.json");
  if (await exists(webTsconfig)) {
    await execFileAsync(process.execPath, [tscPath, "-p", webTsconfig], { cwd: repositoryRoot });
    console.log(`[demos] type-checked web sources for ${label}`);
  }

  const serverTsconfig = join(directory, "server", "tsconfig.json");
  if (await exists(serverTsconfig)) {
    await execFileAsync(process.execPath, [tscPath, "-p", serverTsconfig], { cwd: repositoryRoot });
    const entry = join(directory, "server-dist", "index.js");
    if (!(await exists(entry))) throw new Error(`${label}: the TypeScript server build did not produce server-dist/index.js`);
    console.log(`[demos] compiled TypeScript server for ${label}`);
  }

  const serverDirectory = join(directory, "server");
  const serverStats = await stat(serverDirectory).catch(() => null);
  if (!serverStats?.isDirectory()) throw new Error(`${label}: the variant has no server directory.`);
}

async function main() {
  const variants = await listVariants();
  if (variants.length === 0) {
    console.log("[demos] no demo variants found; nothing to build.");
    return;
  }
  const failures = [];
  for (const variant of variants) {
    try {
      await buildVariant(variant);
    } catch (error) {
      failures.push(`${variant.project}/${variant.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    console.error(`[demos] ${failures.length} variant(s) failed to build:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[demos] ${variants.length} demo variant(s) ready.`);
}

await main();
