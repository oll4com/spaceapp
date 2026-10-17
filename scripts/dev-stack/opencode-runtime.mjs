import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const invokeVersion = async (file, args, options) => (await execute(file, args, { ...options, encoding: 'utf8', maxBuffer: 4096, killSignal: 'SIGKILL' })).stdout;

// The pinned npm package's public bin is a postinstall placeholder. We never run
// its postinstall/network fallback: select the already-installed native package.
export function nativePackage(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported pinned OpenCode platform.');
  return `opencode-${platform}-${arch}${arch === 'x64' ? '-baseline' : ''}`;
}
export async function confinedFile(root, file) {
  const absolute = resolve(root), target = resolve(file), rel = relative(absolute, target);
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || await realpath(absolute) !== absolute) throw new Error('Native path must stay inside its physical private root.');
  let current = absolute;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || await realpath(current) !== current) throw new Error('Refusing a linked native package path.');
    if (current === target ? !info.isFile() : !info.isDirectory()) throw new Error('Invalid native package path type.');
  }
  return target;
}
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
export function opencodeEnvironment(state, inherited = {}) {
  const home = join(state, 'providers', 'opencode');
  return { PATH: inherited.PATH || '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', HOME: home, TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_SHARE: 'true' };
}
export async function resolveOpenCode(state, version, { platform = process.platform, arch = process.arch } = {}) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const modules = join(state, 'cli', 'vendor', 'opencode', 'node_modules');
  const coreFile = await confinedFile(state, join(modules, 'opencode-ai', 'package.json'));
  const core = JSON.parse(await readFile(coreFile, 'utf8')), name = nativePackage(platform, arch);
  if (core.name !== 'opencode-ai' || core.version !== version || core.optionalDependencies?.[name] !== version) throw new Error('Pinned OpenCode core/native dependency mismatch.');
  const packageFile = await confinedFile(state, join(modules, name, 'package.json'));
  const selected = JSON.parse(await readFile(packageFile, 'utf8'));
  if (selected.name !== name || selected.version !== version) throw new Error('Pinned OpenCode native package mismatch.');
  const executable = await confinedFile(state, join(dirname(packageFile), 'bin', 'opencode'));
  await access(executable, constants.X_OK);
  return { executable, version, package: name, relativeExecutable: relative(state, executable), sha256: await fileHash(executable) };
}
export async function verifyOpenCode(state, version, { invoke = invokeVersion, inherited, observe = async () => {}, ...selection } = {}) {
  const observation = { expectedVersion: version, actualVersion: null, stage: 'resolve-native', ok: false };
  try {
    const native = await resolveOpenCode(state, version, selection), env = opencodeEnvironment(state, inherited);
    observation.native = { version: native.version, package: native.package, relativeExecutable: native.relativeExecutable, sha256: native.sha256 };
    for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) await mkdir(path, { recursive: true, mode: 0o700 });
    observation.stage = 'actual-native-version';
    const actual = (await invoke(native.executable, ['--version'], { cwd: env.HOME, env, timeout: 15000 })).trim();
    observation.actualVersion = /^\d+\.\d+\.\d+$/.test(actual) ? actual : '[unexpected version output]';
    if (actual !== version) throw Object.assign(new Error('Actual private OpenCode executable version differs from its canonical pin.'), { code: 'VERSION_MISMATCH' });
    observation.ok = true; return native;
  } catch (error) {
    observation.error = { name: error.name, code: error.code ?? null, signal: error.signal ?? null, killed: error.killed === true }; throw error;
  } finally { await observe(observation); }
}
