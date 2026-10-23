#!/usr/bin/env node
// PR64-01 per-target staging helper (node built-ins only).
//
// planClosure({repoRoot, target})  -> the closure plan: workspaces kept, packages and
//                                     directories excluded, files carried over.
// stageClosure({repoRoot, target, outDir}) -> writes the staged tree for the target's
//                                     runtime stage and returns the same plan.
//
// The plans are declared, not discovered: each target names the workspaces it runs and
// the packages it must never ship. The closure test holds this file to those tables, and
// holds each table to the imports the target's entrypoints reach in the sources.
//
// A plan's workspaces are closed under the workspace dependencies in package.json: an
// installed workspace links every @space package it depends on, and npm creates the
// link's target directory for the nested node_modules the lockfile records there even
// when the workspace is not staged, so a workspace left out leaves a link to a directory
// with no package in it, and the runtime fails on the first import of it.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT_PACKAGE = { name: 'spaceapp', private: true };

const TARGETS = {
  core: {
    // apps/api (server.js) and apps/worker (worker.js) and everything they import:
    // runtime, streaming, db, cli-host, contracts, memory-graph, gateway, browser-host,
    // codex-app-server and opencode-control, each a value import in the sources.
    workspaces: [
      'apps/api', 'apps/worker', 'apps/web',
      'packages/browser-host', 'packages/cli-host', 'packages/codex-app-server',
      'packages/contracts', 'packages/db', 'packages/gateway', 'packages/memory-graph',
      'packages/opencode-control', 'packages/runtime', 'packages/streaming',
    ],
    // apps/web is staged dist-only: its 22 client packages (react, codemirror,
    // xterm...) are bundled by vite and never run in the server. Installing them
    // would blow the 850 MiB core budget for nothing.
    installWorkspaces: [
      'apps/api', 'apps/worker',
      'packages/browser-host', 'packages/cli-host', 'packages/codex-app-server',
      'packages/contracts', 'packages/db', 'packages/gateway', 'packages/memory-graph',
      'packages/opencode-control', 'packages/runtime', 'packages/streaming',
    ],
    excludes: [],
    keeps: ['node-pty', '@space/cli-host', '@temporalio', 'agent-skills'],
    files: [
      ['agent-skills', 'agent-skills'],
      ['starter-memory', 'starter-memory'],
      ['LICENSE', 'LICENSE'],
      ['NOTICE', 'NOTICE'],
      ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
      ['scripts/reset-owner-password.mjs', 'scripts/reset-owner-password.mjs'],
      ['scripts/rotate-owner-setup-token.mjs', 'scripts/rotate-owner-setup-token.mjs'],
      ['scripts/portable-backup.mjs', 'scripts/portable-backup.mjs'],
      ['scripts/portable-restore.mjs', 'scripts/portable-restore.mjs'],
    ],
  },
  browser: {
    // apps/api (browser-host-main.js) imports browser-host, contracts, db and runtime,
    // and runtime imports memory-graph. The rest of api's workspace dependencies are
    // staged too, so that every link npm makes for api resolves to a package; cli-host
    // is the exception, removed after the install with node-pty and the Temporal stack.
    workspaces: [
      'apps/api',
      'packages/browser-host', 'packages/codex-app-server', 'packages/contracts',
      'packages/db', 'packages/gateway', 'packages/memory-graph',
      'packages/opencode-control', 'packages/runtime', 'packages/streaming',
    ],
    excludes: [
      '@space/cli-host', 'node-pty', 'packages/cli-host',
      '@temporalio', 'apps/worker',
    ],
    keeps: [],
    files: [
      ['LICENSE', 'LICENSE'],
      ['NOTICE', 'NOTICE'],
      ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ],
  },
  cli: {
    workspaces: ['packages/cli-host'],
    excludes: [
      'apps/api', 'apps/worker', 'apps/web', 'packages/db',
      '@temporalio', 'pdfjs-dist', '@napi-rs/canvas',
    ],
    keeps: ['node-pty', '@space/cli-host'],
    files: [
      ['agent-skills', 'agent-skills'],
      ['LICENSE', 'LICENSE'],
      ['NOTICE', 'NOTICE'],
      ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
    ],
  },
};

const WORKSPACE_PAYLOAD = {
  'apps/api': [['dist', 'dist', true], ['public', 'public', false]],
  'apps/worker': [['dist', 'dist', true]],
  'packages/runtime': [['dist', 'dist', true]],
  'packages/streaming': [['dist', 'dist', true]],
  'apps/web': [['dist', 'dist', true], ['public', 'public', false], ['server.mjs', 'server.mjs', true]],
  'packages/cli-host': [['dist', 'dist', true]],
  'packages/db': [['dist', 'dist', true], ['migrations', 'migrations', true]],
  'packages/contracts': [['dist', 'dist', true]],
  // gateway loads its tree-sitter grammars from grammars/ next to dist/ at run time
  'packages/gateway': [['dist', 'dist', true], ['grammars', 'grammars', true]],
};

/**
 * The declared closure of one image target: the workspaces it runs, the ones whose dependencies are
 * installed, the packages it must keep or never ship, and the repository files it carries.
 * @param {{ repoRoot: string, target: 'core' | 'browser' | 'cli' }} options
 * @returns {{ target: string, workspaces: string[], installWorkspaces: string[], keeps: string[], excludes: string[], files: { from: string, to: string }[] }}
 */
export function planClosure({ repoRoot, target }) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unknown target: ${target}`);
  const workspaces = [];
  for (const ws of spec.workspaces) {
    const pkg = join(repoRoot, ws, 'package.json');
    if (!existsSync(pkg)) throw new Error(`workspace missing: ${ws}`);
    workspaces.push(ws);
  }
  return {
    target,
    workspaces,
    installWorkspaces: spec.installWorkspaces ?? [...workspaces],
    keeps: [...spec.keeps],
    excludes: [...spec.excludes],
    files: spec.files.map(([from, to]) => ({ from, to })),
  };
}

/**
 * Copies the target's closure from the repository into `outDir`: a pruned root package.json, each
 * workspace's package.json and built payload, the lockfile, the plan's files, and the list files the
 * Dockerfile reads (workspaces, install-workspaces, excludes).
 * @param {{ repoRoot: string, target: string, outDir: string }} options
 * @returns {ReturnType<typeof planClosure> & { files: string[] }} the plan plus every path written
 */
export function stageClosure({ repoRoot, target, outDir }) {
  const plan = planClosure({ repoRoot, target });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const pruned = { ...ROOT_PACKAGE, workspaces: plan.workspaces };
  for (const key of ['packageManager', 'engines']) {
    if (root[key] !== undefined) pruned[key] = root[key];
  }
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pruned, null, 2) + '\n');
  const files = [join(outDir, 'package.json')];

  for (const ws of plan.workspaces) {
    const src = join(repoRoot, ws);
    const dest = join(outDir, ws);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(src, 'package.json'), join(dest, 'package.json'));
    files.push(join(dest, 'package.json'));
    for (const [from, to, required] of WORKSPACE_PAYLOAD[ws] ?? [['dist', 'dist', true]]) {
      const fromPath = join(src, from);
      if (!existsSync(fromPath)) {
        if (required) throw new Error(`workspace payload missing: ${ws}/${from}`);
        continue;
      }
      cpSync(fromPath, join(dest, to), { recursive: true });
      files.push(join(dest, to));
    }
  }

  const lock = join(repoRoot, 'package-lock.json');
  if (existsSync(lock)) {
    cpSync(lock, join(outDir, 'package-lock.json'));
    files.push(join(outDir, 'package-lock.json'));
  }
  writeFileSync(join(outDir, 'workspaces.txt'), plan.workspaces.join('\n') + '\n');
  files.push(join(outDir, 'workspaces.txt'));
  const installWorkspaces = plan.installWorkspaces;
  writeFileSync(join(outDir, 'install-workspaces.txt'), installWorkspaces.join('\n') + '\n');
  files.push(join(outDir, 'install-workspaces.txt'));
  writeFileSync(join(outDir, 'excludes.txt'), plan.excludes.join('\n') + (plan.excludes.length ? '\n' : ''));
  files.push(join(outDir, 'excludes.txt'));
  for (const { from, to } of plan.files) {
    const src = join(repoRoot, from);
    if (!existsSync(src)) throw new Error(`required file missing: ${from}`);
    const dest = join(outDir, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    files.push(dest);
  }
  return { ...plan, files };
}

/**
 * Checks an installed staging tree against its plan: every required payload present, no excluded
 * package or path shipped, every keep present in node_modules. Throws with the full list of problems.
 * @param {{ root: string, target: string }} options
 * @returns {{ target: string, ok: true }}
 */
export function verifyStaged({ root, target }) {
  const plan = planClosure({ repoRoot: root, target });
  const problems = [];
  for (const ws of plan.workspaces) {
    for (const [from, to, required] of WORKSPACE_PAYLOAD[ws] ?? [['dist', 'dist', true]]) {
      if (!required && !existsSync(join(root, ws, from))) continue;
      if (!existsSync(join(root, ws, from))) problems.push(`workspace payload missing: ${ws}/${from}`);
    }
  }
  for (const foreign of plan.excludes) {
    if (existsSync(join(root, 'node_modules', foreign))) problems.push(`foreign package shipped: ${foreign}`);
    if (existsSync(join(root, foreign))) problems.push(`foreign path shipped: ${foreign}`);
  }
  for (const keep of plan.keeps) {
    if (keep === 'agent-skills' && !existsSync(join(root, 'agent-skills'))) problems.push('keep missing: agent-skills');
    if (keep === 'apps/web' && !existsSync(join(root, 'apps/web/dist'))) problems.push('keep missing: apps/web dist');
    if (keep !== 'agent-skills' && keep !== 'apps/web' && !existsSync(join(root, 'node_modules', keep))) problems.push(`keep missing: node_modules/${keep}`);
  }
  if (problems.length) throw new Error(`staged ${target} verification failed:\n  ${problems.join('\n  ')}`);
  return { target, ok: true };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const target = arg('--target');
  const repoRoot = arg('--repo-root') ?? process.cwd();
  const mode = process.argv.includes('--verify');
  if (mode) {
    const root = arg('--repo-root') ?? process.cwd();
    verifyStaged({ root, target });
    console.log(`staged ${target} verified: workspaces present, excludes absent`);
    process.exit(0);
  }
  const outDir = arg('--staging');
  if (!target || !outDir) {
    console.error('usage: stage-target.mjs --target <core|browser|cli> --staging <dir> [--repo-root <dir>]');
    console.error('       stage-target.mjs --verify --target <core|browser|cli> [--repo-root <dir>]');
    process.exit(2);
  }
  const manifest = stageClosure({ repoRoot, target, outDir });
  console.log(JSON.stringify(manifest, null, 2));
}
