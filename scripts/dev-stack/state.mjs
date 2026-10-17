import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const ownerLabel = 'io.spaceapp.dev-stack.owner';
export const privateWrite = async (file, value, options = {}) => {
  const existing = await lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Refusing linked/non-file private output.');
  await writeFile(file, value, { mode: 0o600, ...options });
  await chmod(file, 0o600);
};
export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
export function locations(root, env = {}) {
  const name = env.SPACE_DEV_STATE_DIR || '.dev-stack';
  // A direct, recognizable child only; down/reset never accept an arbitrary deletion target.
  if (isAbsolute(name) || !/^\.dev-stack(?:-[a-zA-Z0-9_-]+)?$/.test(name)) {
    throw new Error('SPACE_DEV_STATE_DIR must be .dev-stack or .dev-stack-<name> inside this checkout.');
  }
  const state = join(resolve(root), name);
  const port = (key, fallback) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || +raw < 1024 || +raw > 65535 || [4910, 4911].includes(+raw)) throw new Error(`Invalid/nonisolated ${key}.`);
    return +raw;
  };
  const ports = { api: port('SPACE_DEV_API_PORT', 4810), web: port('SPACE_DEV_WEB_PORT', 4811), postgres: port('SPACE_DEV_POSTGRES_PORT', 54329), temporal: port('SPACE_DEV_TEMPORAL_PORT', 47233) };
  if (new Set(Object.values(ports)).size !== 4) throw new Error('Dev-stack ports must be distinct.');
  return { root: resolve(root), state, ports, manifest: join(state, 'owner.json'), compose: join(state, 'compose.json'), supervisor: join(state, 'supervisor.json') };
}
export async function assertPlainState(config) {
  const root = await realpath(config.root);
  const info = await lstat(config.state).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (info && (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(config.state)) !== root)) throw new Error('Refusing linked/non-owned dev-stack state.');
}
export async function loadOwner(config) {
  await assertPlainState(config);
  const info = await lstat(config.manifest);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid dev-stack owner manifest.');
  const owner = await readJson(config.manifest);
  if (owner.version !== 1 || owner.root !== await realpath(config.root) || owner.state !== await realpath(config.state) || !/^[a-f0-9]{32}$/.test(owner.nonce) || owner.project !== `spaceapp-dev-${owner.nonce.slice(0, 16)}`) throw new Error('State does not belong to this checkout.');
  for (const directory of ['secrets', 'logs', 'run', 'home', 'tmp', 'cli', 'cli/bin', 'cli/vendor', 'providers', 'providers/opencode']) {
    const info = await lstat(join(config.state, directory)).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Refusing linked/non-directory private state path.');
  }
  return owner;
}
export async function initialize(config) {
  await assertPlainState(config);
  const existing = await lstat(config.state).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (existing) return loadOwner(config); // Never adopt an unknown/nonempty directory.
  await mkdir(config.state, { mode: 0o700 });
  const nonce = randomBytes(16).toString('hex');
  const owner = { version: 1, root: await realpath(config.root), state: await realpath(config.state), nonce, project: `spaceapp-dev-${nonce.slice(0, 16)}`, ports: config.ports };
  await privateWrite(config.manifest, JSON.stringify(owner, null, 2) + '\n', { flag: 'wx' });
  for (const sub of ['secrets', 'logs', 'run', 'home', 'tmp', 'workspaces', 'memory', 'artifacts', 'providers/opencode', 'cli/bin', 'cli/vendor']) await mkdir(join(config.state, sub), { recursive: true, mode: 0o700 });
  for (const secret of ['postgres-password', 'session-secret', 'setup-token']) await privateWrite(join(config.state, 'secrets', secret), randomBytes(32).toString('hex'), { flag: 'wx' });
  return owner;
}
export function extractPins(composeSource, dockerfile) {
  const image = service => {
    const section = composeSource.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-zA-Z]|^networks:|$(?![\\s\\S]))`, 'm'))?.[1];
    const pin = section?.match(/^ {4}image:\s*([^\s]+@sha256:[a-f0-9]{64})\s*$/m)?.[1];
    if (!pin) throw new Error(`No canonical digest pin for ${service}.`);
    return pin;
  };
  const opencode = dockerfile.match(/\bopencode-ai@([0-9]+\.[0-9]+\.[0-9]+)\b/)?.[1];
  if (!opencode) throw new Error('No pinned opencode-ai version in Dockerfile.');
  return { postgres: image('postgres'), temporal: image('temporal'), opencode };
}
export function composeDocument(owner, pins, password) {
  const labels = { [ownerLabel]: owner.nonce };
  return {
    services: {
      postgres: { image: pins.postgres, labels, environment: { POSTGRES_USER: 'spaceapp', POSTGRES_DB: 'spaceapp_dev', POSTGRES_PASSWORD: password }, ports: [`127.0.0.1:${owner.ports.postgres}:5432`], volumes: ['postgres:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U spaceapp -d spaceapp_dev'], interval: '2s', timeout: '5s', retries: 90 } },
      temporal: { image: pins.temporal, labels, depends_on: { postgres: { condition: 'service_healthy' } }, environment: { DB: 'postgres12', DB_PORT: '5432', POSTGRES_USER: 'spaceapp', POSTGRES_PWD: password, POSTGRES_SEEDS: 'postgres', DEFAULT_NAMESPACE: 'spaceapp-dev', DYNAMIC_CONFIG_FILE_PATH: 'config/dynamicconfig/docker.yaml' }, entrypoint: ['/bin/sh', '-ec'], command: ['exec /etc/temporal/entrypoint.sh autosetup'], ports: [`127.0.0.1:${owner.ports.temporal}:7233`], healthcheck: { test: ['CMD-SHELL', 'temporal operator cluster health --address 127.0.0.1:7233 >/dev/null && temporal operator namespace describe --namespace spaceapp-dev --address 127.0.0.1:7233 >/dev/null'], interval: '3s', timeout: '10s', retries: 90 } }
    },
    volumes: { postgres: { labels } }, networks: { default: { labels } }
  };
}
export async function secrets(config) {
  const read = async name => { const file = join(config.state, 'secrets', name); const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Secret must be a regular owned-state file.'); return readFile(file, 'utf8'); };
  return { password: await read('postgres-password'), session: await read('session-secret'), token: await read('setup-token').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }) };
}
export function serviceEnvironment(config, owner, secret, inherited = {}) {
  const p = path => join(config.state, path);
  const env = {
    PATH: inherited.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NODE_ENV: 'development',
    HOME: p('home'), TMPDIR: p('tmp'), XDG_CONFIG_HOME: p('home/config'), XDG_DATA_HOME: p('home/data'), XDG_CACHE_HOME: p('home/cache'), XDG_STATE_HOME: p('home/state'),
    npm_config_cache: p('npm-cache'), ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    SPACE_DEV_STACK: 'true', SPACE_INSTANCE: 'dev', SPACE_PUBLIC_DISTRIBUTION: 'true', SPACE_OPTIONAL_MODULES: 'none', SPACE_DEV_LOGIN: 'false', SPACE_SESSION_SECRET: secret.session, SPACE_SETUP_TOKEN_FILE: p('secrets/setup-token'),
    SPACE_API_HOST: '127.0.0.1', SPACE_API_PORT: String(owner.ports.api), SPACE_API_ORIGIN: `http://127.0.0.1:${owner.ports.api}`, SPACE_WEB_HOST: '127.0.0.1', SPACE_WEB_PORT: String(owner.ports.web), SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: `http://127.0.0.1:${owner.ports.web}`,
    SPACE_RUNTIME_STORE: 'postgres', SPACE_DATABASE_URL: `postgres://spaceapp:${encodeURIComponent(secret.password)}@127.0.0.1:${owner.ports.postgres}/spaceapp_dev`, SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${owner.ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: 'spaceapp-dev', SPACE_TEMPORAL_TASK_QUEUE: `spaceapp-dev-${owner.nonce.slice(0, 16)}`, SPACEAPP_WORKFLOWS_ENABLED: 'true', SPACE_CLI_ENABLED: 'true',
    SPACE_CLI_HOST_SOCKET: p('run/cli.sock'), SPACE_CLI_ADMIN_HOST_SOCKET: p('run/disabled-admin.sock'), SPACE_CLI_COMMAND_PATH: p('cli/bin'), SPACE_CLI_WORKSPACE_ROOT: p('workspaces'), SPACE_CLI_ROOT_ENABLED: 'false',
    SPACE_INSTALL_ROOT: p('install'), SPACE_ARTIFACT_ROOT: p('artifacts'), SPACE_MEMORY_ROOT: p('memory'), SPACE_MEMORY_GRAPH_ROOT: p('memory-graph'), SPACE_STARTER_MEMORY_ROOT: join(config.root, 'starter-memory'),
    SPACE_GEMINI_MEMORY_INDEX_PATH: p('memory/gemini_history.md'), SPACE_GEMINI_MEMORY_MONTHLY_PATH: p('memory/gemini_history_monthly.md'), SPACE_GEMINI_MEMORY_LOCK_PATH: p('memory/.memory.lock'),
    SPACE_CODEX_HOME: p('providers/codex'), SPACE_CODEX_APP_SERVER_HOME: p('providers/codex'), SPACE_CODEX_GOALS_DB_PATH: p('providers/codex/goals.sqlite'), SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: p('providers/codex/modes.json'),
    SPACE_APP_DIAGNOSTICS_ROOT: p('diagnostics'), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: p('maintenance/state.json'), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: p('accounts/state.json'), SPACE_TELEGRAM_SECRET_ROOT: p('telegram'), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: p('telegram/ownership.json'), SPACE_STREAMING_SECRET_ROOT: p('streaming'),
    SPACE_PROJECTS_ROOT: p('projects'), SPACE_DEMO_PROJECTS_ROOT: p('demos'), SPACE_DEMO_PROJECTS_VAR_ROOT: p('demo-state'), SPACE_DOT_WORKSPACE_ROOT: p('workspaces'), SPACE_T3CODE_SOCKET: p('run/disabled-t3.sock'), SPACE_BROWSER_HOST_SOCKET: p('run/disabled-browser.sock'), SPACE_CHESS_MOVE_SOCKET: 'disabled',
    SPACE_BROWSER_SESSIONS_ENABLED: 'false', SPACE_BROWSER_EVIDENCE_ENABLED: 'false', SPACE_T3CODE_ENABLED: 'false', SPACE_FILES_HOST_MODE: 'disabled', SPACE_DEMO_PROJECTS_ENABLED: 'false', SPACE_DOT_TOOL_GATEWAY: 'disabled', SPACE_AGENT_TOOLS_WRITER: 'disabled',
    SPACE_ENABLE_CODEX_TURNS: 'false', SPACE_ENABLE_DUMMY_TURNS: 'false', SPACE_CODEX_APP_SERVER_ENABLED: 'false', SPACE_ENABLE_CLI_CHAT_TURNS: 'false', SPACE_ROOM_AGENT_AUTOPILOT_ENABLED: 'false', SPACE_ROOM_AGENT_MONITOR_ENABLED: 'false',
    SPACE_CLI_OPENCODE_CREDENTIAL_SMOKE: 'false',
    SPACE_TELEGRAM_WORKER_ENABLED: 'false', SPACE_STREAMING_BOT_ENABLED: 'false', SPACE_MEMORY_MAINTENANCE_ENABLED: 'false', SPACE_MEMORY_MUTATIONS_ENABLED: 'false', SPACE_TELEMETRY_ENABLED: 'false'
  };
  // No inherited SPACE_*, provider keys, SSH agents, npm tokens or owner profiles.
  return env;
}
export function relativeInside(root, file) { const rel = relative(root, file); return rel && !isAbsolute(rel) && !rel.startsWith('..'); }
