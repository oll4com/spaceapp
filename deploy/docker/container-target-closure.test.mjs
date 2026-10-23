// PR64-01 closure test (node:test + Node built-ins only).
// Red on base: stage-target.mjs does not exist before the per-target closures land.
// Green on HEAD: every target's staging plan excludes foreign packages, keeps its own
// runtime, and the Dockerfile keeps every protected value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync, mkdtempSync, readdirSync, statSync, cpSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
// The committed fixture keeps its built files under `dist.fixture` directories: the public export audit rejects any
// path segment named `dist` (scripts/public-export.mjs) and deploy/docker ships in the public tree. The planner and the
// stager expect `dist`, so the tests run against a copy of the fixture with those directories renamed back.
const FIXTURE_SRC = join(HERE, 'fixtures', 'closure', 'repo');
const FIXTURE = mkdtempSync(join(tmpdir(), 'closure-fixture-'));
cpSync(FIXTURE_SRC, FIXTURE, { recursive: true });
/** Renames every `dist.fixture` directory under `dir` back to `dist`, recursively. @param {string} dir */
const restoreDist = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'dist.fixture') renameSync(join(dir, entry.name), join(dir, 'dist'));
    else restoreDist(join(dir, entry.name));
  }
};
restoreDist(FIXTURE);
process.on('exit', () => rmSync(FIXTURE, { recursive: true, force: true }));

test('the committed fixture keeps its built files out of dist directories', () => {
  const dirs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...dirs(join(dir, e.name))] : []));
  const committed = dirs(FIXTURE_SRC);
  assert.ok(!committed.includes('dist'), 'the public export audit rejects any path segment named dist');
  assert.ok(committed.includes('dist.fixture'), 'the built files live under dist.fixture');
  assert.ok(existsSync(join(FIXTURE, 'packages/cli-host/dist/main.js')), 'the copy the tests use has dist again');
});

const stager = await import(join(HERE, 'stage-target.mjs'));

/** The fixture repository's closure plan for one target. @param {string} name @returns {object} */
const target = (name) => stager.planClosure({ repoRoot: FIXTURE, target: name });

test('cli plan: only the cli-host workspace, every foreign package excluded', () => {
  const plan = target('cli');
  assert.deepEqual(plan.workspaces, ['packages/cli-host']);
  for (const foreign of [
    'apps/api', 'apps/worker', 'apps/web', 'packages/db',
    '@temporalio', 'pdfjs-dist', '@napi-rs/canvas',
  ]) {
    assert.ok(plan.excludes.includes(foreign), `cli plan must exclude ${foreign}`);
  }
  assert.ok(plan.keeps.includes('node-pty'), 'cli keeps node-pty');
  assert.ok(plan.keeps.includes('@space/cli-host'), 'cli keeps @space/cli-host');
  for (const f of plan.files) {
    if (f.from === 'agent-skills') return;
  }
  assert.fail('cli plan must stage agent-skills');
});

test('browser plan: api browser-host closure without cli-host, node-pty or temporal', () => {
  const plan = target('browser');
  assert.ok(plan.workspaces.includes('apps/api'), 'browser runs apps/api (browser-host-main.js)');
  // browser-host-main imports these four, and runtime imports memory-graph
  for (const ws of ['packages/browser-host', 'packages/contracts', 'packages/db', 'packages/runtime', 'packages/memory-graph']) {
    assert.ok(plan.workspaces.includes(ws), `browser stages ${ws}`);
  }
  for (const foreign of [
    '@space/cli-host', 'node-pty', 'packages/cli-host',
    '@temporalio', 'apps/worker',
  ]) {
    assert.ok(plan.excludes.includes(foreign), `browser plan must exclude ${foreign}`);
  }
  assert.ok(!plan.workspaces.includes('apps/web'), 'browser carries no web tree at all');
  assert.ok(!plan.workspaces.includes('apps/worker') && !plan.workspaces.includes('packages/cli-host'), 'browser stages neither the worker nor cli-host');
});

test('core plan: api, worker, web, db and the startup-required cli-host stay', () => {
  const plan = target('core');
  for (const ws of ['apps/api', 'apps/worker', 'apps/web', 'packages/cli-host', 'packages/db']) {
    assert.ok(plan.workspaces.includes(ws), `core keeps ${ws}`);
  }
  // every workspace api and worker import, so that no @space link points at an empty directory
  const imported = [
    'packages/browser-host', 'packages/codex-app-server', 'packages/contracts', 'packages/gateway',
    'packages/memory-graph', 'packages/opencode-control', 'packages/runtime', 'packages/streaming',
  ];
  for (const ws of imported) assert.ok(plan.workspaces.includes(ws), `core stages ${ws}`);
  // apps/web is dist-only in the install list: its 22 client packages never run server-side.
  assert.ok(!plan.installWorkspaces.includes('apps/web'), 'core must not install apps/web client deps');
  for (const ws of ['apps/api', 'apps/worker', 'packages/cli-host', 'packages/db', ...imported]) {
    assert.ok(plan.installWorkspaces.includes(ws), `core installs ${ws}`);
  }
  assert.ok(plan.keeps.includes('node-pty'), 'core keeps node-pty (api loads it at startup)');
  assert.ok(plan.keeps.includes('@temporalio'), 'core keeps the temporal worker stack');
  assert.ok(plan.keeps.includes('agent-skills'), 'core keeps agent-skills');
});

test('staged tree for cli contains no foreign workspace directory', () => {
  const out = mkdtempSync(join(tmpdir(), 'closure-out-cli-'));
  try {
    const manifest = stager.stageClosure({ repoRoot: FIXTURE, target: 'cli', outDir: out });
    assert.ok(existsSync(join(out, 'package.json')));
    assert.ok(existsSync(join(out, 'package-lock.json')));
    assert.ok(existsSync(join(out, 'packages/cli-host/dist/main.js')));
    assert.ok(!existsSync(join(out, 'apps')), 'cli staging must not carry apps/');
    assert.ok(!existsSync(join(out, 'packages/contracts')), 'cli staging must not carry unneeded workspaces');
    assert.equal(manifest.target, 'cli');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('per-target closures exclude foreign packages', () => {
  const cli = target('cli');
  for (const foreign of ['@temporalio', 'pdfjs-dist', '@napi-rs/canvas']) {
    assert.ok(cli.excludes.includes(foreign), `cli excludes ${foreign}`);
  }
  for (const ws of ['apps/api', 'apps/web', 'apps/worker']) {
    assert.ok(!cli.workspaces.includes(ws), `cli carries no ${ws}`);
  }
  const browser = target('browser');
  for (const foreign of ['@temporalio', 'node-pty', 'packages/cli-host']) {
    assert.ok(browser.excludes.includes(foreign), `browser excludes ${foreign}`);
  }
  for (const ws of ['apps/web', 'apps/worker']) {
    assert.ok(!browser.workspaces.includes(ws), `browser carries no ${ws}`);
  }
  const core = target('core');
  for (const keep of ['node-pty', '@space/cli-host', '@temporalio']) {
    assert.ok(core.keeps.includes(keep), `core keeps ${keep} (and with it @temporalio/worker)`);
  }
  assert.ok(!core.excludes.includes('node-pty') && !core.excludes.includes('@space/cli-host'), 'core keeps the startup stack');
});

test('Dockerfile keeps every protected value while the closures land', () => {
  const df = readFileSync(join(REPO, 'Dockerfile'), 'utf8');
  const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  const stages = new Set();
  for (const f of froms) {
    if (f.includes('@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82')) continue;
    if (!f.includes(':') && !f.includes('/')) { stages.add(f); continue; }
    assert.fail(`unpinned external base image: ${f}`);
  }
  assert.ok(stages.has('runtime-base'), 'runtime-base stage kept');
  assert.ok(df.includes('brace-expansion@5.0.12'), 'npm self-patch block kept');
  assert.ok(df.includes('npm@${NPM_VERSION}'), 'npm version pin kept');
  assert.ok(df.includes('ripgrep'), 'runtime tool line kept');
  assert.ok(df.includes('apt-get upgrade -y'), 'apt-get upgrade kept');
  assert.ok(df.includes('--gid 10001') && df.includes('--uid 10001'), 'uid/gid 10001 kept');
  assert.ok(df.includes('HEALTHCHECK'), 'HEALTHCHECK kept');
  assert.ok(df.includes('EXPOSE 4911'), 'EXPOSE 4911 kept');
  assert.ok(df.includes('@opencode/cli@2.0.32'), 'OpenCode 2.0.32 kept');
  assert.ok(df.includes('chromium') && df.includes('fonts-liberation'), 'chromium stack kept');
  assert.ok(/chromium fonts-liberation liblzma5 xvfb/.test(df), 'the browser image carries Xvfb for the default headed browser sessions');
  assert.ok(df.includes('/staging/browser/node_modules/@temporalio'), 'browser strips the temporal stack after install');
  assert.ok(df.match(/install-workspaces\.txt/g)?.length >= 2, 'core and browser install only their install workspaces');
  assert.ok(df.includes('python3-minimal'), 'python3-minimal kept');
  assert.ok(df.includes("-name '*musl*'"), 'foreign-platform (musl/darwin/win32) package strip kept');
  assert.ok(df.includes("node_modules/@opencode -mindepth 1 -maxdepth 1 -type d -name '*musl*' -exec rm -rf {} +"), 'cli strips the musl builds of the OpenCode binary');
  assert.ok(df.includes("case \"$TARGETARCH\""), 'cross-arch native strip keyed on TARGETARCH');
  assert.ok(df.includes('/opt/spaceapp/starter-memory'), 'core installs starter-memory at /opt/spaceapp');
  assert.ok(df.includes('"$tree/node_modules/@types/node"'), 'strip removes @types/node from staged trees');
  assert.ok(df.includes('node-pty/build/Makefile'), 'node-pty build leftovers stripped');
  assert.ok(df.includes('node_modules/@space'), 'broken workspace links swept');
  for (const entry of ['core-entrypoint.sh', 'browser-entrypoint.sh', 'cli-entrypoint.sh']) {
    assert.ok(df.includes(entry), `entrypoint kept: ${entry}`);
  }
});

// The plans against the sources. The images at 2e312b4 shipped a core API that could not
// resolve @space/contracts, gateway or memory-graph and a browser host that could not
// resolve browser-host, contracts, db or runtime: the tables above named too few
// workspaces, and nothing held them to the code. These two tests read the real
// repository, not the fixture: every workspace an image's entrypoints reach through
// value imports is staged, and every staged workspace's own workspace dependencies are
// staged too (or excluded on purpose), so no link npm makes can point at an empty
// directory.

// The files each image runs, as its entrypoint names them; a changed entrypoint fails here.
const ENTRYPOINTS = {
  core: {
    scripts: ['deploy/docker/core-entrypoint.sh', 'deploy/docker/core-supervisor.mjs'],
    entries: ['packages/db/dist/migrate.js', 'deploy/docker/core-supervisor.mjs', 'apps/api/dist/server.js', 'apps/worker/dist/worker.js', 'apps/web/server.mjs'],
  },
  browser: {
    scripts: ['deploy/docker/browser-entrypoint.sh'],
    entries: ['apps/api/dist/browser-host-main.js'],
  },
  cli: {
    scripts: ['deploy/docker/cli-entrypoint.sh'],
    entries: ['packages/cli-host/dist/main.js', 'deploy/docker/credential-agent.mjs'],
  },
};

/**
 * The repository's workspaces: package name to path, and each workspace's dependencies among them.
 * @returns {{ paths: Record<string, string>, deps: Record<string, string[]> }}
 */
function workspaceGraph() {
  const paths = {};
  const deps = {};
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(REPO, group))) {
      const file = join(REPO, group, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      paths[pkg.name] = `${group}/${name}`;
    }
  }
  for (const [name, ws] of Object.entries(paths)) {
    const pkg = JSON.parse(readFileSync(join(REPO, ws, 'package.json'), 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    deps[name] = Object.keys(all).filter((d) => d in paths).sort();
  }
  return { paths, deps };
}

/** The source of a built entry: dist/<x>.js is src/<x>.ts in its workspace; a repository file is itself. @param {string} entry @returns {string} */
const sourceOf = (entry) => entry.replace(/^((?:apps|packages)\/[^/]+)\/dist\/(.+)\.js$/, '$1/src/$2.ts');

// Static and dynamic imports, and require. An `import type`/`export type` statement is
// erased by tsc, and so is a `{ type X }` specifier, so an import whose specifiers are all
// types counts for nothing.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s(?!type\s)([^;'"]*?)from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
/**
 * Whether an import clause brings in a value: an import whose specifiers are all types is erased by tsc.
 * @param {string | undefined} clause the text between `import` and `from`
 * @returns {boolean}
 */
function valueImport(clause) {
  const braces = /\{([^}]*)\}/.exec(clause ?? '');
  if (!braces) return true;
  const names = braces[1].split(',').map((n) => n.trim()).filter(Boolean);
  return names.some((n) => !n.startsWith('type ')) || /^\s*[\w$]+\s*,?\s*\{|\*\s+as/.test(clause);
}
/**
 * Resolves a relative import to a source file next to `from`, trying the TypeScript and module suffixes.
 * @param {string} from the importing file
 * @param {string} spec the relative specifier
 * @returns {string | null}
 */
function resolveRelative(from, spec) {
  const base = join(dirname(from), spec).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, 'index.ts'), `${base}.mjs`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}
/**
 * The @space workspaces an entry reaches: its own import graph, then the packages' declared dependencies.
 * @param {string} entry a built entry path
 * @param {{ paths: Record<string, string>, deps: Record<string, string[]> }} graph
 * @returns {Set<string>}
 */
function reached(entry, graph) {
  const names = new Set();
  const seen = new Set();
  const stack = [join(REPO, sourceOf(entry))];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(file), `entry source missing: ${file}`);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      if (m[2] !== undefined && !valueImport(m[1])) continue;
      const spec = m[2] ?? m[3] ?? m[4];
      if (spec.startsWith('@space/')) names.add(spec.split('/').slice(0, 2).join('/'));
      else if (spec.startsWith('.')) { const r = resolveRelative(file, spec); if (r) stack.push(r); }
    }
  }
  const closure = new Set();
  const todo = [...names];
  while (todo.length) {
    const n = todo.pop();
    if (closure.has(n)) continue;
    closure.add(n);
    todo.push(...(graph.deps[n] ?? []));
  }
  return closure;
}

for (const [name, { scripts, entries }] of Object.entries(ENTRYPOINTS)) {
  test(`${name} plan stages every workspace its entrypoints import`, () => {
    for (const entry of entries) {
      const named = scripts.some((s) => readFileSync(join(REPO, s), 'utf8').includes(entry.replace(/^\/app\//, '')));
      assert.ok(named, `${entry} is what ${scripts.join(' or ')} runs`);
    }
    const graph = workspaceGraph();
    const plan = stager.planClosure({ repoRoot: REPO, target: name });
    for (const entry of entries) {
      for (const pkg of reached(entry, graph)) {
        const ws = graph.paths[pkg];
        assert.ok(ws, `${pkg} is a workspace`);
        assert.ok(plan.workspaces.includes(ws), `${name} stages ${ws}, which ${entry} reaches`);
      }
    }
  });

  test(`${name} plan is closed under workspace dependencies, except what it excludes`, () => {
    const graph = workspaceGraph();
    const plan = stager.planClosure({ repoRoot: REPO, target: name });
    const byPath = Object.fromEntries(Object.entries(graph.paths).map(([n, p]) => [p, n]));
    for (const ws of plan.installWorkspaces) {
      for (const dep of graph.deps[byPath[ws]] ?? []) {
        const depPath = graph.paths[dep];
        const ok = plan.workspaces.includes(depPath) || plan.excludes.includes(depPath) || plan.excludes.includes(dep);
        assert.ok(ok, `${name}: ${ws} depends on ${dep} (${depPath}), which is neither staged nor excluded`);
      }
    }
  });
}
