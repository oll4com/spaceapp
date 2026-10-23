#!/usr/bin/env node
import { createConnection, createServer } from 'node:net';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, initialize, loadConfig, prepareFiles, preparePty, readPins } from './dev-stack-config.mjs';
import { Processes } from './dev-stack-processes.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const action = process.argv[2] || 'up';
const npm = process.env.npm_execpath;
const npmArgs = args => npm ? [process.execPath, [npm, ...args]] : ['npm', args];

async function request(config, action) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(config.socketRoot, 'control.sock'));
    socket.setTimeout(300_000, () => socket.destroy(new Error('Dev stack control timed out.')));
    socket.once('connect', () => socket.end(`${action}\n`));
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.once('error', reject);
    socket.once('end', () => data.trim() === 'ok' ? resolve() : reject(new Error(data.trim() || 'Dev stack control disconnected.')));
  });
}

async function waitFor(check, label, stopped, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stopped()) throw new Error(`${label} interrupted.`);
    if (await check().catch(() => false)) return;
    await delay(300);
  }
  throw new Error(`${label} did not become ready; inspect .dev-stack/logs.`);
}

async function docker(config, commands) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '--project-name', config.project, '--file', join(config.state, 'compose.json'), ...commands], { cwd: config.root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Docker Compose ${commands[0]} failed (${code}).`)));
  });
}

async function stopOrReset() {
  let config;
  try { config = await loadConfig(root); }
  catch (error) { if (error.code === 'ENOENT') { console.log('No dev stack state in this checkout.'); return; } throw error; }
  try { await request(config, 'down'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await docker(config, ['down', ...(action === 'reset' ? ['--volumes'] : []), '--remove-orphans', '--timeout', '10']);
  if (action === 'reset') {
    // Check ownership again immediately before deletion. Never accept a caller-supplied state path/project.
    await loadConfig(root);
    const info = await lstat(config.socketRoot).catch(() => null);
    if (info) {
      if (info.isSymbolicLink() || await readFile(join(config.socketRoot, 'owner'), 'utf8') !== root) throw new Error('Socket directory ownership changed; refusing reset.');
      await rm(config.socketRoot, { recursive: true });
    }
    await rm(config.state, { recursive: true });
  }
  console.log(`Dev stack ${action === 'reset' ? 'reset' : 'stopped'} (${config.project}).`);
}

async function up() {
  if (process.platform === 'win32') throw new Error('Run dev:stack inside WSL2, with Docker Desktop WSL integration enabled.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 12) throw new Error('Use Node >=22.12 <23, then npm ci.');
  const config = await initialize(root, process.env);
  const pins = await readPins(root);
  await prepareFiles(config, pins);
  const socket = join(config.socketRoot, 'control.sock');
  try { await request(config, 'ping'); throw new Error('This checkout already has a dev stack running.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await rm(socket, { force: true });
  let stopping = false;
  let failure;
  let complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const stop = error => {
    if (error && !failure) { failure = error; console.error(`DEV STACK FAILURE: ${error.message}`); }
    stopping = true;
    complete();
    void processes.stop().catch(error => { failure ??= error; });
  };
  const env = await childEnvironment(config);
  const secrets = await Promise.all(['postgres-password', 'database-url', 'session-secret', 'opencode-password'].map(name => readFile(join(config.state, 'secrets', name), 'utf8')));
  const processes = new Processes({ ...config, env, secrets, onFailure: stop });
  let watchdog;
  let rebuilding = false;
  let cleanupDone;
  const cleaned = new Promise(resolve => { cleanupDone = resolve; });
  const server = createServer({ allowHalfOpen: true }, connection => {
    let message = '';
    connection.on('data', chunk => { message += chunk; if (message.length > 32) connection.destroy(); });
    connection.once('end', () => {
      const command = message.trim();
      if (command === 'ping') return connection.end('ok\n');
      if (command === 'down') { stop(); void cleaned.then(error => connection.end(error ? `${error.message}\n` : 'ok\n')); return; }
      if (command === 'rebuild') {
        if (rebuilding) return connection.end('A rebuild is already running.\n');
        rebuilding = true;
        void (async () => {
          await processes.stop(['api', 'worker', 'cli-host']);
          await build();
          startSources();
          await ready();
          console.log('Internal packages rebuilt; API, worker and CLI host restarted.');
          connection.end('ok\n');
        })().catch(error => { connection.end(`${error.message}\n`); stop(error); }).finally(() => { rebuilding = false; });
        return;
      }
      connection.end('Unknown control command.\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const onSignal = () => stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const runNpm = (name, args, options) => { const [command, argv] = npmArgs(args); return processes.run(name, command, argv, options); };
  const build = async () => {
    if (stopping) throw new Error('Build interrupted.');
    await runNpm('build-packages', ['run', 'check']);
    if (stopping) throw new Error('Build interrupted.');
    await runNpm('build-worker', ['run', 'build', '-w', '@space/worker']);
  };
  const startSources = () => {
    if (stopping) throw new Error('Startup interrupted.');
    processes.start('cli-host', process.execPath, ['--import', 'tsx', 'packages/cli-host/src/main.ts']);
    processes.start('worker', process.execPath, ['apps/worker/dist/worker.js']);
    processes.start('api', process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', '--clear-screen=false', 'apps/api/src/server.ts']);
  };
  const ready = () => waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${config.ports.api}/readyz`, { signal: AbortSignal.timeout(2500) });
    const body = await response.json();
    return response.ok && body.ok === true;
  }, 'API /readyz', () => stopping);
  try {
    console.log(`Starting isolated dev stack ${config.project}; logs: ${join(config.state, 'logs')}`);
    // Docker alone needs the contributor's context/plugin configuration. App and provider children never inherit it.
    const dockerEnv = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    await processes.run('docker-up', 'docker', ['compose', '--project-name', config.project, '--file', join(config.state, 'compose.json'), 'up', '-d', '--wait', '--wait-timeout', '240'], { env: dockerEnv });
    await build();
    await preparePty(root);
    await processes.run('pty-check', process.execPath, ['scripts/contributor-smoke.mjs']);
    await processes.run('migrate', process.execPath, ['packages/db/dist/migrate.js']);
    const vendor = join(config.state, 'vendor');
    await mkdir(vendor, { recursive: true, mode: 0o700 });
    const packageName = pins.opencode.slice(0, pins.opencode.lastIndexOf('@'));
    const version = pins.opencode.slice(pins.opencode.lastIndexOf('@') + 1);
    const installed = await readFile(join(vendor, 'node_modules', packageName, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (installed?.version !== version) {
      await writeFile(join(vendor, 'package.json'), JSON.stringify({ private: true, name: 'spaceapp-dev-tools', dependencies: { [packageName]: version } }), { mode: 0o600 });
      await runNpm('install-opencode', ['install', '--prefix', vendor, '--no-audit', '--no-fund'], { env: { ...env, npm_config_cache: join(config.state, 'npm-cache') } });
    }
    const provider = join(config.state, 'providers/opencode');
    const opencodeEnv = { ...env, HOME: provider, TMPDIR: join(provider, 'tmp'), XDG_CONFIG_HOME: join(provider, 'config'), XDG_DATA_HOME: join(provider, 'data'), XDG_CACHE_HOME: join(provider, 'cache'), XDG_STATE_HOME: join(provider, 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: await readFile(join(config.state, 'secrets/opencode-password'), 'utf8') };
    processes.start('opencode', join(vendor, 'node_modules/.bin/opencode'), ['serve', '--hostname', '127.0.0.1', '--port', String(config.ports.opencode)], { env: opencodeEnv, cwd: join(config.state, 'workspaces') });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${config.ports.opencode}/api/info`, { signal: AbortSignal.timeout(2000), headers: { authorization: `Basic ${Buffer.from(`opencode:${opencodeEnv.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } })).ok, 'OpenCode server', () => stopping);
    startSources();
    processes.start('web', process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(config.ports.web), '--strictPort'], { cwd: join(root, 'apps/web') });
    await ready();
    await waitFor(async () => (await fetch(`http://127.0.0.1:${config.ports.web}/`, { signal: AbortSignal.timeout(2000) })).ok, 'Vite', () => stopping);
    const setup = await fetch(`http://127.0.0.1:${config.ports.api}/api/setup/status`).then(response => response.json());
    console.log(`DEV_STACK_READY http://127.0.0.1:${config.ports.web}`);
    if (setup.setupRequired) console.log(`One-time owner setup token: ${await readFile(join(config.state, 'secrets/setup-token'), 'utf8')}`);
    console.log('Browser/companion services are disabled. API and web reload automatically. After packages/* edits: npm run dev:stack -- rebuild');
    let misses = 0;
    let checking = false;
    watchdog = setInterval(async () => {
      if (checking || rebuilding || stopping) return;
      checking = true;
      try {
        const response = await fetch(`http://127.0.0.1:${config.ports.api}/readyz`, { signal: AbortSignal.timeout(2500) });
        const healthy = response.ok && (await response.json()).ok === true;
        misses = healthy ? 0 : misses + 1;
      } catch { misses++; }
      finally { checking = false; }
      if (misses >= 5) stop(new Error('API readiness failed for 15 seconds (including reload grace).'));
    }, 3000);
    await finished;
  } catch (error) { stop(error); }
  finally {
    clearInterval(watchdog);
    stopping = true;
    await processes.stop().catch(error => { failure ??= error; console.error(error.message); });
    await docker(config, ['down', '--remove-orphans', '--timeout', '10']).catch(error => { failure ??= error; console.error(error.message); });
    await rm(join(config.state, 'runtime.json'), { force: true });
    cleanupDone(failure);
    await new Promise(resolve => server.close(resolve));
    await rm(socket, { force: true });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (failure) throw failure;
}

try {
  if (['down', 'reset'].includes(action)) await stopOrReset();
  else if (action === 'rebuild') await request(await loadConfig(root), 'rebuild');
  else if (action === 'up') await up();
  else throw new Error('Usage: npm run dev:stack [-- up|down|reset|rebuild]');
} catch (error) { console.error(`dev:stack: ${error.message}`); process.exitCode = 1; }
