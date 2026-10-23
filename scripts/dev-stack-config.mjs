import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readPins(root) {
  root = root instanceof URL ? fileURLToPath(root) : root;
  const compose = await readFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8');
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const image = service => {
    const value = compose.match(new RegExp(`^  ${service}:\\n\\s+image: ([^\\n]+)`, 'm'))?.[1];
    if (!value || !/@sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`Missing pinned ${service} image in public compose.`);
    return value;
  };
  const opencode = dockerfile.match(/(?:@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
  if (!opencode) throw new Error('Missing pinned OpenCode package in Dockerfile.');
  return { postgres: image('postgres'), temporal: image('temporal'), opencode };
}

const defaults = { api: 15410, web: 15411, postgres: 15432, temporal: 17233, opencode: 15412 };

export async function preparePty(root, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return;
  // node-pty 1.1.0's macOS npm prebuild ships this executable as 0644.
  // Touch only its helper, not the native addon or the rest of node_modules.
  for (const directory of [`prebuilds/${platform}-${arch}`, 'build/Release']) {
    const helper = join(root, 'node_modules/node-pty', directory, 'spawn-helper');
    const info = await lstat(helper).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isFile() && !info.isSymbolicLink()) await chmod(helper, 0o755);
  }
}

export async function loadConfig(root) {
  root = await realpath(root);
  const state = join(root, '.dev-stack');
  const info = await lstat(state);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Dev stack state must be an owned directory, not a symlink.');
  const config = JSON.parse(await readFile(join(state, 'owner.json'), 'utf8'));
  const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
  if (config.root !== root || config.state !== state || config.project !== `spaceapp-dev-${id}` || config.socketRoot !== `/tmp/spaceapp-dev-${id}`) {
    throw new Error('Dev stack state does not belong to this checkout; refusing cleanup.');
  }
  return config;
}

export async function initialize(root, env) {
  root = await realpath(root);
  const state = join(root, '.dev-stack');
  const ports = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
    const value = env[`SPACE_DEV_${name.toUpperCase()}_PORT`] ?? String(fallback);
    if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535) throw new Error(`Invalid ${name} port; use 1024–65535.`);
    return [name, +value];
  }));
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('Dev stack ports must be distinct.');
  try { await lstat(state); return await loadConfig(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const config = { root, state, project: `spaceapp-dev-${id}`, socketRoot: `/tmp/spaceapp-dev-${id}`, ports };
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, 'owner.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  for (const name of ['secrets', 'bin', 'home', 'logs', 'memory', 'memory-graph', 'artifacts', 'workspaces', 'providers/opencode', 'providers/opencode/tmp']) {
    await mkdir(join(state, name), { recursive: true, mode: 0o700 });
  }
  const password = randomBytes(32).toString('hex');
  for (const [name, value] of Object.entries({
    'postgres-password': password,
    'database-url': `postgresql://spaceapp:${password}@127.0.0.1:${ports.postgres}/spaceapp`,
    'session-secret': randomBytes(48).toString('hex'),
    'setup-token': randomBytes(32).toString('hex'),
    'opencode-password': randomBytes(32).toString('hex')
  })) await writeFile(join(state, 'secrets', name), value, { flag: 'wx', mode: 0o600 });
  return config;
}

export function composeDocument(config, pins) {
  return {
    name: config.project,
    services: {
      postgres: {
        image: pins.postgres,
        environment: { POSTGRES_DB: 'spaceapp', POSTGRES_USER: 'spaceapp', POSTGRES_PASSWORD_FILE: '/run/secrets/postgres-password' },
        ports: [`127.0.0.1:${config.ports.postgres}:5432`],
        volumes: ['postgres-data:/var/lib/postgresql/data'], secrets: ['postgres-password'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U spaceapp -d spaceapp'], interval: '2s', timeout: '5s', retries: 60 }
      },
      temporal: {
        image: pins.temporal,
        depends_on: { postgres: { condition: 'service_healthy' } },
        environment: { DB: 'postgres12', DB_PORT: '5432', POSTGRES_USER: 'spaceapp', POSTGRES_SEEDS: 'postgres', DYNAMIC_CONFIG_FILE_PATH: 'config/dynamicconfig/docker.yaml' },
        entrypoint: ['/bin/sh', '-ec'],
        command: ['export POSTGRES_PWD="$$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup'],
        ports: [`127.0.0.1:${config.ports.temporal}:7233`], secrets: ['postgres-password'],
        healthcheck: { test: ['CMD-SHELL', 'temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null'], interval: '3s', timeout: '10s', retries: 80 }
      }
    },
    secrets: { 'postgres-password': { file: './secrets/postgres-password' } },
    volumes: { 'postgres-data': {} }
  };
}

export async function prepareFiles(config, pins) {
  const { state, root, socketRoot } = config;
  await writeFile(join(state, 'compose.json'), JSON.stringify(composeDocument(config, pins), null, 2), { mode: 0o600 });
  // Unix sockets have a 104-byte path limit on macOS; use a short, independently owned directory.
  try {
    await mkdir(socketRoot, { mode: 0o700 });
    await writeFile(join(socketRoot, 'owner'), root, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST' || (await lstat(socketRoot)).isSymbolicLink() || await readFile(join(socketRoot, 'owner'), 'utf8') !== root) {
      throw new Error('Dev stack socket directory is not owned by this checkout.', { cause: error });
    }
  }
  for (const name of ['space_memory.md', 'space_memory_monthly.md', 'installation-guide.md']) {
    try { await copyFile(join(root, 'starter-memory', name), join(state, 'memory', name), 1); await chmod(join(state, 'memory', name), 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(state, 'bin', 'opencode-vscode-parity'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'scripts/dev-stack-opencode.mjs'))} ${quote(state)} "$@"\n`, { mode: 0o700 });
}

export async function childEnvironment(config, inherited = process.env) {
  const { state, root, socketRoot, ports } = config;
  const secret = name => readFile(join(state, 'secrets', name), 'utf8');
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'CI'].filter(key => inherited[key]).map(key => [key, inherited[key]]));
  return {
    ...env, HOME: join(state, 'home'), XDG_CONFIG_HOME: join(state, 'home/config'), XDG_DATA_HOME: join(state, 'home/data'), XDG_CACHE_HOME: join(state, 'home/cache'),
    PATH: `${join(state, 'bin')}:${root}/node_modules/.bin:${inherited.PATH || '/usr/bin:/bin'}`,
    SPACE_PUBLIC_DISTRIBUTION: 'true', SPACE_DEV_LOGIN: 'false', SPACEAPP_WORKFLOWS_ENABLED: 'true',
    SPACE_API_HOST: '127.0.0.1', SPACE_API_PORT: String(ports.api), SPACE_WEB_HOST: '127.0.0.1', SPACE_WEB_PORT: String(ports.web), SPACE_API_ORIGIN: `http://127.0.0.1:${ports.api}`,
    SPACE_RUNTIME_STORE: 'postgres', SPACE_DATABASE_URL: await secret('database-url'), SPACE_SESSION_SECRET: await secret('session-secret'), SPACE_SETUP_TOKEN_FILE: join(state, 'secrets/setup-token'),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`, SPACE_TEMPORAL_TASK_QUEUE: config.project,
    SPACE_CLI_ENABLED: 'true', SPACE_CLI_HOST_SOCKET: join(socketRoot, 'host.sock'), SPACE_CLI_COMMAND_PATH: join(state, 'bin'), SPACE_CLI_WORKSPACE_ROOT: join(state, 'workspaces'),
    SPACE_MEMORY_ROOT: join(state, 'memory'), SPACE_STARTER_MEMORY_ROOT: join(root, 'starter-memory'), SPACE_MEMORY_INDEX_PATH: join(state, 'memory/space_memory.md'), SPACE_MEMORY_MONTHLY_PATH: join(state, 'memory/space_memory_monthly.md'), SPACE_MEMORY_LOCK_PATH: join(state, 'memory/.memory.lock'), SPACE_MEMORY_GRAPH_ROOT: join(state, 'memory-graph'), SPACE_ARTIFACT_ROOT: join(state, 'artifacts'),
    SPACE_CODEX_HOME: join(state, 'providers/codex'), SPACE_CODEX_APP_SERVER_HOME: join(state, 'providers/codex'), SPACE_CODEX_GOALS_DB_PATH: join(state, 'codex-goals.sqlite'), SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: join(state, 'codex-cli-mode-defaults.json'),
    SPACE_TELEGRAM_SECRET_ROOT: join(state, 'telegram'), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(state, 'telegram/ownership.json'), SPACE_STREAMING_SECRET_ROOT: join(state, 'streaming'),
    SPACE_APP_DIAGNOSTICS_ROOT: join(state, 'diagnostics'), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(state, 'maintenance/state.json'), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(state, 'balancer/state.json'), SPACE_CONNECTOR_KEY_FILE: join(state, 'secrets/connector.key'), SPACE_DESIGN_GATEWAY_KEY_FILE: join(state, 'secrets/design.key'),
    SPACE_INSTALL_ROOT: join(state, 'workspaces'), SPACE_PROJECTS_ROOT: join(state, 'workspaces'), SPACE_DEMO_PROJECTS_VAR_ROOT: join(state, 'demo-projects'),
    SPACE_DEMO_PROJECTS_ENABLED: 'false', SPACE_BROWSER_SESSIONS_ENABLED: 'false', SPACE_BROWSER_EVIDENCE_ENABLED: 'false', SPACE_FILES_HOST_MODE: 'disabled', SPACE_CLI_ROOT_ENABLED: 'false', SPACE_T3CODE_ENABLED: 'false', SPACE_AGENT_TOOLS_WRITER: 'disabled', SPACE_TELEMETRY_ENABLED: 'false', SPACE_CHESS_MOVE_SOCKET: 'disabled',
    SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: 'false', SPACE_STREAMING_BOT_API_BASE_URL: `http://127.0.0.1:${ports.api}`
  };
}
