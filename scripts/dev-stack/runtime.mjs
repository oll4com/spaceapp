// 龙娘 · 2026-10-26: isolated checkout runtime for contributor development (SpaceApp #65).
import { spawn } from 'node:child_process';
import { constants, watch } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertOwnedState } from './state.mjs';

const BUILD_PACKAGES = ['contracts', 'icons', 'streaming', 'opencode-control', 'memory-graph', 'browser-host', 'cli-host', 'codex-app-server', 'runtime', 'db', 'gateway', 'worker'];
// Longniang, 2026-10-28: include all serial command limits, serve readiness and strict API readiness.
export const START_CYCLE_TIMEOUT_MS = BUILD_PACKAGES.length * 300_000 + 600_000 + 300_000 + 120_000 + 60_000 + 120_000;

/** Discover sockets/plugin metadata through Docker's CLI; never parse or copy host config/credentials. */
export async function discoverDocker({ hostEnv = process.env, platform = process.platform, run = runCommand, signal } = {}) {
  signal?.throwIfAborted();
  const home = hostEnv.HOME || '';
  const dockerRoot = hostEnv.DOCKER_CONFIG || (home && path.join(home, '.docker'));
  const candidates = [
    dockerRoot && path.join(dockerRoot, 'cli-plugins'),
    '/usr/local/lib/docker/cli-plugins', '/usr/local/libexec/docker/cli-plugins',
    '/usr/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins',
    ...(platform === 'darwin' ? ['/Applications/Docker.app/Contents/Resources/cli-plugins', '/opt/homebrew/lib/docker/cli-plugins'] : []),
  ].filter(Boolean);
  const contextEnv = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST'].filter(key => hostEnv[key] !== undefined).map(key => [key, hostEnv[key]]));
  // Docker exposes custom cliPluginsExtraDirs as client plugin metadata; the host config stays private.
  let metadata;
  try {
    metadata = (await run('docker', ['info', '--format', '{{json .ClientInfo.Plugins}}'], { env: contextEnv, signal, timeoutMs: 10_000, maxOutputBytes: 65536 })).stdout;
  } catch (error) { signal?.throwIfAborted(); metadata = error.stdout; } // Docker can return client metadata even when its daemon is offline.
  if (metadata) {
    try {
      const plugins = JSON.parse(metadata);
      for (const plugin of Array.isArray(plugins) ? plugins : []) {
        if (plugin.Name === 'compose' && typeof plugin.Path === 'string' && path.isAbsolute(plugin.Path) && path.basename(plugin.Path) === 'docker-compose') candidates.unshift(path.dirname(plugin.Path));
      }
    } catch { /* Missing/older client metadata still permits standard installation paths. */ }
  }
  const pluginDirs = [];
  for (const directory of candidates) {
    try {
      const executable = await realpath(path.join(directory, 'docker-compose'));
      const info = await stat(executable);
      if (info.isFile() && (info.mode & 0o111)) pluginDirs.push(await realpath(directory));
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  let endpoint = hostEnv.DOCKER_HOST;
  if (!endpoint) {
    // Ask Docker for only the selected context's endpoint. Docker owns its metadata parsing;
    // no config.json, credentials or context certificates are read/copied by this script.
    let selected;
    try {
      const result = await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { env: contextEnv, signal, timeoutMs: 10_000, maxOutputBytes: 8192 });
      selected = result.stdout.trim();
    } catch (error) {
      signal?.throwIfAborted();
      if (hostEnv.DOCKER_CONTEXT && hostEnv.DOCKER_CONTEXT !== 'default') throw new Error('The selected Docker context has no usable local Unix socket; start that daemon before running dev:stack.');
    }
    if (selected) {
      if (!selected.startsWith('unix:///')) throw new Error('Development Docker context must select a local Unix socket; remote/TLS contexts are unsupported.');
      try { if ((await stat(selected.slice('unix://'.length))).isSocket()) endpoint = selected; } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      if (!endpoint) throw new Error('The selected Docker context has no usable local Unix socket; start that daemon before running dev:stack.');
    }
  }
  if (!endpoint) {
    const sockets = [
      home && path.join(home, '.docker/run/docker.sock'),
      home && path.join(home, '.colima/default/docker.sock'),
      home && path.join(home, '.colima/docker.sock'),
      home && path.join(home, '.docker/desktop/docker.sock'), '/var/run/docker.sock',
    ].filter(Boolean);
    for (const socket of sockets) {
      try { if ((await stat(socket)).isSocket()) { endpoint = `unix://${socket}`; break; } }
      catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
    }
  }
  return { endpoint, pluginDirs: [...new Set(pluginDirs)] };
}

function transportEnvironment() {
  // Keep explicit transport routing usable without inheriting provider keys, Node hooks or a host Docker config directory.
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'DOCKER_HOST', 'DOCKER_CONTEXT'];
  return Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
}

/** An allowlist, rather than a copy of the caller's provider credentials or Node hooks. */
export function runtimeEnvironment(config, secrets) {
  const at = (...parts) => path.join(config.stateDir, ...parts);
  return {
    ...transportEnvironment(),
    PATH: [at('bin'), path.dirname(process.execPath), ...(process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)].join(path.delimiter),
    HOME: at('home'), USER: 'spaceapp-dev', LOGNAME: 'spaceapp-dev', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    TERM: 'xterm-256color', TMPDIR: at('tmp'), NODE_ENV: 'development',
    XDG_CONFIG_HOME: at('home', 'config'), XDG_DATA_HOME: at('home', 'data'),
    XDG_STATE_HOME: at('home', 'state'), XDG_CACHE_HOME: at('home', 'cache'),
    npm_config_cache: at('npm-cache'), npm_config_userconfig: at('npmrc'), npm_config_globalconfig: at('npm-globalrc'), npm_config_update_notifier: 'false',
    SPACE_INSTANCE: 'dev', SPACE_INSTANCE_ENABLED_JOBS: '', SPACE_INSTALL_ROOT: config.repoRoot,
    SPACE_API_HOST: '127.0.0.1', SPACE_API_PORT: String(config.ports.api),
    SPACE_WEB_HOST: '127.0.0.1', SPACE_WEB_PORT: String(config.ports.web), SPACE_API_ORIGIN: `http://127.0.0.1:${config.ports.api}`,
    SPACE_RUNTIME_STORE: 'postgres', SPACE_DATABASE_URL: `postgresql://spaceapp_dev:${secrets.databasePassword}@127.0.0.1:${config.ports.postgres}/spaceapp_dev`,
    SPACE_SESSION_SECRET: secrets.sessionSecret, SPACE_SETUP_TOKEN_FILE: at('secrets', 'setup-token'), SPACE_DEV_LOGIN: 'false', SPACE_GOOGLE_AUTH_DISABLED: 'true',
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${config.ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: config.projectName,
    SPACE_TEMPORAL_TASK_QUEUE: `${config.projectName}-turns`,
    SPACE_CLI_ENABLED: 'true', SPACE_CLI_COMMAND_PATH: at('bin'), SPACE_CLI_HOST_SOCKET: config.cliSocket,
    SPACE_CLI_WORKSPACE_ROOT: at('workspaces'), SPACE_CLI_ROOT_ENABLED: 'false', SPACE_CLI_ADMIN_HOST_SOCKET: at('disabled-admin.sock'),
    SPACE_CLI_VPN_ENABLED: 'false', SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: 'false',
    SPACE_PUBLIC_DISTRIBUTION: 'true', SPACE_AGENT_TOOLS_WRITER: 'disabled',
    SPACE_AGENT_PANE_ENABLED: 'true', SPACE_ENABLE_CODEX_TURNS: 'false', SPACE_ENABLE_DUMMY_TURNS: 'false',
    SPACE_CODEX_APP_SERVER_ENABLED: 'false', SPACE_CODEX_HOME: at('providers', 'codex'),
    SPACE_CODEX_APP_SERVER_HOME: at('providers', 'codex'), SPACE_CODEX_GOALS_DB_PATH: at('codex-goals.sqlite'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    SPACE_MEMORY_ROOT: at('memory'), SPACE_STARTER_MEMORY_ROOT: path.join(config.repoRoot, 'starter-memory'),
    SPACE_MEMORY_INDEX_PATH: at('memory', 'space_memory.md'), SPACE_MEMORY_MONTHLY_PATH: at('memory', 'space_memory_monthly.md'),
    SPACE_MEMORY_LOCK_PATH: at('memory', '.memory.lock'), SPACE_MEMORY_GRAPH_ROOT: at('memory-graph'),
    SPACE_ARTIFACT_ROOT: at('artifacts'), SPACE_PROJECTS_ROOT: at('workspaces'), SPACE_DOT_WORKSPACE_ROOT: at('workspaces', 'dots'),
    SPACE_DEMO_PROJECTS_ENABLED: 'false', SPACE_DEMO_PROJECTS_ROOT: at('demos'), SPACE_DEMO_PROJECTS_VAR_ROOT: at('demo-state'),
    SPACE_FILES_HOST_MODE: 'disabled', SPACE_OPTIONAL_MODULES: 'none', SPACE_T3CODE_ENABLED: 'false',
    SPACE_BROWSER_SESSIONS_ENABLED: 'false', SPACE_BROWSER_EVIDENCE_ENABLED: 'false', SPACE_BROWSER_TOOL_BRIDGE_ENABLED: 'false',
    SPACE_BROWSER_HOST_SOCKET: at('disabled-browser.sock'), SPACE_ROOM_AGENT_MONITOR_ENABLED: 'false', SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: 'false',
    SPACE_TELEGRAM_SECRET_ROOT: at('telegram'), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: at('telegram', 'ownership.json'),
    SPACE_STREAMING_SECRET_ROOT: at('streaming-secrets'), SPACE_CONNECTOR_KEY_FILE: at('secrets', 'connector.key'),
    SPACE_APP_DIAGNOSTICS_ROOT: at('diagnostics'), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: at('maintenance', 'state.json'),
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: at('account-balancer', 'state.json'), SPACE_CHESS_MOVE_SOCKET: 'disabled',
  };
}

export function composeDocument(config) {
  return {
    name: config.projectName,
    services: {
      postgres: {
        image: config.images.postgres, restart: 'no',
        environment: { POSTGRES_DB: 'spaceapp_dev', POSTGRES_USER: 'spaceapp_dev', POSTGRES_PASSWORD_FILE: '/run/secrets/postgres-password' },
        ports: [`127.0.0.1:${config.ports.postgres}:5432`],
        volumes: ['postgres-data:/var/lib/postgresql/data'], secrets: ['postgres-password'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U spaceapp_dev -d spaceapp_dev'], interval: '2s', timeout: '3s', retries: 60 },
        labels: { 'spaceapp.dev.checkout': config.repoRoot },
      },
      temporal: {
        image: config.images.temporal, restart: 'no',
        depends_on: { postgres: { condition: 'service_healthy' } },
        env_file: [path.join(config.stateDir, 'secrets', 'temporal.env')],
        environment: {
          DB: 'postgres12', DB_PORT: '5432', POSTGRES_USER: 'spaceapp_dev', POSTGRES_SEEDS: 'postgres',
          DBNAME: 'temporal_dev', VISIBILITY_DBNAME: 'temporal_visibility_dev',
          DEFAULT_NAMESPACE: config.projectName, DYNAMIC_CONFIG_FILE_PATH: 'config/dynamicconfig/docker.yaml',
        },
        ports: [`127.0.0.1:${config.ports.temporal}:7233`],
        healthcheck: {
          // 龙娘 · 2026-10-26: the pinned image binds its container IP, so probe its Compose DNS name.
          test: ['CMD-SHELL', `temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace ${config.projectName} --address temporal:7233 >/dev/null`],
          interval: '3s', timeout: '5s', retries: 90,
        },
        labels: { 'spaceapp.dev.checkout': config.repoRoot },
      },
    },
    secrets: { 'postgres-password': { file: path.join(config.stateDir, 'secrets', 'postgres-password') } },
    volumes: { 'postgres-data': { labels: { 'spaceapp.dev.checkout': config.repoRoot } } },
  };
}

async function privateFile(file, contents, mode = 0o600) {
  // O_NOFOLLOW and nlink reject a planted symlink/hardlink instead of truncating its target.
  let previous;
  try { previous = await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) throw new Error(`Unsafe generated state file: ${path.basename(file)}`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try { await handle.chmod(mode); await handle.writeFile(contents); } finally { await handle.close(); }
}

async function privateDirectory(config, relative) {
  // Check each existing component before mkdir: recursive mkdir can follow an intermediate symlink.
  const target = path.resolve(config.stateDir, relative);
  if (!target.startsWith(config.stateDir + path.sep)) throw new Error('Runtime directory must stay in the owned state');
  let current = config.stateDir;
  for (const component of path.relative(config.stateDir, target).split(path.sep)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Unsafe runtime state directory');
    if (!info) await mkdir(current, { mode: 0o700 });
    await chmod(current, 0o700);
  }
}

function wrapperSource(config) {
  const options = {
    state: path.join(config.stateDir, 'providers', 'opencode'), workspaces: path.join(config.stateDir, 'workspaces'),
    executable: path.join(config.stateDir, 'vendor', 'opencode', 'node_modules', '.bin', 'opencode'),
    nodeDirectory: path.dirname(process.execPath), package: config.openCodePackage,
    serverUrl: `http://127.0.0.1:${config.ports.opencode}`, passwordFile: path.join(config.stateDir, 'secrets', 'opencode-server-password'),
  };
  return `#!${process.execPath}
// Longniang, 2026-10-28: panes attach to the supervisor-owned shared server; never start competing standalone stores.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
if (args[0] === '--run-inner') args.shift();
const action = (args[0] ?? '').replace(/^--(?=credential-)/, '');
const ready = existsSync(options.executable);
if (action === 'credential-status') { console.log(ready ? 'READY' : 'NOT_READY'); process.exit(ready ? 0 : 1); }
if (action === 'credential-observation') { console.log(ready ? 'OBSERVATION:' + createHash('sha256').update(options.package + ':installed').digest('hex') : 'OBSERVATION:MISSING'); process.exit(ready ? 0 : 1); }
if (action.startsWith('credential-') || ['setup', 'inspect-env', 'select-free-model', 'check-free-model', 'opencode-text', 'opencode-models'].includes(action)) {
  console.error('This development wrapper supports credential-status, credential-observation and the isolated terminal only. It does not certify provider access.'); process.exit(64);
}
if (!ready) { console.error('Development OpenCode is not installed; run the development stack build.'); process.exit(1); }
const home = options.state;
const env = { PATH: [path.dirname(options.executable), options.nodeDirectory, '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: home,
  USER: 'spaceapp-dev', LOGNAME: 'spaceapp-dev', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: process.env.TERM || 'xterm-256color',
  TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
  XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), OPENCODE_DISABLE_AUTOUPDATE: 'true' };
for (const directory of [home, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]) mkdirSync(directory, { recursive: true, mode: 0o700 });
let cwd = process.cwd();
if (cwd !== options.workspaces && !cwd.startsWith(options.workspaces + path.sep)) { cwd = path.join(options.workspaces, 'default'); mkdirSync(cwd, { recursive: true, mode: 0o700 }); }
if (args[0] === 'login') args.splice(0, 1, 'auth', 'login');
const informational = args.some(arg => ['--version', '-v', '--help', '-h'].includes(arg));
const command = ['auth', 'models', 'version'].includes(args[0]);
if (args.some(arg => arg === '--standalone' || arg.startsWith('--standalone=') || arg === '--server' || arg.startsWith('--server='))) {
  console.error('Development OpenCode connections are managed by the stack supervisor.'); process.exit(64);
}
if (!informational && !command) {
  env.OPENCODE_SERVER_USERNAME = 'opencode';
  env.OPENCODE_SERVER_PASSWORD = readFileSync(options.passwordFile, 'utf8').trim();
  args.unshift('--server', options.serverUrl);
  args.push(cwd);
} else if (!informational && args[0] !== 'version') args.push('--standalone');
const child = spawn(options.executable, args, { cwd, env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', () => { console.error('Could not start isolated development OpenCode.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`;
}

export async function prepareRuntime(config, secrets, { signal, dockerOptions } = {}) {
  signal?.throwIfAborted();
  await assertOwnedState(config);
  for (const relative of ['home', 'tmp', 'npm-cache', 'docker', 'providers/codex', 'providers/opencode/tmp', 'providers/opencode/config', 'providers/opencode/data', 'providers/opencode/state', 'providers/opencode/cache', 'vendor/opencode', 'workspaces/default']) {
    await privateDirectory(config, relative);
  }
  const composeFile = path.join(config.stateDir, 'compose.json');
  await privateFile(composeFile, JSON.stringify(composeDocument(config), null, 2) + '\n');
  // env_file is read by host Compose, so Temporal's different container UID never needs to read a host 0600 bind mount.
  await privateFile(path.join(config.stateDir, 'secrets', 'temporal.env'), `POSTGRES_PWD=${secrets.databasePassword}\n`);
  await privateFile(path.join(config.stateDir, 'npmrc'), 'fund=false\naudit=false\n');
  await privateFile(path.join(config.stateDir, 'npm-globalrc'), '');
  await privateFile(path.join(config.stateDir, 'bin', 'opencode-vscode-parity'), wrapperSource(config), 0o700);
  const docker = await discoverDocker({ ...dockerOptions, signal });
  await privateFile(path.join(config.stateDir, 'docker', 'config.json'), JSON.stringify({ cliPluginsExtraDirs: docker.pluginDirs }) + '\n');
  signal?.throwIfAborted();
  return { env: runtimeEnvironment(config, secrets), composeFile };
}

function commandEnvironment(config) {
  const env = runtimeEnvironment(config, { databasePassword: '', sessionSecret: '' });
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('SPACE_')));
}

/** Bounded one-shot commands; abort terminates only the process group just spawned here. */
export function runCommand(command, args, { cwd, env, signal, timeoutMs = 300_000, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reason, killTimer, settleTimer, finished = false;
    const send = signalName => { if (child.pid) { try { process.kill(-child.pid, signalName); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer);
      signal?.removeEventListener('abort', abort);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const stop = error => {
      if (reason || finished) return;
      reason = error; send('SIGTERM');
      killTimer = setTimeout(() => { send('SIGKILL'); settleTimer = setTimeout(() => finish(reason), 500); }, 2_000);
    };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('Development command aborted'));
    const timer = setTimeout(() => stop(new Error(`Development command timed out: ${path.basename(command)}`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, append] of [['stdout', chunk => { stdout += chunk; }], ['stderr', chunk => { stderr += chunk; }]]) {
      child[stream].setEncoding('utf8').on('data', chunk => {
        append(chunk);
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) stop(new Error('Development command exceeded its output limit'));
      });
    }
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (reason) {
        // A parent can close its pipes before a descendant exits; still kill the owned group.
        send('SIGKILL'); finish(reason);
      } else if (code !== 0) finish(Object.assign(new Error(`Development command failed (${path.basename(command)}, exit ${code})`), { stdout, stderr }));
      else finish();
    });
    if (signal?.aborted) abort();
  });
}

export async function compose(config, args, { signal } = {}) {
  await assertOwnedState(config);
  // Offline down/reset also discover Desktop/Colima without adopting host credentials.
  await privateDirectory(config, 'docker');
  const docker = await discoverDocker({ signal });
  await privateFile(path.join(config.stateDir, 'docker', 'config.json'), JSON.stringify({ cliPluginsExtraDirs: docker.pluginDirs }) + '\n');
  const env = commandEnvironment(config);
  delete env.DOCKER_CONTEXT;
  if (docker.endpoint) env.DOCKER_HOST = docker.endpoint;
  env.DOCKER_CONFIG = path.join(config.stateDir, 'docker');
  return runCommand('docker', ['compose', '--project-name', config.projectName, '--project-directory', config.stateDir, '--file', path.join(config.stateDir, 'compose.json'), ...args], {
    cwd: config.repoRoot, env, signal, timeoutMs: 300_000,
  });
}

export async function buildRuntime(config, env, { signal } = {}) {
  await assertOwnedState(config);
  const buildEnv = commandEnvironment(config);
  for (const name of BUILD_PACKAGES) {
    await runCommand('npm', ['run', 'build', '-w', `@space/${name}`], { cwd: config.repoRoot, env: buildEnv, signal });
  }
  const prefix = path.join(config.stateDir, 'vendor', 'opencode');
  const packageName = config.openCodePackage.slice(0, config.openCodePackage.lastIndexOf('@'));
  const manifestPath = path.join(prefix, 'node_modules', packageName, 'package.json');
  let installed;
  try { installed = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const version = config.openCodePackage.slice(config.openCodePackage.lastIndexOf('@') + 1);
  if (installed?.name !== packageName || installed.version !== version) {
    await runCommand('npm', ['install', '--prefix', prefix, '--save-exact', '--no-audit', '--no-fund', config.openCodePackage], { cwd: config.repoRoot, env: buildEnv, signal, timeoutMs: 600_000 });
  }
  signal?.throwIfAborted();
}

export async function prepareInfrastructure(config, env, { signal } = {}) {
  await compose(config, ['up', '--detach', '--wait', '--wait-timeout', '180'], { signal });
  await runCommand(process.execPath, [path.join(config.repoRoot, 'packages/db/dist/migrate.js')], {
    cwd: config.repoRoot, env, signal, timeoutMs: 120_000,
  });
}

// Longniang, 2026-10-28: the manager owns this foreground serve process and reaps its group on every shutdown/rebuild.
export async function startOpenCodeServer(config, manager, { signal, fetchFn = fetch, timeoutMs = 60_000 } = {}) {
  signal?.throwIfAborted();
  await assertOwnedState(config);
  const home = path.join(config.stateDir, 'providers', 'opencode');
  const executable = path.join(config.stateDir, 'vendor/opencode/node_modules/.bin/opencode');
  const password = (await readFile(path.join(config.stateDir, 'secrets/opencode-server-password'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid development OpenCode server password');
  const env = {
    PATH: [path.dirname(executable), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: home, USER: 'spaceapp-dev', LOGNAME: 'spaceapp-dev', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), OPENCODE_DISABLE_AUTOUPDATE: 'true',
    // Longniang, 2026-10-28: pinned OpenCode 2.0.32 authenticates the fixed user opencode, ignoring a username override.
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password,
  };
  const child = manager.start('opencode-server', executable, ['serve', '--hostname', '127.0.0.1', '--port', String(config.ports.opencode)], { cwd: home, env });
  const deadline = Date.now() + timeoutMs;
  let last = 'server has not answered';
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Development OpenCode server exited before readiness');
    try {
      const response = await fetchFn(`http://127.0.0.1:${config.ports.opencode}/api/info`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now())))]),
      });
      last = `HTTP ${response.status}`;
      if (response.status === 200) {
        const info = await response.json();
        if (info.pid === child.pid && info.version === config.openCodePackage.slice(config.openCodePackage.lastIndexOf('@') + 1) && child.exitCode === null && child.signalCode === null) return;
        last = 'API info did not match the owned process and pinned version';
      } else await response.body?.cancel();
    } catch { signal?.throwIfAborted(); }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`Development OpenCode server readiness timed out: ${last}`);
}

export async function startServices(config, env, manager, { signal } = {}) {
  signal?.throwIfAborted();
  await startOpenCodeServer(config, manager, { signal });
  const nodeOptions = { cwd: config.repoRoot, env };
  const cliEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('SPACE_') || ['SPACE_CLI_HOST_SOCKET', 'SPACE_CLI_HOST_INACTIVE_SESSION_MS'].includes(key)));
  const apiArgs = ['--import', 'tsx', path.join(config.repoRoot, 'apps/api/src/server.ts')];
  manager.start('cli-host', process.execPath, [path.join(config.repoRoot, 'packages/cli-host/dist/main.js')], { ...nodeOptions, env: cliEnv });
  manager.start('worker', process.execPath, [path.join(config.repoRoot, 'apps/worker/dist/worker.js')], nodeOptions);
  manager.start('api', process.execPath, apiArgs, nodeOptions);
  manager.start('web', process.execPath, [path.join(config.repoRoot, 'node_modules/vite/bin/vite.js'), '--strictPort'], { cwd: path.join(config.repoRoot, 'apps/web'), env: { ...commandEnvironment(config), SPACE_WEB_HOST: env.SPACE_WEB_HOST, SPACE_WEB_PORT: env.SPACE_WEB_PORT, SPACE_API_ORIGIN: env.SPACE_API_ORIGIN } });
  let closed = false, timer, pending = Promise.resolve();
  const watcher = watch(path.join(config.repoRoot, 'apps/api/src'), { recursive: true }, (_event, file) => {
    if (closed || !file || !/\.(?:ts|tsx|json)$/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = pending.then(async () => {
        if (closed || signal?.aborted) return;
        await manager.stop('api');
        if (!closed && !signal?.aborted) manager.start('api', process.execPath, apiArgs, nodeOptions);
      }).catch(error => { manager.emit('failure', { name: 'api-watcher', error }); });
    }, 250);
  });
  watcher.on('error', error => manager.emit('failure', { name: 'api-watcher', error }));
  const cleanup = async () => { closed = true; clearTimeout(timer); watcher.close(); signal?.removeEventListener('abort', onAbort); await pending; };
  const onAbort = () => { void cleanup(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) await cleanup();
  return cleanup;
}
