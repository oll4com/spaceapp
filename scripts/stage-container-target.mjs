#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Per-target workspace and direct runtime dependency specification.
 *
 * - `cli` runs `packages/cli-host/dist/main.js` and `deploy/docker/credential-agent.mjs`.
 * - `browser` runs `apps/api/dist/browser-host-main.js`.
 * - `core` runs `packages/db/dist/migrate.js`, `apps/api/dist/server.js`,
 *   `apps/worker/dist/worker.js`, and `apps/web/server.mjs` (which serves static
 *   `apps/web/dist` using only Node built-in modules).
 */
export const TARGET_SPECS = Object.freeze({
  cli: Object.freeze({
    workspaces: Object.freeze(["packages/cli-host"]),
    excludedPackages: Object.freeze([])
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
    excludedPackages: Object.freeze([
      "@ai-sdk/gateway",
      "@fastify/compress",
      "@fastify/cookie",
      "@fastify/helmet",
      "@fastify/multipart",
      "@fastify/rate-limit",
      "@fastify/websocket",
      "@napi-rs/canvas",
      "@space/cli-host",
      "@space/codex-app-server",
      "@space/gateway",
      "@space/opencode-control",
      "@space/streaming",
      "@temporalio/activity",
      "@temporalio/client",
      "@temporalio/common",
      "@temporalio/core-bridge",
      "@temporalio/interceptors-opentelemetry",
      "@temporalio/proto",
      "@temporalio/worker",
      "@temporalio/workflow",
      "@xmldom/xmldom",
      "@xterm/headless",
      "fastify",
      "imapflow",
      "js-tiktoken",
      "jszip",
      "mammoth",
      "mysql2",
      "node-pty",
      "pdfjs-dist",
      "sanitize-html",
      "typescript",
      "web-tree-sitter"
    ])
  }),
  core: Object.freeze({
    workspaces: Object.freeze([
      "apps/api",
      "apps/web",
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
    excludedPackages: Object.freeze([
      "@codemirror/lang-sql",
      "@formkit/auto-animate",
      "@novnc/novnc",
      "@space/icons",
      "@tanstack/react-table",
      "@tanstack/react-virtual",
      "@types/react",
      "@types/react-dom",
      "@uiw/react-codemirror",
      "@xterm/addon-fit",
      "@xterm/xterm",
      "cube-motion",
      "lucide-react",
      "motion",
      "node-pty",
      "react",
      "react-dom",
      "react-markdown",
      "remark-gfm",
      "sigma",
      "typescript"
    ])
  })
});

export async function computeTargetDependencyClosure(rootDir, target) {
  const spec = TARGET_SPECS[target];
  if (!spec) {
    throw new Error(`Unknown container target: ${target}`);
  }

  const lockfile = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8"));
  const packages = lockfile.packages ?? {};
  const excluded = new Set(spec.excludedPackages);

  const workspaceByName = new Map();
  for (const [pkgPath, meta] of Object.entries(packages)) {
    if (pkgPath && !pkgPath.startsWith("node_modules/") && meta?.name) {
      workspaceByName.set(meta.name, pkgPath);
    }
  }

  const visitedNodeModules = new Set();
  const visitedWorkspaces = new Set(spec.workspaces);
  const queue = [];

  for (const wsPath of spec.workspaces) {
    const wsPkg = JSON.parse(await readFile(join(rootDir, wsPath, "package.json"), "utf8"));
    const deps = target === "core" && wsPath === "apps/web" ? {} : (wsPkg.dependencies ?? {});
    for (const depName of Object.keys(deps)) {
      if (!excluded.has(depName)) {
        queue.push({ name: depName, fromPath: wsPath });
      }
    }
  }

  function resolveLockEntry(depName, fromPath) {
    const prefixes = [];
    if (fromPath) {
      let current = fromPath;
      while (current && current !== ".") {
        prefixes.push(`${current}/node_modules/${depName}`);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    prefixes.push(`node_modules/${depName}`);
    for (const candidate of prefixes) {
      if (packages[candidate]) {
        return { key: candidate, entry: packages[candidate] };
      }
    }
    return null;
  }

  while (queue.length > 0) {
    const { name, fromPath } = queue.shift();
    if (excluded.has(name)) continue;

    if (workspaceByName.has(name)) {
      const wsPath = workspaceByName.get(name);
      if (!visitedWorkspaces.has(wsPath)) {
        visitedWorkspaces.add(wsPath);
        const wsEntry = packages[wsPath] ?? {};
        for (const childDep of Object.keys(wsEntry.dependencies ?? {})) {
          if (!excluded.has(childDep)) {
            queue.push({ name: childDep, fromPath: wsPath });
          }
        }
      }
      continue;
    }

    const resolved = resolveLockEntry(name, fromPath);
    if (!resolved) continue;
    const { key, entry } = resolved;
    if (visitedNodeModules.has(key)) continue;
    visitedNodeModules.add(key);

    const allDeps = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {})
    };
    for (const childDep of Object.keys(allDeps)) {
      if (!excluded.has(childDep)) {
        queue.push({ name: childDep, fromPath: key });
      }
    }
  }

  return {
    target,
    workspaces: [...visitedWorkspaces].sort(),
    nodeModulePaths: [...visitedNodeModules].sort()
  };
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pruneRuntimeDirectory(dir) {
  if (!(await pathExists(dir))) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "tests" || entry.name === "src") {
        await rm(fullPath, { recursive: true, force: true });
        continue;
      }
      await pruneRuntimeDirectory(fullPath);
    } else if (
      entry.name.endsWith(".d.ts") ||
      entry.name.endsWith(".d.mts") ||
      entry.name.endsWith(".js.map") ||
      entry.name.endsWith(".mjs.map") ||
      entry.name.endsWith(".cjs.map") ||
      entry.name.endsWith(".css.map")
    ) {
      await rm(fullPath, { force: true });
    }
  }
}

export async function stageContainerTarget({ rootDir, outDir, target }) {
  const closure = await computeTargetDependencyClosure(rootDir, target);
  const targetRoot = join(outDir, target);
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(join(targetRoot, "node_modules"), { recursive: true });

  for (const wsPath of closure.workspaces) {
    const srcWs = join(rootDir, wsPath);
    const dstWs = join(targetRoot, wsPath);
    await mkdir(dstWs, { recursive: true });
    await cp(join(srcWs, "package.json"), join(dstWs, "package.json"));
    for (const sub of ["dist", "server.mjs", "migrations", "sql", "drizzle"]) {
      const candidate = join(srcWs, sub);
      if (await pathExists(candidate)) {
        await cp(candidate, join(dstWs, sub), { recursive: true });
      }
    }
    await pruneRuntimeDirectory(dstWs);

    const wsPkg = JSON.parse(await readFile(join(srcWs, "package.json"), "utf8"));
    if (wsPkg.name) {
      const wsNodeModuleDst = join(targetRoot, "node_modules", wsPkg.name);
      await mkdir(dirname(wsNodeModuleDst), { recursive: true });
      await cp(dstWs, wsNodeModuleDst, { recursive: true });
    }
  }

  for (const modPath of closure.nodeModulePaths) {
    const srcMod = join(rootDir, modPath);
    if (!(await pathExists(srcMod))) continue;
    const dstMod = join(targetRoot, modPath);
    await mkdir(dirname(dstMod), { recursive: true });
    await cp(srcMod, dstMod, { recursive: true, dereference: false });
  }

  return closure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const outDir = resolve(process.argv[3] ?? "/out");
  for (const target of ["core", "browser", "cli"]) {
    const closure = await stageContainerTarget({ rootDir, outDir, target });
    process.stdout.write(
      `Staged ${target}: ${closure.workspaces.length} workspaces, ${closure.nodeModulePaths.length} node_modules packages\n`
    );
  }
}
