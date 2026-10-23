// Container smoke for one target image on the host's architecture.
//
// Every image the matrix builds must start and answer as it would under the launcher:
//   core:    pgvector and Temporal from the launcher's compose template, migrations through the
//            entrypoint, /readyz ok with database and worker RUNNING, the image's HEALTHCHECK healthy.
//   cli:     CliHostClient ping over the host socket and the OpenCode version the Dockerfile pins.
//   browser: migrations from the image, BrowserHostClient health over the browser socket and one
//            headless Chromium launch as uid 10001.
//
// The companion images, their environment and the secrets layout come from
// packages/run-spaceapp/templates/compose.yml, so the smoke follows the launcher's pins. Node
// built-ins only. Every check is mandatory: there is no switch that turns one off.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const TEMPLATE = 'packages/run-spaceapp/templates/compose.yml';
export const TARGETS = ['core', 'browser', 'cli'];
export const ARCHES = ['amd64', 'arm64'];
export const APP_UID = 10001;

// The lines a pass prints; CI and the review read them.
export const MARKERS = {
  pass: 'container-smoke: PASS target=',
  fail: 'container-smoke: FAIL target=',
  database: 'database=RUNNING',
  worker: 'worker=RUNNING',
  health: 'health=healthy',
  migrations: 'migrations=applied',
  browserHealth: 'browser-health=ok',
  ping: 'ping=ok',
  chromium: 'chromium=launched',
};

// What each target must show before its pass line is printed.
export const CHECKS = {
  core: [MARKERS.database, MARKERS.worker, MARKERS.health],
  cli: [MARKERS.ping, 'opencode=<pinned version>'],
  browser: [MARKERS.migrations, MARKERS.browserHealth, MARKERS.chromium],
};

// Seconds each wait may take. The core image's HEALTHCHECK has a 45 s start period and a 15 s
// interval, so the health wait covers the first probe after readiness.
export const DEADLINES = { postgres: 120, temporal: 300, ready: 600, health: 120, socket: 180 };

const SOCKETS = {
  cli: '/run/spaceapp-cli/host.sock',
  browser: '/run/spaceapp-browser/browser-host.sock',
};

class SmokeError extends Error {}

/**
 * The OpenCode version the cli image installs (`npm install --global ... @opencode/cli@<version>`).
 * @param {string} [root] repository root holding the Dockerfile
 * @returns {string} the pinned x.y.z
 */
export function opencodePin(root = REPO_ROOT) {
  const m = readFileSync(join(root, 'Dockerfile'), 'utf8').match(/@opencode\/cli@(\d+\.\d+\.\d+)/);
  if (!m) throw new Error('Dockerfile pins no @opencode/cli version');
  return m[1];
}

/**
 * One service of the launcher's compose template: its image reference and its environment block.
 * @param {string} service the compose service name
 * @param {string} [root] repository root holding the template
 * @returns {{ image: string, environment: [string, string][] }}
 */
export function templateService(service, root = REPO_ROOT) {
  const lines = readFileSync(join(root, TEMPLATE), 'utf8').split('\n');
  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) throw new Error(`${TEMPLATE} has no service ${service}`);
  const block = [];
  for (let i = start + 1; i < lines.length && /^(\s{4,}|\s*$)/.test(lines[i]); i++) block.push(lines[i]);
  const image = block.find((l) => /^\s{4}image:/.test(l))?.replace(/^\s{4}image:\s*/, '').trim();
  if (!image) throw new Error(`${TEMPLATE}: service ${service} names no image`);
  const environment = [];
  const envAt = block.findIndex((l) => l === '    environment:');
  for (let i = envAt + 1; envAt !== -1 && i < block.length && /^\s{6}\S/.test(block[i]); i++) {
    const m = block[i].match(/^\s{6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) throw new Error(`${TEMPLATE}: unreadable environment line "${block[i].trim()}" in ${service}`);
    environment.push([m[1], m[2].replace(/^"(.*)"$/, '$1')]);
  }
  return { image, environment };
}

/**
 * Fills the launcher's `${NAME}` and `${NAME:-default}` placeholders from the smoke's own inputs.
 * A placeholder the smoke does not set is an error: the launcher would start the service without it.
 * @param {string} value a template value
 * @param {Record<string, string>} inputs the values the smoke provides
 * @returns {string}
 */
export function expand(value, inputs) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (whole, name, withDefault, fallback) => {
    if (Object.hasOwn(inputs, name)) return inputs[name];
    if (withDefault !== undefined) return fallback;
    throw new Error(`${TEMPLATE} placeholder ${whole} has no value in the smoke`);
  });
}

/**
 * The `-e KEY=value` arguments for one template service, expanded, with overrides applied last.
 * @param {string} service
 * @param {Record<string, string>} inputs
 * @param {Record<string, string>} [overrides]
 * @returns {string[]}
 */
function serviceEnv(service, inputs, overrides = {}) {
  const env = Object.fromEntries(templateService(service).environment.map(([k, v]) => [k, expand(v, inputs)]));
  return Object.entries({ ...env, ...overrides }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

/**
 * Runs a command to completion and returns its exit code and trimmed output.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ code: number, out: string, err: string }}
 */
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
};
/** Runs `docker` with the given arguments. @param {...string} args @returns {{ code: number, out: string, err: string }} */
const docker = (...args) => run('docker', args);
/** Blocks the thread for `ms` milliseconds. @param {number} ms */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs a docker command that has to succeed; a failure ends the smoke with `what` in the reason.
 * @param {string[]} args docker arguments
 * @param {string} what the step, for the error
 * @returns {{ code: number, out: string, err: string }}
 */
function must(args, what) {
  const r = docker(...args);
  if (r.code !== 0) throw new SmokeError(`${what}: ${r.err || r.out}`);
  return r;
}

/** A probe answer that ends the wait with `value`. @param {*} value */
const done = (value) => ({ done: true, value });
/** A probe answer that keeps waiting; `note` is kept for the timeout error. @param {string} note */
const wait = (note) => ({ done: false, note: typeof note === 'string' ? note : '' });
/**
 * Polls `probe` every three seconds until it answers done(value), for at most `seconds`; a wait(note)
 * answer keeps the note for the error.
 * @param {string} what the condition, for the error
 * @param {number} seconds the deadline
 * @param {() => { done: boolean, value?: *, note?: string }} probe
 * @returns {*} the value the probe answered
 */
function waitFor(what, seconds, probe) {
  const until = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < until) {
    const got = probe();
    if (got.done) return got.value;
    last = got.note || last;
    sleep(3000);
  }
  throw new SmokeError(`${what} did not happen within ${seconds} s${last ? ` (last: ${last.slice(0, 300)})` : ''}`);
}

/**
 * Parses JSON, answering null instead of throwing.
 * @param {string} text
 * @returns {*}
 */
function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// The node snippets the checks run inside the containers, through the images' own clients.
const READYZ = "fetch('http://127.0.0.1:4911/readyz').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))";
const PING = "const m=await import('/app/packages/cli-host/dist/client.js');const c=new m.CliHostClient({socketPath:'" + SOCKETS.cli + "'});const r=await c.ping();process.stdout.write(JSON.stringify(r));await c.close();";
const BROWSER_HEALTH = "const m=await import('/app/packages/browser-host/dist/client.js');const c=new m.BrowserHostClient({socketPath:'" + SOCKETS.browser + "'});const h=await c.health();process.stdout.write(JSON.stringify(h));await c.close();";

/**
 * The containers one smoke needs: a private network, the launcher's secrets as a bind mount, the
 * companion services the template names, and the image under test, all removed by destroy().
 */
class Stack {
  /**
   * @param {string} target core, browser or cli
   * @param {string} arch amd64 or arm64
   * @param {string} image the image under test
   */
  constructor(target, arch, image) {
    this.target = target;
    this.arch = arch;
    this.image = image;
    this.prefix = `container-smoke-${target}-${process.pid}`;
    this.net = `${this.prefix}-net`;
    this.containers = [];
    this.dir = mkdtempSync(join(tmpdir(), 'container-smoke-'));
    // The launcher mounts these as compose secrets; here they are a read-only bind mount that the
    // postgres and temporal users must be able to traverse.
    this.secrets = join(this.dir, 'secrets');
    mkdirSync(this.secrets, { mode: 0o755 });
    mkdirSync(join(this.dir, 'backups'));
    this.password = randomBytes(16).toString('hex');
    this.databaseUrl = `postgres://spaceapp:${this.password}@postgres:5432/spaceapp`;
    for (const [name, value] of [
      ['postgres-password', this.password],
      ['database-url', this.databaseUrl],
      ['session-secret', randomBytes(32).toString('hex')],
      ['setup-token', randomBytes(24).toString('hex')],
    ]) writeFileSync(join(this.secrets, name), `${value}\n`, { mode: 0o644 });
    this.inputs = {
      SPACEAPP_IMAGE_TAG: 'smoke',
      SPACEAPP_TELEMETRY: 'false',
      SPACEAPP_WORKFLOWS_ENABLED: 'true',
      SPACEAPP_BROWSER_ENABLED: 'false',
    };
    must(['network', 'create', this.net], 'create the smoke network');
  }

  /** The container name for a role of this stack. @param {string} role @returns {string} */
  name(role) { return `${this.prefix}-${role}`; }

  /**
   * Starts one container on the smoke network under the launcher's service name.
   * @param {string} role the stack role (postgres, temporal, app)
   * @param {string} alias the network alias the other services expect
   * @param {string[]} args the rest of the `docker run` arguments, image last
   * @returns {string} the container name
   */
  start(role, alias, args) {
    const name = this.name(role);
    this.containers.push(name);
    must(['run', '-d', '--name', name, '--network', this.net, '--network-alias', alias,
      '-v', `${this.secrets}:/run/secrets:ro`, ...args], `start ${alias}`);
    return name;
  }

  /**
   * Runs a command in one of the stack's containers, as root unless `user` is given.
   * @param {string} role
   * @param {string[]} args
   * @param {string} [user]
   * @returns {{ code: number, out: string, err: string }}
   */
  exec(role, args, user) { return docker('exec', ...(user ? ['-u', user] : []), this.name(role), ...args); }

  /**
   * Runs one of the template's health check commands in a container until it passes.
   * @param {string} role
   * @param {string} what the condition, for the error
   * @param {number} seconds the deadline
   * @param {string[]} command
   */
  healthy(role, what, seconds, command) {
    waitFor(what, seconds, () => {
      const r = this.exec(role, command);
      return r.code === 0 ? done(true) : wait(r.err || r.out);
    });
  }

  /** Starts the template's pgvector PostgreSQL and waits for it to accept connections. */
  postgres() {
    const { image } = templateService('postgres');
    this.start('postgres', 'postgres', [...serviceEnv('postgres', this.inputs), image]);
    this.healthy('postgres', 'postgres ready', DEADLINES.postgres, ['pg_isready', '-U', 'spaceapp', '-d', 'spaceapp']);
  }

  /** Starts the template's Temporal auto-setup against postgres and waits for its namespace. */
  temporal() {
    const { image } = templateService('temporal');
    // The template's command: the password comes from the secret, then auto-setup takes over.
    this.start('temporal', 'temporal', [...serviceEnv('temporal', this.inputs), '--entrypoint', '/bin/sh', image, '-ec',
      'export POSTGRES_PWD="$(cat /run/secrets/postgres-password)"; exec /etc/temporal/entrypoint.sh autosetup']);
    this.healthy('temporal', 'temporal ready', DEADLINES.temporal, ['sh', '-c',
      'temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null']);
  }

  /**
   * Starts the image under test the way the launcher runs it.
   * @param {string} service the compose service name, used as the network alias
   * @param {string[]} envArgs the `-e KEY=value` arguments
   * @param {string[]} [extra] further `docker run` arguments
   * @returns {string} the container name
   */
  app(service, envArgs, extra = []) {
    return this.start('app', service, ['--init', '--security-opt', 'no-new-privileges:true', ...extra, ...envArgs, this.image]);
  }

  /** The last 150 log lines of every container of the stack. @returns {string} */
  logs() {
    return this.containers.map((c) => {
      const r = docker('logs', '--tail', '150', c);
      return `--- ${c}\n${r.out}\n${r.err}`;
    }).join('\n');
  }

  /** Removes the containers, the network and the temporary directory. */
  destroy() {
    for (const c of this.containers) docker('rm', '-f', c);
    docker('network', 'rm', this.net);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * The core check: postgres and Temporal from the template, then the image until /readyz answers ok
 * with the database, the worker and session revocations RUNNING and Docker's HEALTHCHECK is healthy.
 * @param {Stack} stack
 * @returns {string[]} the markers the line reports
 */
function smokeCore(stack) {
  stack.postgres();
  stack.temporal();
  // The core cell holds the core image only: with no cli container to serve the host socket,
  // readyz reports cliHost=disabled instead of probing it. Browser sessions are off the same way
  // through the launcher's own SPACEAPP_BROWSER_ENABLED input.
  stack.app('spaceapp-core', serviceEnv('spaceapp-core', stack.inputs, { SPACE_CLI_ENABLED: 'false' }),
    ['-v', `${join(stack.dir, 'backups')}:/backups`]);
  const ready = waitFor('core /readyz ok with the worker RUNNING', DEADLINES.ready, () => {
    const r = stack.exec('app', ['node', '-e', READYZ]);
    const body = r.code === 0 ? parseJson(r.out) : null;
    if (body?.ok === true && body.dependencies?.worker === 'RUNNING') return done(body);
    return wait(body ? JSON.stringify(body.dependencies ?? body) : r.err);
  });
  const deps = ready.dependencies ?? {};
  for (const key of ['database', 'worker', 'sessionRevocations']) {
    if (deps[key] !== 'RUNNING') {
      throw new SmokeError(`readyz ${key}=${deps[key]}, want RUNNING; readyz answered ${JSON.stringify(ready).slice(0, 600)}`);
    }
  }
  waitFor('core HEALTHCHECK healthy', DEADLINES.health, () => {
    const r = docker('inspect', '--format', '{{.State.Health.Status}}', stack.name('app'));
    return r.out === 'healthy' ? done(r.out) : wait(r.out || r.err);
  });
  return [MARKERS.database, MARKERS.worker, MARKERS.health];
}

/**
 * The cli check: the image until the CLI host answers a ping over its socket, then `opencode --version`
 * against the Dockerfile pin.
 * @param {Stack} stack
 * @returns {string[]} the markers the line reports
 */
function smokeCli(stack) {
  stack.app('spaceapp-cli', serviceEnv('spaceapp-cli', stack.inputs));
  waitFor('CliHostClient ping over the host socket', DEADLINES.socket, () => {
    const r = stack.exec('app', ['node', '--input-type=module', '-e', PING], 'spaceapp');
    const body = r.code === 0 ? parseJson(r.out) : null;
    return body?.ok === true ? done(body) : wait(r.err || r.out);
  });
  const pin = opencodePin();
  const version = stack.exec('app', ['opencode', '--version'], 'spaceapp');
  const reported = version.out.trim().split('\n')[0].match(/\d+\.\d+\.\d+/)?.[0];
  if (version.code !== 0 || reported !== pin) {
    throw new SmokeError(`opencode --version gave "${version.out || version.err}", the Dockerfile pins ${pin}`);
  }
  return [MARKERS.ping, `opencode=${reported}`];
}

/**
 * The browser check: postgres, the migrations from the image, then the image until the browser host
 * reports healthy, and one headless Chromium launch as the service user.
 * @param {Stack} stack
 * @returns {string[]} the markers the line reports
 */
function smokeBrowser(stack) {
  stack.postgres();
  // The launcher's core service migrates the database before the browser host first needs it.
  // The browser image carries packages/db and its migrations, so the smoke migrates from it.
  const migrate = docker('run', '--rm', '--network', stack.net, '-u', String(APP_UID), '--entrypoint', 'node',
    '-e', `SPACE_DATABASE_URL=${stack.databaseUrl}`, stack.image, 'packages/db/dist/migrate.js');
  if (migrate.code !== 0) throw new SmokeError(`migrations from the browser image: ${migrate.err || migrate.out}`);
  stack.app('spaceapp-browser', serviceEnv('spaceapp-browser', stack.inputs));
  const health = waitFor('BrowserHostClient health over the browser socket', DEADLINES.socket, () => {
    const r = stack.exec('app', ['node', '--input-type=module', '-e', BROWSER_HEALTH], 'spaceapp');
    const body = r.code === 0 ? parseJson(r.out) : null;
    return typeof body?.hostPid === 'number' ? done(body) : wait(r.err || r.out);
  });
  if (health.status?.enabled !== true) throw new SmokeError(`browser host reports ${JSON.stringify(health.status)}`);
  const uid = stack.exec('app', ['id', '-u'], String(APP_UID));
  if (uid.out !== String(APP_UID)) throw new SmokeError(`exec as uid ${APP_UID} reported "${uid.out || uid.err}"`);
  const chromium = stack.exec('app', ['chromium', '--headless=new', '--no-sandbox', '--disable-gpu',
    '--dump-dom', 'data:text/html,<title>container-smoke</title><p>chromium-ok</p>'], String(APP_UID));
  if (chromium.code !== 0 || !chromium.out.includes('chromium-ok')) {
    throw new SmokeError(`headless Chromium as uid ${APP_UID} exited ${chromium.code}: ${chromium.err.slice(-400)}`);
  }
  return [MARKERS.migrations, MARKERS.browserHealth, MARKERS.chromium];
}

export const SMOKES = { core: smokeCore, browser: smokeBrowser, cli: smokeCli };

/**
 * Runs the smoke for one image: the platform check, the stack, the target's check, the clean-up.
 * The container logs of a failed run go to stderr.
 * @param {{ target: string, arch: string, image: string }} options
 * @returns {{ ok: boolean, line: string }} whether it passed and the line to print
 */
export function smoke({ target, arch, image }) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}`);
  if (!ARCHES.includes(arch)) throw new Error(`unknown arch ${arch}`);
  let stack = null;
  try {
    const platform = docker('image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image);
    if (platform.code !== 0) throw new SmokeError(`image ${image}: ${platform.err}`);
    if (platform.out !== `linux/${arch}`) throw new SmokeError(`image ${image} is ${platform.out}, the cell builds linux/${arch}`);
    stack = new Stack(target, arch, image);
    const checks = SMOKES[target](stack);
    return { ok: true, line: `${MARKERS.pass}${target} arch=${arch} image=${image} ${checks.join(' ')}` };
  } catch (error) {
    if (!(error instanceof SmokeError)) throw error;
    if (stack) process.stderr.write(`${stack.logs()}\n`);
    return { ok: false, line: `${MARKERS.fail}${target} arch=${arch} image=${image} reason=${error.message}` };
  } finally {
    stack?.destroy();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const target = arg('--target');
  const arch = arg('--arch');
  if (!TARGETS.includes(target) || !ARCHES.includes(arch)) {
    console.error('usage: container-smoke.mjs --target <core|browser|cli> --arch <amd64|arm64> [--image <ref>]');
    process.exit(2);
  }
  const result = smoke({ target, arch, image: arg('--image') ?? `spaceapp-ci:${target}-${arch}` });
  console.log(result.line);
  process.exit(result.ok ? 0 : 1);
}
