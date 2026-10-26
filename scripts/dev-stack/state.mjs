// 龙娘 · 2026-10-26: isolate contributor configuration and owned development state (SpaceApp #65).
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const PORT_DEFAULTS = { api: 14910, web: 14911, postgres: 15432, temporal: 17233 };
const DIRECTORIES = ['secrets', 'logs', 'providers', 'providers/opencode', 'workspaces', 'memory', 'memory-graph', 'artifacts', 'bin', 'vendor'];

async function statOrNull(file) {
  try { return await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function pinnedImage(compose, service) {
  const block = compose.match(new RegExp(`^  ${service}:\\s*\\r?\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^\\S|$(?![\\s\\S]))`, 'm'))?.[1];
  const image = block?.match(/^    image:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(`Missing digest-pinned ${service} image in installer compose template`);
  }
  return image;
}

export async function loadConfig(repoRoot, env = {}) {
  repoRoot = await realpath(repoRoot);
  const ports = {};
  for (const [name, fallback] of Object.entries(PORT_DEFAULTS)) {
    const value = env[`SPACE_DEV_${name.toUpperCase()}_PORT`] ?? fallback;
    if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1024 || Number(value) > 65535 || [4910, 4911].includes(Number(value))) {
      throw new Error(`Invalid development port for ${name}; choose an integer 1024..65535 excluding 4910/4911`);
    }
    ports[name] = Number(value);
  }
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error('Development ports must be distinct');
  const stateDir = path.join(repoRoot, '.dev-stack');
  const cliSocket = path.join(stateDir, 'cli.sock');
  const controlSocket = path.join(stateDir, 'control.sock');
  if ([cliSocket, controlSocket].some(socket => Buffer.byteLength(socket) >= 100)) throw new Error('Development socket path must be shorter than 100 bytes; use a shorter checkout path');
  const [compose, dockerfile] = await Promise.all([
    readFile(path.join(repoRoot, 'packages/run-spaceapp/templates/compose.yml'), 'utf8'),
    readFile(path.join(repoRoot, 'Dockerfile'), 'utf8'),
  ]);
  const packages = [...new Set([...dockerfile.replace(/^\s*#.*$/gm, '').matchAll(/(?:^|[\s"'])(@opencode\/cli|opencode-ai)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[\s"'\\]|$)/g)].map(match => `${match[1]}@${match[2]}`))];
  if (packages.length !== 1) throw new Error('Dockerfile must identify one exact OpenCode package version');
  return {
    repoRoot, stateDir,
    projectName: `spaceapp-dev-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)}`,
    ports, images: { postgres: pinnedImage(compose, 'postgres'), temporal: pinnedImage(compose, 'temporal') },
    openCodePackage: packages[0], cliSocket, controlSocket,
  };
}

function manifestFor(config) {
  return { format: 'spaceapp-dev-stack', version: 1, repoRoot: config.repoRoot, projectName: config.projectName, ports: config.ports };
}

async function checkRoot(config, optional = false) {
  if (await realpath(config.repoRoot) !== config.repoRoot || config.stateDir !== path.join(config.repoRoot, '.dev-stack')) throw new Error('State must belong to the canonical checkout');
  const stat = await statOrNull(config.stateDir);
  if (!stat && optional) return false;
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Development state must be a real directory, never a symlink');
  return true;
}

async function readRegular(file) {
  const stat = await statOrNull(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`Expected an unlinked regular state file: ${path.basename(file)}`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

async function checkManifest(config) {
  let manifest;
  try { manifest = JSON.parse(await readRegular(path.join(config.stateDir, 'manifest.json'))); } catch {
    throw new Error('Refusing development state without a valid ownership manifest');
  }
  const expected = manifestFor(config);
  if (manifest.format !== expected.format || manifest.version !== expected.version || manifest.repoRoot !== expected.repoRoot || manifest.projectName !== expected.projectName || !manifest.ports || Object.keys(manifest.ports).length !== 4 || Object.entries(expected.ports).some(([key, value]) => manifest.ports[key] !== value)) {
    throw new Error('Development state manifest does not match this checkout and configuration');
  }
}

async function checkDirectories(config) {
  for (const relative of DIRECTORIES) {
    const stat = await statOrNull(path.join(config.stateDir, relative));
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Refusing unsafe state directory: ${relative}`);
  }
  for (const name of ['postgres-password', 'session-secret', 'setup-token']) {
    const stat = await statOrNull(path.join(config.stateDir, 'secrets', name));
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)) throw new Error(`Expected an unlinked regular state file: ${name}`);
  }
}

export async function assertOwnedState(config) {
  await checkRoot(config);
  await checkManifest(config);
  await checkDirectories(config);
}

async function writeExclusive(file, value) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value); } finally { await handle.close(); }
}

export async function prepareState(config) {
  if (await checkRoot(config, true)) {
    if ((await readdir(config.stateDir)).length) await assertOwnedState(config);
  } else {
    await mkdir(config.stateDir, { mode: 0o700 });
  }
  const manifestPath = path.join(config.stateDir, 'manifest.json');
  if (!await statOrNull(manifestPath)) {
    await writeExclusive(manifestPath, `${JSON.stringify(manifestFor(config), null, 2)}\n`);
  }
  await assertOwnedState(config);
  await chmod(config.stateDir, 0o700);
  await chmod(manifestPath, 0o600);
  for (const relative of DIRECTORIES) {
    const directory = path.join(config.stateDir, relative);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const secrets = {};
  for (const [key, name] of Object.entries({ databasePassword: 'postgres-password', sessionSecret: 'session-secret', setupToken: 'setup-token' })) {
    const file = path.join(config.stateDir, 'secrets', name);
    if (!await statOrNull(file)) {
      try { await writeExclusive(file, randomBytes(32).toString('hex')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const value = await readRegular(file);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid generated development secret: ${name}`);
    await chmod(file, 0o600);
    secrets[key] = value;
  }
  return secrets;
}
