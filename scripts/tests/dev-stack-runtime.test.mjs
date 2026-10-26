// 龙娘 · 2026-10-26: exercise isolation and bounded commands without Docker, a provider or app services.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig, prepareState } from '../dev-stack/state.mjs';
import { composeDocument, prepareRuntime, runCommand, runtimeEnvironment } from '../dev-stack/runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages/run-spaceapp/templates'), { recursive: true });
  for (const relative of ['packages/run-spaceapp/templates/compose.yml', 'Dockerfile']) {
    await writeFile(path.join(root, relative), await readFile(path.join(repoRoot, relative)));
  }
  const config = await loadConfig(root);
  const secrets = await prepareState(config);
  return { config, secrets };
};

test('generated runtime pins checkout-owned infrastructure, localhost bindings and secret files', async t => {
  const { config, secrets } = await fixture(t);
  const { env, composeFile } = await prepareRuntime(config, secrets);
  const document = JSON.parse(await readFile(composeFile, 'utf8'));
  assert.deepEqual(document, composeDocument(config));
  assert.equal(document.name, config.projectName);
  assert.equal(document.services.postgres.environment.POSTGRES_DB, 'spaceapp_dev');
  assert.equal(document.services.temporal.environment.DEFAULT_NAMESPACE, config.projectName);
  assert.ok(document.services.temporal.healthcheck.test[1].includes(config.projectName));
  // The pinned entrypoint defaults BIND_ON_IP to the container IP, not its loopback interface.
  assert.equal(document.services.temporal.healthcheck.test[1].match(/--address temporal:7233/g)?.length, 2);
  assert.ok(!document.services.temporal.healthcheck.test[1].includes('--address 127.0.0.1:7233'));
  assert.deepEqual(document.services.postgres.ports, ['127.0.0.1:15432:5432']);
  assert.deepEqual(document.services.temporal.ports, ['127.0.0.1:17233:7233']);
  for (const service of Object.values(document.services)) assert.match(service.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(document.volumes['postgres-data'].labels['spaceapp.dev.checkout'], config.repoRoot);
  assert.ok(!JSON.stringify(document).includes(secrets.databasePassword));
  assert.ok(!JSON.stringify(document).includes(secrets.sessionSecret));
  for (const relative of ['secrets/postgres-password', 'secrets/temporal.env', 'compose.json', 'npmrc']) {
    assert.equal((await stat(path.join(config.stateDir, relative))).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(document.services.temporal.env_file[0], 'utf8'), `POSTGRES_PWD=${secrets.databasePassword}\n`);
  assert.equal(new URL(env.SPACE_DATABASE_URL).pathname, '/spaceapp_dev');
  assert.equal(env.SPACE_INSTALL_ROOT, config.repoRoot);
  assert.equal(env.SPACE_CLI_ROOT_ENABLED, 'false');
  assert.equal(env.SPACE_CLI_HOST_SOCKET, config.cliSocket);
  assert.equal(env.SPACE_TEMPORAL_TASK_QUEUE, `${config.projectName}-turns`);
  assert.equal(env.SPACE_API_ORIGIN, 'http://127.0.0.1:14910');
  assert.equal(env.SPACE_DEV_LOGIN, 'false');
  for (const key of ['SPACE_MEMORY_ROOT', 'SPACE_MEMORY_INDEX_PATH', 'SPACE_MEMORY_MONTHLY_PATH', 'SPACE_MEMORY_LOCK_PATH', 'SPACE_MEMORY_GRAPH_ROOT', 'SPACE_CLI_WORKSPACE_ROOT', 'SPACE_PROJECTS_ROOT', 'SPACE_ARTIFACT_ROOT', 'HOME', 'TMPDIR']) {
    assert.ok(env[key].startsWith(config.stateDir + path.sep), key);
  }
});

test('runtime environment ignores inherited provider credentials and Node injection settings', async t => {
  const { config, secrets } = await fixture(t);
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'SPACE_CLI_ROOT_ENABLED', 'HOME'];
  const originals = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'synthetic-host-setting';
    const env = runtimeEnvironment(config, secrets);
    for (const key of keys.filter(key => !['HOME', 'SPACE_CLI_ROOT_ENABLED'].includes(key))) assert.equal(env[key], undefined, key);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.equal(env.SPACE_CLI_ROOT_ENABLED, 'false');
  } finally {
    for (const [key, original] of originals) {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
  }
});

test('explicit proxy and Docker endpoint routing survive without importing a host Docker config', async t => {
  const { config, secrets } = await fixture(t);
  const values = { HTTPS_PROXY: 'http://127.0.0.1:8888', DOCKER_HOST: 'unix:///tmp/test-only-docker.sock', DOCKER_CONFIG: '/synthetic/host/docker' };
  const originals = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const env = runtimeEnvironment(config, secrets);
    assert.equal(env.HTTPS_PROXY, values.HTTPS_PROXY);
    assert.equal(env.DOCKER_HOST, values.DOCKER_HOST);
    assert.equal(env.DOCKER_CONFIG, undefined);
  } finally {
    for (const [key, original] of originals) {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
  }
});

test('isolated OpenCode wrapper implements readiness and launches standalone with its own home', async t => {
  const { config, secrets } = await fixture(t);
  const { env } = await prepareRuntime(config, secrets);
  const wrapper = path.join(config.stateDir, 'bin/opencode-vscode-parity');
  const executable = path.join(config.stateDir, 'vendor/opencode/node_modules/.bin/opencode');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));\n`, { mode: 0o700 });
  const status = await runCommand(wrapper, ['--credential-status'], { cwd: config.repoRoot, env });
  assert.equal(status.stdout, 'READY\n');
  const observation = await runCommand(wrapper, ['credential-observation'], { cwd: config.repoRoot, env });
  assert.match(observation.stdout, /^OBSERVATION:[0-9a-f]{64}\n$/);
  const result = JSON.parse((await runCommand(wrapper, ['--run-inner', '--model', 'opencode/example'], {
    cwd: config.repoRoot, env: { ...env, OPENAI_API_KEY: 'synthetic-provider-key', NODE_OPTIONS: '' },
  })).stdout);
  assert.deepEqual(result.args, ['--model', 'opencode/example', '--standalone']);
  assert.equal(result.cwd, path.join(config.stateDir, 'workspaces/default'));
  assert.equal(result.env.HOME, path.join(config.stateDir, 'providers/opencode'));
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) assert.ok(result.env[key].startsWith(result.env.HOME + path.sep));
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SPACE_SESSION_SECRET', 'SPACE_DATABASE_URL', 'NODE_OPTIONS']) assert.equal(result.env[key], undefined, key);
  await assert.rejects(runCommand(wrapper, ['credential-smoke'], { cwd: config.repoRoot, env }), /exit 64/);
});

test('generated files refuse symlink targets instead of modifying another file', async t => {
  const { config, secrets } = await fixture(t);
  const outside = path.join(config.repoRoot, 'outside.txt');
  await writeFile(outside, 'unchanged');
  await symlink(outside, path.join(config.stateDir, 'compose.json'));
  await assert.rejects(prepareRuntime(config, secrets), /Unsafe generated state file/);
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
});

test('runtime rejects intermediate directory symlinks before creating outside children', async t => {
  const { config, secrets } = await fixture(t);
  const outside = path.join(config.repoRoot, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(config.stateDir, 'home'));
  await assert.rejects(prepareRuntime(config, secrets), /Unsafe runtime state directory/);
  await assert.rejects(stat(path.join(outside, 'config')), { code: 'ENOENT' });
});

test('one-shot commands fail on nonzero exit and stop on timeout or abort', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)'], { env: {} }), /exit 7/);
  const before = Date.now();
  await assert.rejects(runCommand(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { env: {}, timeoutMs: 50 }), /timed out/);
  assert.ok(Date.now() - before < 4_000, 'termination is bounded even when TERM is ignored');
  const controller = new AbortController();
  const running = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('synthetic cancellation')), 50);
  await assert.rejects(running, /synthetic cancellation/);
});

test('Vite retains default API origin and allows isolated development override for every proxy', async () => {
  const text = await readFile(path.join(repoRoot, 'apps/web/vite.config.ts'), 'utf8');
  assert.match(text, /process\.env\.SPACE_API_ORIGIN \?\? "http:\/\/127\.0\.0\.1:4910"/);
  for (const route of ['/api', '/plugins']) assert.ok(text.includes(`"${route}": { target: apiOrigin, ws: true }`));
  for (const route of ['/healthz', '/readyz', '/version']) assert.ok(text.includes(`"${route}": apiOrigin`));
});

test('Vite forwards API and plugin WebSocket upgrades to the selected isolated origin', async t => {
  const upstream = createHttpServer();
  const sockets = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, connection => connection.send(`proxied:${request.url}`));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise(resolve => upstream.close(resolve));
  });
  const original = process.env.SPACE_API_ORIGIN;
  process.env.SPACE_API_ORIGIN = `http://127.0.0.1:${upstream.address().port}`;
  let vite;
  try {
    const { createServer } = await import('vite');
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'sv-'));
    t.after(() => rm(cacheDir, { recursive: true, force: true }));
    vite = await createServer({
      configFile: path.join(repoRoot, 'apps/web/vite.config.ts'), root: path.join(repoRoot, 'apps/web'), cacheDir,
      logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false, preTransformRequests: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
  } finally {
    if (original === undefined) delete process.env.SPACE_API_ORIGIN; else process.env.SPACE_API_ORIGIN = original;
  }
  t.after(() => vite.close());
  await vite.listen();
  for (const route of ['/api/dev-stack-socket', '/plugins/dev-stack-socket']) {
    const output = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${vite.httpServer.address().port}${route}`);
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket proxy did not forward the upgrade')); }, 3_000);
      socket.on('error', reject);
      socket.once('message', message => { clearTimeout(timeout); socket.close(); resolve(message.toString()); });
    });
    assert.equal(output, `proxied:${route}`);
  }
});
